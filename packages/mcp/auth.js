import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Secret from 'gi://Secret?version=1';
import Soup from 'gi://Soup?version=3.0';

const DEFAULT_AUTH_TIMEOUT_SECONDS = 300;
const DEFAULT_HTTP_TIMEOUT_SECONDS = 30;
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

    const bytes = await sendAndRead(session, message, options.cancellable ?? null);
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

    const bytes = await sendAndRead(session, message, options.cancellable ?? null);
    const status = message.get_status();
    const text = responseTextFromBytes(bytes);

    if (status < 200 || status >= 300)
        throw createUserVisibleError(`Authorization registration failed (${status}): ${text || url}`);

    return parseJsonResponse(text, url);
}

async function postForm(url, params, options = {}) {
    const session = createHttpSession(url, options.timeoutSeconds);
    const message = Soup.Message.new('POST', url);
    const body = formEncode(params);
    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
    message.set_request_body_from_bytes('application/x-www-form-urlencoded', encodeText(body));

    const bytes = await sendAndRead(session, message, options.cancellable ?? null);
    const status = message.get_status();
    const text = responseTextFromBytes(bytes);

    if (status < 200 || status >= 300)
        throw createUserVisibleError(`Authorization token exchange failed (${status}): ${text || url}`);

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
    ].filter(Boolean);
    const discovered = await firstJson([...new Set(urls)], options);

    return {
        url: discovered.url,
        metadata: discovered.json,
    };
}

async function discoverAuthorizationServerMetadata(issuerUrl, options = {}) {
    const discovered = await firstJson(authorizationServerMetadataUrls(issuerUrl), options);
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

function callbackResponse(message, heading, body) {
    message.set_status(Soup.Status.OK, null);
    message.set_response(
        'text/html',
        Soup.MemoryUse.COPY,
        `<html><body><h1>${heading}</h1><p>${body}</p></body></html>`,
    );
}

function createCallbackListener(expectedState, options = {}) {
    const server = new Soup.Server();
    let timeoutId = 0;
    let resolveCallback;
    let rejectCallback;

    const promise = new Promise((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
    });

    const cleanup = () => {
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }

        server.disconnect();
    };

    server.add_handler('/callback', (_server, message) => {
        const params = parseQuery(message.get_uri()?.get_query?.() ?? '');

        if (params.error) {
            callbackResponse(message, 'Cusco authorization failed', params.error_description || params.error);
            cleanup();
            rejectCallback(createUserVisibleError(params.error_description || params.error));
            return;
        }

        if (params.state !== expectedState) {
            callbackResponse(message, 'Cusco authorization failed', 'The authorization state did not match.');
            cleanup();
            rejectCallback(createUserVisibleError('Authorization callback state did not match.'));
            return;
        }

        if (!params.code) {
            callbackResponse(message, 'Cusco authorization failed', 'No authorization code was returned.');
            cleanup();
            rejectCallback(createUserVisibleError('Authorization callback did not include a code.'));
            return;
        }

        callbackResponse(message, 'Cusco authorization complete', 'You can return to Cusco.');
        cleanup();
        resolveCallback(params.code);
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);

    const port = server.get_uris()[0].get_port();
    const timeoutSeconds = Math.max(1, Math.round(
        options.timeoutSeconds ?? DEFAULT_AUTH_TIMEOUT_SECONDS,
    ));

    timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
        timeoutId = 0;
        cleanup();
        rejectCallback(createUserVisibleError('Authorization timed out before the browser returned to Cusco.'));
        return GLib.SOURCE_REMOVE;
    });

    return {
        redirectUri: `http://127.0.0.1:${port}/callback`,
        promise,
        close: cleanup,
    };
}

async function registerClient(metadata, redirectUri, options = {}) {
    if (!metadata.registration_endpoint) {
        throw createUserVisibleError(
            'Authorization server does not support dynamic client registration. Add a pre-registered Authorization header to mcp.json.',
        );
    }

    const registration = await postJson(metadata.registration_endpoint, {
        client_name: 'Cusco',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
    }, options);

    if (!registration.client_id)
        throw createUserVisibleError('Authorization server registration did not return a client_id.');

    return registration;
}

function scopesForAuthorization(challenge, protectedMetadata) {
    if (challenge?.scope)
        return challenge.scope;

    if (Array.isArray(protectedMetadata.scopes_supported))
        return protectedMetadata.scopes_supported.join(' ');

    return '';
}

function tokenFromResponse(response, context) {
    const accessToken = String(response?.access_token ?? '').trim();

    if (!accessToken)
        throw createUserVisibleError('Authorization server did not return an access token.');

    const expiresIn = Number(response.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : '';

    return {
        accessToken,
        refreshToken: String(response.refresh_token ?? '').trim(),
        tokenType: String(response.token_type ?? 'Bearer').trim() || 'Bearer',
        scope: String(response.scope ?? context.scope ?? '').trim(),
        expiresAt,
        resource: context.resource,
        authorizationServer: context.authorizationServer,
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

export async function authorizeMcpServer(server, challenge = {}, tokenStore, options = {}) {
    if (server.transport !== 'streamable-http' || !server.url)
        throw createUserVisibleError('Only HTTP MCP servers support OAuth authorization.');

    const protectedResource = await discoverProtectedResourceMetadata(server, challenge, options);
    const authorizationServers = protectedResource.metadata.authorization_servers;

    if (!Array.isArray(authorizationServers) || authorizationServers.length === 0) {
        throw createUserVisibleError(
            'MCP protected resource metadata did not include an authorization server.',
        );
    }

    const authorizationServer = await discoverAuthorizationServerMetadata(authorizationServers[0], options);
    const state = GLib.uuid_string_random();
    const verifier = randomVerifier();
    const callback = createCallbackListener(state, {
        timeoutSeconds: options.authTimeoutSeconds,
    });

    try {
        const registration = await registerClient(
            authorizationServer.metadata,
            callback.redirectUri,
            options,
        );
        const resource = protectedResource.metadata.resource ?? canonicalMcpResourceUri(server.url);
        const scope = scopesForAuthorization(challenge, protectedResource.metadata);
        const authorizationUrl = appendQuery(authorizationServer.metadata.authorization_endpoint, {
            response_type: 'code',
            client_id: registration.client_id,
            redirect_uri: callback.redirectUri,
            code_challenge: createPkceChallenge(verifier),
            code_challenge_method: 'S256',
            state,
            resource,
            scope,
        });

        Gio.AppInfo.launch_default_for_uri(authorizationUrl, null);

        const code = await callback.promise;
        const tokenResponse = await postForm(authorizationServer.metadata.token_endpoint, {
            grant_type: 'authorization_code',
            code,
            redirect_uri: callback.redirectUri,
            client_id: registration.client_id,
            code_verifier: verifier,
            resource,
        }, options);
        const token = tokenFromResponse(tokenResponse, {
            resource,
            scope,
            authorizationServer: authorizationServers[0],
        });
        tokenStore.store(server.key, server.name, token);
        return token;
    } catch (error) {
        callback.close();
        throw error;
    }
}
