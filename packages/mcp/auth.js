import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Secret from 'gi://Secret?version=1';
import Soup from 'gi://Soup?version=3.0';

const DEFAULT_AUTH_TIMEOUT_SECONDS = 300;
const DEFAULT_HTTP_TIMEOUT_SECONDS = 30;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MCP_AUTH_TOKEN_SCHEMA = new Secret.Schema(
    'io.github.stonega.Cusco.McpAuthToken',
    Secret.SchemaFlags.NONE,
    {
        server: Secret.SchemaAttributeType.STRING,
    },
);

function createUserVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

function encodeText(text) {
    return new GLib.Bytes(new TextEncoder().encode(String(text ?? '')));
}

function encodeJsonBody(body) {
    return encodeText(JSON.stringify(body));
}

function sendAndRead(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
            try {
                resolve(session.send_and_read_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function isLoopbackHost(host) {
    return host === 'localhost'
        || host === '::1'
        || host === '127.0.0.1'
        || host?.startsWith('127.');
}

function shouldBypassProxy(url) {
    try {
        return isLoopbackHost(GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host());
    } catch (_error) {
        return false;
    }
}

function createHttpSession(url, timeoutSeconds) {
    const options = { timeout: Math.max(1, Math.round(timeoutSeconds ?? DEFAULT_HTTP_TIMEOUT_SECONDS)) };

    if (shouldBypassProxy(url))
        options.proxy_resolver = new Gio.SimpleProxyResolver({ default_proxy: null });

    return new Soup.Session(options);
}

function responseTextFromBytes(bytes) {
    return new TextDecoder().decode(bytes.get_data()).trim();
}

function parseJsonResponse(text, url) {
    try {
        return JSON.parse(text || '{}');
    } catch (_error) {
        throw createUserVisibleError(`Authorization endpoint returned non-JSON data: ${url}`);
    }
}

async function fetchJson(url, options = {}) {
    const session = createHttpSession(url, options.timeoutSeconds);
    const message = Soup.Message.new('GET', url);
    message.request_headers.append('Accept', 'application/json');

    let bytes;

    try {
        bytes = await sendAndRead(session, message, options.cancellable ?? null);
    } finally {
        session.abort();
    }
    const status = message.get_status();
    const text = responseTextFromBytes(bytes);

    if (status < 200 || status >= 300)
        throw createUserVisibleError(`Authorization discovery failed (${status}): ${url}`);

    return parseJsonResponse(text, url);
}

async function postJson(url, body, options = {}) {
    const session = createHttpSession(url, options.timeoutSeconds);
    const message = Soup.Message.new('POST', url);
    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('Content-Type', 'application/json');
    message.set_request_body_from_bytes('application/json', encodeJsonBody(body));

    let bytes;

    try {
        bytes = await sendAndRead(session, message, options.cancellable ?? null);
    } finally {
        session.abort();
    }
    const status = message.get_status();
    const text = responseTextFromBytes(bytes);

    if (status < 200 || status >= 300) {
        const error = createUserVisibleError(
            `Authorization registration failed (${status}): ${text || url}`,
            `The authorization server rejected Cusco's client registration (HTTP ${status}). The server may require an approved or pre-registered MCP client.`,
        );
        error.httpStatus = status;
        error.mcpClientRegistrationRejected = true;
        throw error;
    }

    return parseJsonResponse(text, url);
}

async function postForm(url, params, options = {}) {
    const session = createHttpSession(url, options.timeoutSeconds);
    const message = Soup.Message.new('POST', url);
    const authentication = options.clientAuthentication ?? {};
    const bodyParams = { ...params };

    if (authentication.method === 'client_secret_post')
        bodyParams.client_secret = authentication.clientSecret;

    const body = formEncode(bodyParams);
    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');

    if (authentication.method === 'client_secret_basic') {
        const credentials = `${escapeUrlPart(authentication.clientId)}:${escapeUrlPart(authentication.clientSecret)}`;
        const encoded = GLib.base64_encode(new TextEncoder().encode(credentials));
        message.request_headers.append('Authorization', `Basic ${encoded}`);
    }

    message.set_request_body_from_bytes('application/x-www-form-urlencoded', encodeText(body));

    let bytes;

    try {
        bytes = await sendAndRead(session, message, options.cancellable ?? null);
    } finally {
        session.abort();
    }
    const status = message.get_status();
    const text = responseTextFromBytes(bytes);

    if (status < 200 || status >= 300) {
        const error = createUserVisibleError(
            `Authorization token exchange failed (${status}): ${text || url}`,
            `The authorization server rejected the token request (HTTP ${status}).`,
        );
        error.httpStatus = status;
        throw error;
    }

    return parseJsonResponse(text, url);
}

function escapeUrlPart(value) {
    return GLib.uri_escape_string(String(value ?? ''), null, false);
}

function formEncode(params) {
    return Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
        .map(([name, value]) => `${escapeUrlPart(name)}=${escapeUrlPart(value)}`)
        .join('&');
}

function appendQuery(url, params) {
    const separator = String(url).includes('?') ? '&' : '?';
    const query = formEncode(params);
    return query ? `${url}${separator}${query}` : url;
}

function validateAuthorizationUrl(url, label) {
    let uri;

    try {
        uri = GLib.Uri.parse(String(url ?? ''), GLib.UriFlags.NONE);
    } catch (_error) {
        throw createUserVisibleError(`${label} is not a valid URL.`);
    }

    const scheme = String(uri.get_scheme() ?? '').toLowerCase();
    const host = String(uri.get_host() ?? '').toLowerCase();

    if (scheme !== 'https' && !(scheme === 'http' && isLoopbackHost(host))) {
        throw createUserVisibleError(
            `${label} must use HTTPS, except for a loopback development server.`,
        );
    }

    return String(url);
}

function uriOrigin(uri) {
    const scheme = String(uri.get_scheme() ?? '').toLowerCase();
    const host = String(uri.get_host() ?? '').toLowerCase();
    const port = uri.get_port();

    if (!scheme || !host)
        throw createUserVisibleError('MCP server URL must include a scheme and host.');

    return `${scheme}://${host}${port > 0 ? `:${port}` : ''}`;
}

function uriPath(uri) {
    const path = String(uri.get_path() ?? '/');
    return path.startsWith('/') ? path : `/${path}`;
}

function trimmedPath(uri) {
    const path = uriPath(uri).replace(/\/+$/g, '');
    return path === '' ? '' : path;
}

export function canonicalMcpResourceUri(serverUrl) {
    const uri = GLib.Uri.parse(String(serverUrl ?? ''), GLib.UriFlags.NONE);
    const path = trimmedPath(uri);
    return `${uriOrigin(uri)}${path}`;
}

function protectedResourceMetadataUrls(serverUrl) {
    const uri = GLib.Uri.parse(String(serverUrl ?? ''), GLib.UriFlags.NONE);
    const origin = uriOrigin(uri);
    const path = trimmedPath(uri);
    const rootUrl = `${origin}/.well-known/oauth-protected-resource`;

    return path ? [`${rootUrl}${path}`, rootUrl] : [rootUrl];
}

function authorizationServerMetadataUrls(issuerUrl) {
    const uri = GLib.Uri.parse(String(issuerUrl ?? ''), GLib.UriFlags.NONE);
    const origin = uriOrigin(uri);
    const path = trimmedPath(uri);

    if (!path) {
        return [
            `${origin}/.well-known/oauth-authorization-server`,
            `${origin}/.well-known/openid-configuration`,
        ];
    }

    return [
        `${origin}/.well-known/oauth-authorization-server${path}`,
        `${origin}/.well-known/openid-configuration${path}`,
        `${origin}${path}/.well-known/openid-configuration`,
    ];
}

function readAuthParam(source, startIndex) {
    let index = startIndex;
    let value = '';

    if (source[index] === '"') {
        index++;

        while (index < source.length) {
            const char = source[index++];

            if (char === '\\' && index < source.length) {
                value += source[index++];
                continue;
            }

            if (char === '"')
                break;

            value += char;
        }

        return { value, index };
    }

    while (index < source.length && source[index] !== ',')
        value += source[index++];

    return { value: value.trim(), index };
}

export function parseWwwAuthenticate(header) {
    const text = String(header ?? '').trim();
    const match = text.match(/(?:^|,\s*)Bearer(?:\s+|$)/i);

    if (!match)
        return null;

    const params = {};
    let index = match.index + match[0].length;

    while (index < text.length) {
        while (index < text.length && /[\s,]/.test(text[index]))
            index++;

        const keyStart = index;

        while (index < text.length && /[A-Za-z0-9_.-]/.test(text[index]))
            index++;

        const key = text.slice(keyStart, index).toLowerCase();

        while (index < text.length && /\s/.test(text[index]))
            index++;

        if (!key || text[index] !== '=')
            break;

        index++;

        while (index < text.length && /\s/.test(text[index]))
            index++;

        const parsed = readAuthParam(text, index);
        params[key] = parsed.value;
        index = parsed.index;
    }

    return {
        scheme: 'Bearer',
        params,
        resourceMetadataUrl: params.resource_metadata ?? '',
        authorizationUri: params.authorization_uri ?? '',
        scope: params.scope ?? '',
        error: params.error ?? '',
        errorDescription: params.error_description ?? '',
    };
}

export function createMcpAuthRequiredError(serverName, details = {}) {
    const challenge = parseWwwAuthenticate(details.wwwAuthenticate);
    const errorDescription = challenge?.errorDescription || challenge?.error || '';
    const userMessage = errorDescription
        ? `${serverName} requires MCP authorization: ${errorDescription}`
        : `${serverName} requires MCP authorization.`;
    const error = createUserVisibleError(userMessage, userMessage);

    error.mcpAuth = {
        required: true,
        status: details.status ?? 401,
        serverUrl: details.serverUrl ?? '',
        wwwAuthenticate: details.wwwAuthenticate ?? '',
        resourceMetadataUrl: challenge?.resourceMetadataUrl ?? '',
        authorizationUri: challenge?.authorizationUri ?? '',
        scope: challenge?.scope ?? '',
        error: challenge?.error ?? '',
        errorDescription,
    };

    return error;
}

export function isMcpAuthRequiredStatus(status, wwwAuthenticate) {
    const challenge = parseWwwAuthenticate(wwwAuthenticate);

    if (!challenge)
        return false;

    if (status === 401)
        return true;

    return status === 403 && challenge.error === 'insufficient_scope';
}

async function firstJson(urls, options = {}) {
    let lastError = null;

    for (const url of urls) {
        try {
            return {
                url,
                json: await fetchJson(url, options),
            };
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? createUserVisibleError('Authorization discovery failed.');
}

async function discoverProtectedResourceMetadata(server, auth = {}, options = {}) {
    const urls = [
        auth.resourceMetadataUrl,
        ...protectedResourceMetadataUrls(server.url),
    ].filter(Boolean).map((url) => validateAuthorizationUrl(
        url,
        'Protected resource metadata URL',
    ));
    const discovered = await firstJson([...new Set(urls)], options);

    return {
        url: discovered.url,
        metadata: discovered.json,
    };
}

async function discoverAuthorizationServerMetadata(issuerUrl, options = {}) {
    const normalizedIssuer = validateAuthorizationUrl(issuerUrl, 'Authorization server URL');
    const issuerUri = GLib.Uri.parse(normalizedIssuer, GLib.UriFlags.NONE);
    const issuerPath = uriPath(issuerUri);
    const isMetadataUrl = issuerPath.includes('/.well-known/oauth-authorization-server')
        || issuerPath.includes('/.well-known/openid-configuration');
    const discoveryUrls = isMetadataUrl
        ? [normalizedIssuer]
        : authorizationServerMetadataUrls(normalizedIssuer);
    const discovered = await firstJson(
        discoveryUrls.map((url) => (
            validateAuthorizationUrl(url, 'Authorization server metadata URL')
        )),
        options,
    );
    const metadata = discovered.json;

    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
        throw createUserVisibleError(
            'Authorization server metadata is missing authorization_endpoint or token_endpoint.',
        );
    }

    if (!Array.isArray(metadata.code_challenge_methods_supported)
        || !metadata.code_challenge_methods_supported.includes('S256')) {
        throw createUserVisibleError('Authorization server does not advertise PKCE S256 support.');
    }

    if (metadata.issuer) {
        validateAuthorizationUrl(metadata.issuer, 'Authorization server issuer');

        const issuer = canonicalMcpResourceUri(metadata.issuer);
        const expectedIssuer = canonicalMcpResourceUri(normalizedIssuer);

        if (!isMetadataUrl && issuer !== expectedIssuer)
            throw createUserVisibleError('Authorization server metadata issuer did not match discovery.');
    }

    for (const [field, label] of [
        ['authorization_endpoint', 'Authorization endpoint'],
        ['token_endpoint', 'Token endpoint'],
        ['registration_endpoint', 'Client registration endpoint'],
    ]) {
        if (metadata[field])
            validateAuthorizationUrl(metadata[field], label);
    }

    return {
        url: discovered.url,
        metadata,
    };
}

function randomVerifier() {
    return [
        GLib.uuid_string_random(),
        GLib.uuid_string_random(),
        GLib.uuid_string_random(),
        GLib.uuid_string_random(),
    ].join('').replace(/-/g, '');
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);

    for (let index = 0; index < hex.length; index += 2)
        bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);

    return bytes;
}

function base64Url(bytes) {
    return GLib.base64_encode(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

export function createPkceChallenge(verifier) {
    const digest = GLib.compute_checksum_for_data(
        GLib.ChecksumType.SHA256,
        new TextEncoder().encode(verifier),
    );
    return base64Url(hexToBytes(digest));
}

function parseQuery(query) {
    const params = {};

    for (const part of String(query ?? '').split('&')) {
        if (!part)
            continue;

        const [rawName, rawValue = ''] = part.split('=');
        const name = GLib.uri_unescape_string(rawName.replace(/\+/g, '%20'), null);
        const value = GLib.uri_unescape_string(rawValue.replace(/\+/g, '%20'), null);

        if (name)
            params[name] = value;
    }

    return params;
}

function escapedHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function callbackResponse(message, heading, body) {
    message.set_status(Soup.Status.OK, null);
    message.set_response(
        'text/html',
        Soup.MemoryUse.COPY,
        `<html><body><h1>${escapedHtml(heading)}</h1><p>${escapedHtml(body)}</p></body></html>`,
    );
}

function callbackDescriptor(server, authorizationMetadata) {
    const configuredUrl = String(server.oauth?.callbackUrl ?? '').trim();
    let callbackPath = '/callback';
    let callbackPort = Number(server.oauth?.callbackPort ?? 0);
    let callbackHost = '127.0.0.1';

    if (configuredUrl) {
        validateAuthorizationUrl(configuredUrl, 'OAuth callback URL');
        const uri = GLib.Uri.parse(configuredUrl, GLib.UriFlags.NONE);
        const scheme = String(uri.get_scheme() ?? '').toLowerCase();
        const host = String(uri.get_host() ?? '').toLowerCase();
        const configuredUrlPort = Math.max(0, uri.get_port());

        if (scheme !== 'http' || !isLoopbackHost(host)) {
            throw createUserVisibleError(
                'Cusco OAuth callback URLs must use HTTP on localhost or another loopback address.',
            );
        }
        if (uri.get_query() || uri.get_fragment())
            throw createUserVisibleError('Cusco OAuth callback URLs cannot include a query or fragment.');
        if (callbackPort && configuredUrlPort && callbackPort !== configuredUrlPort) {
            throw createUserVisibleError(
                'OAuth callback URL and callback port must use the same port.',
            );
        }

        callbackPath = uriPath(uri);
        callbackHost = host.includes(':') ? `[${host}]` : host;
        callbackPort ||= configuredUrlPort;
    } else if (server.oauth?.clientId) {
        const digest = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256,
            canonicalMcpResourceUri(server.url),
            -1,
        ).slice(0, 16);
        callbackPath = `/callback/${digest}`;
    }

    return {
        callbackPath,
        callbackPort,
        callbackHost,
        issuerRequired: authorizationMetadata.authorization_response_iss_parameter_supported === true,
    };
}

function createCallbackListener(expectedState, descriptor = {}, options = {}) {
    const server = new Soup.Server();
    let timeoutId = 0;
    let closed = false;
    let closeRequested = false;
    let activeResponses = 0;
    let resolveCallback;
    let rejectCallback;

    const promise = new Promise((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
    });

    const disconnect = () => {
        if (closed)
            return;

        closed = true;
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }

        server.disconnect();
    };

    const close = () => {
        if (closed || closeRequested)
            return;

        closeRequested = true;
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
        if (activeResponses === 0)
            disconnect();
    };

    server.add_handler(descriptor.callbackPath ?? '/callback', (_server, message) => {
        activeResponses++;
        message.connect('finished', () => {
            activeResponses = Math.max(0, activeResponses - 1);
            if (closeRequested && activeResponses === 0)
                disconnect();
        });
        const params = parseQuery(message.get_uri()?.get_query?.() ?? '');

        if (params.error) {
            callbackResponse(message, 'Cusco authorization failed', params.error_description || params.error);
            close();
            rejectCallback(createUserVisibleError(params.error_description || params.error));
            return;
        }

        if (params.state !== expectedState) {
            callbackResponse(message, 'Cusco authorization failed', 'The authorization state did not match.');
            close();
            rejectCallback(createUserVisibleError('Authorization callback state did not match.'));
            return;
        }

        if (!params.code) {
            callbackResponse(message, 'Cusco authorization failed', 'No authorization code was returned.');
            close();
            rejectCallback(createUserVisibleError('Authorization callback did not include a code.'));
            return;
        }

        callbackResponse(message, 'Cusco authorization complete', 'You can return to Cusco.');
        close();
        resolveCallback(params);
    });

    try {
        server.listen_local(
            descriptor.callbackPort ?? 0,
            Soup.ServerListenOptions.NONE,
        );
    } catch (error) {
        throw createUserVisibleError(
            `Could not start the MCP authorization callback listener: ${error.message}`,
            'Cusco could not open the local OAuth callback port. Close any conflicting application and try again.',
        );
    }

    const port = server.get_uris()[0].get_port();
    const timeoutSeconds = Math.max(1, Math.round(
        options.timeoutSeconds ?? DEFAULT_AUTH_TIMEOUT_SECONDS,
    ));

    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
        timeoutId = 0;
        close();
        rejectCallback(createUserVisibleError('Authorization timed out before the browser returned to Cusco.'));
        return GLib.SOURCE_REMOVE;
    });

    return {
        redirectUri: `http://${descriptor.callbackHost ?? '127.0.0.1'}:${port}${descriptor.callbackPath ?? '/callback'}`,
        promise,
        close,
    };
}

function advertisedTokenAuthMethods(metadata) {
    return Array.isArray(metadata.token_endpoint_auth_methods_supported)
        ? metadata.token_endpoint_auth_methods_supported.map(String)
        : [];
}

function selectTokenAuthMethod(metadata, { hasClientSecret = false, requested = '' } = {}) {
    const supported = advertisedTokenAuthMethods(metadata);
    const normalizedRequested = String(requested ?? '').trim();

    if (normalizedRequested) {
        if (supported.length > 0 && !supported.includes(normalizedRequested)) {
            throw createUserVisibleError(
                `Authorization server does not support token endpoint method ${normalizedRequested}.`,
            );
        }
        return normalizedRequested;
    }

    if (hasClientSecret) {
        if (supported.includes('client_secret_post'))
            return 'client_secret_post';
        if (supported.includes('client_secret_basic') || supported.length === 0)
            return 'client_secret_basic';
    }

    if (supported.includes('none') || supported.length === 0)
        return 'none';
    if (supported.includes('client_secret_post'))
        return 'client_secret_post';
    if (supported.includes('client_secret_basic'))
        return 'client_secret_basic';

    throw createUserVisibleError(
        'Authorization server does not advertise a client authentication method Cusco supports.',
    );
}

async function configuredClientRegistration(server, metadata, redirectUri, options = {}) {
    const clientId = String(server.oauth?.clientId ?? '').trim();

    if (!clientId)
        return null;

    let clientMetadata = null;

    if (clientId.startsWith('https://')) {
        validateAuthorizationUrl(clientId, 'Client ID metadata URL');
        clientMetadata = await fetchJson(clientId, options);

        if (clientMetadata.client_id && String(clientMetadata.client_id) !== clientId)
            throw createUserVisibleError('Client ID metadata did not match its document URL.');
        if (!Array.isArray(clientMetadata.redirect_uris)
            || !clientMetadata.redirect_uris.includes(redirectUri)) {
            throw createUserVisibleError(
                `Client ID metadata does not allow Cusco's callback ${redirectUri}. Configure a matching oauth.callbackUrl and oauth.callbackPort.`,
            );
        }
    }

    const clientSecretEnvVar = String(server.oauth?.clientSecretEnvVar ?? '').trim();
    const clientSecret = clientSecretEnvVar
        ? String(GLib.getenv(clientSecretEnvVar) ?? '').trim()
        : '';
    const tokenEndpointAuthMethod = selectTokenAuthMethod(metadata, {
        hasClientSecret: Boolean(clientSecret),
        requested: server.oauth?.tokenEndpointAuthMethod
            || clientMetadata?.token_endpoint_auth_method,
    });

    if (tokenEndpointAuthMethod !== 'none' && !clientSecret) {
        throw createUserVisibleError(
            `OAuth client ${clientId} requires a client secret. Configure oauth.clientSecretEnvVar for this MCP server.`,
        );
    }

    return {
        clientId,
        clientSecret,
        clientSecretEnvVar,
        tokenEndpointAuthMethod,
        registrationType: clientId.startsWith('https://') ? 'cimd' : 'configured',
    };
}

async function registerClient(server, metadata, redirectUri, scope, options = {}) {
    const configured = await configuredClientRegistration(
        server,
        metadata,
        redirectUri,
        options,
    );

    if (configured)
        return configured;

    if (!metadata.registration_endpoint) {
        throw createUserVisibleError(
            'Authorization server supports neither dynamic client registration nor a configured OAuth client ID. Add oauth.clientId to this MCP server configuration.',
        );
    }

    const tokenEndpointAuthMethod = selectTokenAuthMethod(metadata, {
        hasClientSecret: advertisedTokenAuthMethods(metadata).some((method) => (
            method === 'client_secret_post' || method === 'client_secret_basic'
        )),
    });
    const grantTypes = ['authorization_code'];

    if (!Array.isArray(metadata.grant_types_supported)
        || metadata.grant_types_supported.includes('refresh_token')) {
        grantTypes.push('refresh_token');
    }

    const registration = await postJson(metadata.registration_endpoint, {
        client_name: 'Cusco',
        client_uri: 'https://github.com/stonega/cusco',
        redirect_uris: [redirectUri],
        grant_types: grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
        scope,
    }, options);
    const clientId = String(registration.client_id ?? '').trim();
    const clientSecret = String(registration.client_secret ?? '').trim();
    const registeredMethod = String(
        registration.token_endpoint_auth_method ?? tokenEndpointAuthMethod,
    ).trim();

    if (!clientId)
        throw createUserVisibleError('Authorization server registration did not return a client_id.');
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(registeredMethod)) {
        throw createUserVisibleError(
            `Authorization server registered unsupported token endpoint method ${registeredMethod}.`,
        );
    }
    if (registeredMethod !== 'none' && !clientSecret) {
        throw createUserVisibleError(
            `Authorization server registered ${registeredMethod} but did not return a client secret.`,
        );
    }

    return {
        clientId,
        clientSecret,
        clientSecretEnvVar: '',
        tokenEndpointAuthMethod: registeredMethod,
        registrationType: 'dynamic',
    };
}

function scopesForAuthorization(challenge, protectedMetadata, authorizationMetadata, server) {
    if (challenge?.scope)
        return challenge.scope;

    if (Array.isArray(server.oauth?.scopes) && server.oauth.scopes.length > 0)
        return server.oauth.scopes.join(' ');

    if (Array.isArray(protectedMetadata.scopes_supported))
        return protectedMetadata.scopes_supported.join(' ');

    if (Array.isArray(authorizationMetadata.scopes_supported))
        return authorizationMetadata.scopes_supported.join(' ');

    return '';
}

function tokenFromResponse(response, context, previousToken = null) {
    const accessToken = String(response?.access_token ?? '').trim();
    const tokenType = String(response?.token_type ?? previousToken?.tokenType ?? 'Bearer').trim()
        || 'Bearer';

    if (!accessToken)
        throw createUserVisibleError('Authorization server did not return an access token.');
    if (tokenType.toLowerCase() !== 'bearer')
        throw createUserVisibleError(`Authorization server returned unsupported token type ${tokenType}.`);

    const expiresIn = Number(response.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : '';

    return {
        version: 2,
        accessToken,
        refreshToken: String(response.refresh_token ?? previousToken?.refreshToken ?? '').trim(),
        tokenType,
        scope: String(response.scope ?? previousToken?.scope ?? context.scope ?? '').trim(),
        expiresAt,
        resource: context.resource ?? previousToken?.resource ?? '',
        authorizationServer: context.authorizationServer ?? previousToken?.authorizationServer ?? '',
        tokenEndpoint: context.tokenEndpoint ?? previousToken?.tokenEndpoint ?? '',
        clientId: context.clientId ?? previousToken?.clientId ?? '',
        clientSecret: context.clientSecretEnvVar
            ? ''
            : (context.clientSecret ?? previousToken?.clientSecret ?? ''),
        clientSecretEnvVar: context.clientSecretEnvVar ?? previousToken?.clientSecretEnvVar ?? '',
        tokenEndpointAuthMethod: context.tokenEndpointAuthMethod
            ?? previousToken?.tokenEndpointAuthMethod
            ?? 'none',
        registrationType: context.registrationType ?? previousToken?.registrationType ?? '',
        createdAt: new Date().toISOString(),
    };
}

export class SecretServiceMcpTokenStore {
    lookup(serverKey) {
        const raw = Secret.password_lookup_sync(MCP_AUTH_TOKEN_SCHEMA, { server: String(serverKey) }, null) ?? '';

        if (!raw)
            return null;

        try {
            return JSON.parse(raw);
        } catch (_error) {
            return null;
        }
    }

    store(serverKey, serverName, token) {
        return Secret.password_store_sync(
            MCP_AUTH_TOKEN_SCHEMA,
            { server: String(serverKey) },
            Secret.COLLECTION_DEFAULT,
            `Cusco MCP authorization for ${serverName}`,
            JSON.stringify(token),
            null,
        );
    }

    clear(serverKey) {
        return Secret.password_clear_sync(MCP_AUTH_TOKEN_SCHEMA, { server: String(serverKey) }, null);
    }
}

export class MemoryMcpTokenStore {
    constructor(values = {}) {
        this._values = new Map(Object.entries(values));
    }

    lookup(serverKey) {
        return this._values.get(String(serverKey)) ?? null;
    }

    store(serverKey, _serverName, token) {
        this._values.set(String(serverKey), token);
        return true;
    }

    clear(serverKey) {
        this._values.delete(String(serverKey));
        return true;
    }
}

export function createDefaultMcpTokenStore() {
    return new SecretServiceMcpTokenStore();
}

function tokenExpirationMilliseconds(token) {
    const expiresAt = Date.parse(String(token?.expiresAt ?? ''));
    return Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY;
}

export function shouldRefreshMcpToken(token, options = {}) {
    if (!token?.accessToken)
        return false;

    const nowMilliseconds = Number(options.nowMilliseconds ?? Date.now());
    const skewMilliseconds = Math.max(
        0,
        Number(options.skewMilliseconds ?? TOKEN_REFRESH_SKEW_MS),
    );

    return tokenExpirationMilliseconds(token) <= nowMilliseconds + skewMilliseconds;
}

function clientAuthenticationForToken(token) {
    const method = String(token?.tokenEndpointAuthMethod ?? 'none').trim() || 'none';
    const clientSecretEnvVar = String(token?.clientSecretEnvVar ?? '').trim();
    const clientSecret = clientSecretEnvVar
        ? String(GLib.getenv(clientSecretEnvVar) ?? '').trim()
        : String(token?.clientSecret ?? '').trim();

    if (method !== 'none' && !clientSecret) {
        throw createUserVisibleError(
            `OAuth token refresh requires a client secret${clientSecretEnvVar ? ` from ${clientSecretEnvVar}` : ''}.`,
        );
    }

    return {
        method,
        clientId: String(token?.clientId ?? '').trim(),
        clientSecret,
    };
}

export async function refreshMcpToken(server, token, tokenStore, options = {}) {
    const refreshToken = String(token?.refreshToken ?? '').trim();
    const clientId = String(token?.clientId ?? '').trim();
    const rawTokenEndpoint = String(token?.tokenEndpoint ?? '').trim();

    if (!refreshToken || !clientId || !rawTokenEndpoint) {
        const error = createUserVisibleError(
            `${server.name} must be authorized again because its OAuth session cannot be refreshed.`,
        );
        error.mcpReauthorizationRequired = true;
        throw error;
    }

    const tokenEndpoint = validateAuthorizationUrl(rawTokenEndpoint, 'OAuth token endpoint');

    try {
        options.onStatus?.('refreshing', `Refreshing authorization for ${server.name}…`);
        const response = await postForm(tokenEndpoint, {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            resource: token.resource,
            scope: token.scope,
        }, {
            ...options,
            clientAuthentication: clientAuthenticationForToken(token),
        });
        const refreshed = tokenFromResponse(response, {
            resource: token.resource,
            scope: token.scope,
            authorizationServer: token.authorizationServer,
            tokenEndpoint,
            clientId,
            clientSecret: token.clientSecret,
            clientSecretEnvVar: token.clientSecretEnvVar,
            tokenEndpointAuthMethod: token.tokenEndpointAuthMethod,
            registrationType: token.registrationType,
        }, token);

        tokenStore.store(server.key, server.name, refreshed);
        return refreshed;
    } catch (error) {
        if (error?.httpStatus === 400 || error?.httpStatus === 401)
            error.mcpReauthorizationRequired = true;
        throw error;
    }
}

export async function authorizeMcpServer(server, challenge = {}, tokenStore, options = {}) {
    if (server.transport !== 'streamable-http' || !server.url)
        throw createUserVisibleError('Only HTTP MCP servers support OAuth authorization.');

    options.onStatus?.('discovering', `Discovering authorization for ${server.name}…`);
    let protectedResource;

    try {
        protectedResource = await discoverProtectedResourceMetadata(server, challenge, options);
    } catch (error) {
        if (!challenge.authorizationUri)
            throw error;

        protectedResource = {
            url: '',
            metadata: {
                resource: server.oauth?.resource || canonicalMcpResourceUri(server.url),
                authorization_servers: [challenge.authorizationUri],
                scopes_supported: String(challenge.scope ?? '').split(/\s+/).filter(Boolean),
            },
        };
    }

    const authorizationServers = protectedResource.metadata.authorization_servers;

    if (!Array.isArray(authorizationServers) || authorizationServers.length === 0) {
        throw createUserVisibleError(
            'MCP protected resource metadata did not include an authorization server.',
        );
    }

    const authorizationServer = await discoverAuthorizationServerMetadata(authorizationServers[0], options);
    const state = GLib.uuid_string_random();
    const verifier = randomVerifier();
    const descriptor = callbackDescriptor(server, authorizationServer.metadata);
    const callbackFactory = options.createCallbackListener ?? createCallbackListener;
    const callback = callbackFactory(state, descriptor, {
        timeoutSeconds: options.authTimeoutSeconds,
    });

    try {
        const resource = validateAuthorizationUrl(
            server.oauth?.resource
            || protectedResource.metadata.resource
            || canonicalMcpResourceUri(server.url),
            'OAuth resource URL',
        );
        const scope = scopesForAuthorization(
            challenge,
            protectedResource.metadata,
            authorizationServer.metadata,
            server,
        );
        options.onStatus?.('registering', `Registering Cusco with ${server.name}…`);
        const registration = await registerClient(
            server,
            authorizationServer.metadata,
            callback.redirectUri,
            scope,
            options,
        );
        const authorizationUrl = appendQuery(authorizationServer.metadata.authorization_endpoint, {
            response_type: 'code',
            client_id: registration.clientId,
            redirect_uri: callback.redirectUri,
            code_challenge: createPkceChallenge(verifier),
            code_challenge_method: 'S256',
            state,
            resource,
            scope,
        });

        options.onStatus?.('waiting', `Waiting for ${server.name} authorization in your browser…`);
        if (options.openUri)
            await options.openUri(authorizationUrl);
        else
            Gio.AppInfo.launch_default_for_uri(authorizationUrl, null);

        const callbackParams = await callback.promise;
        const expectedIssuer = authorizationServer.metadata.issuer || authorizationServers[0];

        if (descriptor.issuerRequired && !callbackParams.iss) {
            throw createUserVisibleError('Authorization callback did not include its required issuer.');
        }
        if (callbackParams.iss
            && canonicalMcpResourceUri(callbackParams.iss) !== canonicalMcpResourceUri(expectedIssuer)) {
            throw createUserVisibleError('Authorization callback issuer did not match the authorization server.');
        }

        options.onStatus?.('exchanging', `Completing authorization for ${server.name}…`);
        const tokenResponse = await postForm(authorizationServer.metadata.token_endpoint, {
            grant_type: 'authorization_code',
            code: callbackParams.code,
            redirect_uri: callback.redirectUri,
            client_id: registration.clientId,
            code_verifier: verifier,
            resource,
        }, {
            ...options,
            clientAuthentication: {
                method: registration.tokenEndpointAuthMethod,
                clientId: registration.clientId,
                clientSecret: registration.clientSecret,
            },
        });
        const token = tokenFromResponse(tokenResponse, {
            resource,
            scope,
            authorizationServer: authorizationServers[0],
            tokenEndpoint: authorizationServer.metadata.token_endpoint,
            clientId: registration.clientId,
            clientSecret: registration.clientSecret,
            clientSecretEnvVar: registration.clientSecretEnvVar,
            tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
            registrationType: registration.registrationType,
        });
        tokenStore.store(server.key, server.name, token);
        return token;
    } finally {
        callback.close();
    }
}
