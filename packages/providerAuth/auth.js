import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Secret from 'gi://Secret?version=1';
import Soup from 'gi://Soup?version=3.0';

const DEFAULT_AUTH_TIMEOUT_SECONDS = 300;
const DEFAULT_HTTP_TIMEOUT_SECONDS = 30;
const TOKEN_REFRESH_SKEW_MS = 60_000;

const PROVIDER_TOKEN_SCHEMA = new Secret.Schema(
    'io.github.stonega.Cusco.ProviderAuthToken',
    Secret.SchemaFlags.NONE,
    {
        provider: Secret.SchemaAttributeType.STRING,
        method: Secret.SchemaAttributeType.STRING,
    },
);

const METHOD_DEFINITIONS = Object.freeze({
    'openai:chatgpt-subscription': Object.freeze({
        providerId: 'openai',
        id: 'chatgpt-subscription',
        name: 'ChatGPT subscription',
        description: 'Use an eligible ChatGPT subscription through the Codex service.',
        kind: 'oauth',
        requestProfile: 'openai-codex',
        authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
        tokenEndpoint: 'https://auth.openai.com/oauth/token',
        clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
        redirectUri: 'http://localhost:1455/auth/callback',
        callbackPort: 1455,
        callbackPath: '/auth/callback',
        scope: 'openid profile email offline_access',
        refreshScope: 'openid profile email',
        authorizationParams: Object.freeze({
            id_token_add_organizations: 'true',
            codex_cli_simplified_flow: 'true',
        }),
    }),
    'anthropic:claude-subscription': Object.freeze({
        providerId: 'anthropic',
        id: 'claude-subscription',
        name: 'Claude subscription',
        description: 'Use an eligible Claude subscription through the Claude Code OAuth service.',
        riskTitle: 'Claude Code OAuth risk',
        riskNote: 'This is an unofficial Claude Code compatibility path. Anthropic may classify its traffic as extra usage instead of usage included with a Claude plan, and may change or block the flow without notice. Check account usage after connecting.',
        kind: 'oauth',
        requestProfile: 'anthropic-claude-code',
        authorizationEndpoint: 'https://claude.com/cai/oauth/authorize',
        tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
        clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        redirectUri: 'https://platform.claude.com/oauth/code/callback',
        manualCode: true,
        scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
        tokenFormat: 'json',
        authorizationParams: Object.freeze({ code: 'true' }),
    }),
    'gemini:google-oauth': Object.freeze({
        providerId: 'gemini',
        id: 'google-oauth',
        name: 'Google OAuth',
        description: 'Use Google OAuth with a Cusco-configured desktop client.',
        kind: 'oauth',
        requestProfile: 'google-gemini',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        clientIdEnvVar: 'CUSCO_GEMINI_OAUTH_CLIENT_ID',
        clientSecretEnvVar: 'CUSCO_GEMINI_OAUTH_CLIENT_SECRET',
        callbackPath: '/callback',
        scope: 'openid email profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever',
        authorizationParams: Object.freeze({
            access_type: 'offline',
            prompt: 'consent',
            include_granted_scopes: 'true',
        }),
    }),
    'grok:grok-subscription': Object.freeze({
        providerId: 'grok',
        id: 'grok-subscription',
        name: 'Grok subscription',
        description: 'Use an eligible Grok subscription through the Grok CLI service.',
        kind: 'oauth',
        requestProfile: 'grok-cli',
        authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize',
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
        clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
        redirectUri: 'http://127.0.0.1:56121/callback',
        callbackPort: 56121,
        callbackPath: '/callback',
        scope: 'openid profile email offline_access grok-cli:access api:access',
        authorizationParams: Object.freeze({
            plan: 'generic',
            referrer: 'cusco',
        }),
        includeNonce: true,
    }),
});

function createUserVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

function methodKey(providerId, methodId) {
    return `${String(providerId)}:${String(methodId)}`;
}

function encodeText(text) {
    return new GLib.Bytes(new TextEncoder().encode(String(text ?? '')));
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
    const query = formEncode(params);
    return query ? `${url}${String(url).includes('?') ? '&' : '?'}${query}` : url;
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

async function postToken(url, params, options = {}) {
    const session = new Soup.Session({
        timeout: Math.max(1, Math.round(options.timeoutSeconds ?? DEFAULT_HTTP_TIMEOUT_SECONDS)),
    });
    const message = Soup.Message.new('POST', url);
    const json = options.format === 'json';
    const body = json ? JSON.stringify(params) : formEncode(params);
    const contentType = json ? 'application/json' : 'application/x-www-form-urlencoded';
    message.request_headers.append('Accept', 'application/json');
    message.request_headers.append('Content-Type', contentType);
    for (const [name, value] of Object.entries(options.headers ?? {}))
        message.request_headers.replace(name, String(value));
    message.set_request_body_from_bytes(contentType, encodeText(body));

    const bytes = await sendAndRead(session, message, options.cancellable ?? null);
    const status = message.get_status();
    const text = responseTextFromBytes(bytes);

    if (status < 200 || status >= 300) {
        throw createUserVisibleError(
            `Authorization token exchange failed (${status}): ${url}`,
            'The provider rejected the authorization exchange. Try signing in again.',
        );
    }

    return parseJsonResponse(text, url);
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

function createCallbackListener(expectedState, descriptor, options = {}) {
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
            const detail = params.error_description || params.error;
            callbackResponse(message, 'Cusco authorization failed', detail);
            close();
            rejectCallback(createUserVisibleError(detail));
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
        resolveCallback(params.code);
    });

    try {
        server.listen_local(descriptor.callbackPort ?? 0, 0);
    } catch (error) {
        throw createUserVisibleError(
            `Could not start the authorization callback listener: ${error.message}`,
            `Cusco could not open the local callback port for ${descriptor.name}. Close any conflicting app and try again.`,
        );
    }

    const port = server.get_uris()[0].get_port();
    const redirectUri = descriptor.redirectUri
        ?? `http://127.0.0.1:${port}${descriptor.callbackPath ?? '/callback'}`;
    timeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        Math.max(1, Math.round(options.timeoutSeconds ?? DEFAULT_AUTH_TIMEOUT_SECONDS)),
        () => {
            timeoutId = 0;
            close();
            rejectCallback(createUserVisibleError('Authorization timed out before the browser returned to Cusco.'));
            return GLib.SOURCE_REMOVE;
        },
    );

    return { redirectUri, promise, close };
}

function decodeJwtPayload(token) {
    const payload = String(token ?? '').split('.')[1];
    if (!payload)
        return {};

    try {
        const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
        return JSON.parse(new TextDecoder().decode(GLib.base64_decode(padded)));
    } catch (_error) {
        return {};
    }
}

function normalizeTokenResponse(response, descriptor, previousToken = null) {
    const accessToken = String(response?.access_token ?? '').trim();
    if (!accessToken)
        throw createUserVisibleError('Authorization server did not return an access token.');

    const expiresIn = Number(response.expires_in);
    const idToken = String(response.id_token ?? previousToken?.idToken ?? '').trim();
    const claims = decodeJwtPayload(idToken);
    const openAiClaims = claims['https://api.openai.com/auth'] ?? {};

    return {
        version: 1,
        providerId: descriptor.providerId,
        methodId: descriptor.id,
        accessToken,
        refreshToken: String(response.refresh_token ?? previousToken?.refreshToken ?? '').trim(),
        idToken,
        tokenType: String(response.token_type ?? previousToken?.tokenType ?? 'Bearer').trim() || 'Bearer',
        scope: String(response.scope ?? previousToken?.scope ?? descriptor.scope ?? '').trim(),
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0
            ? Date.now() + expiresIn * 1000
            : 0,
        accountId: String(openAiClaims.chatgpt_account_id ?? previousToken?.accountId ?? '').trim(),
        accountLabel: String(claims.email ?? previousToken?.accountLabel ?? '').trim(),
        createdAt: new Date().toISOString(),
    };
}

function resolveDescriptor(providerId, methodId, envLookup) {
    const definition = METHOD_DEFINITIONS[methodKey(providerId, methodId)];
    if (!definition)
        throw new Error(`Unknown provider authentication method: ${providerId}/${methodId}`);

    const descriptor = {
        ...definition,
        authorizationParams: { ...(definition.authorizationParams ?? {}) },
    };
    if (descriptor.clientIdEnvVar)
        descriptor.clientId = String(envLookup(descriptor.clientIdEnvVar) ?? '').trim();
    if (descriptor.clientSecretEnvVar)
        descriptor.clientSecret = String(envLookup(descriptor.clientSecretEnvVar) ?? '').trim();
    return descriptor;
}

function availabilityForDescriptor(descriptor) {
    if (!descriptor.clientId) {
        return {
            available: false,
            reason: `Set ${descriptor.clientIdEnvVar} to a Google OAuth desktop client ID before signing in.`,
        };
    }

    return { available: true, reason: '' };
}

function manualAuthorizationCode(value, expectedState) {
    const text = String(value ?? '').trim();
    const separator = text.lastIndexOf('#');
    const code = separator >= 0 ? text.slice(0, separator).trim() : text;
    const state = separator >= 0 ? text.slice(separator + 1).trim() : '';

    if (!code)
        throw createUserVisibleError('Enter the authorization code returned by the provider.');
    if (state && state !== expectedState)
        throw createUserVisibleError('Authorization code state did not match. Start sign-in again.');
    return code;
}

function tokenRequestHeaders(descriptor) {
    if (descriptor.requestProfile !== 'openai-codex')
        return {};

    return {
        originator: 'codex_tui_rs',
        'User-Agent': 'codex-tui/0.146.0 (Linux; x86_64)',
    };
}

function responseInputText(content) {
    if (typeof content === 'string')
        return content.trim();
    if (!Array.isArray(content))
        return '';

    return content
        .filter((part) => ['input_text', 'output_text', 'text'].includes(part?.type))
        .map((part) => String(part.text ?? '').trim())
        .filter(Boolean)
        .join('\n');
}

function codexInstructions(body) {
    const configured = String(body?.instructions ?? '').trim();
    if (configured)
        return configured;

    const promoted = (Array.isArray(body?.input) ? body.input : [])
        .filter((item) => item?.role === 'developer' || item?.role === 'system')
        .map((item) => responseInputText(item.content))
        .filter(Boolean)
        .join('\n\n');
    return promoted || 'You are a helpful AI assistant in Cusco.';
}

function normalizeCodexRequestBody(body, stream) {
    body.instructions = codexInstructions(body);
    body.store = false;
    body.stream = stream;

    for (const key of [
        'max_output_tokens',
        'max_completion_tokens',
        'temperature',
        'top_p',
        'frequency_penalty',
        'presence_penalty',
        'user',
        'metadata',
        'prompt_cache_retention',
        'safety_identifier',
        'stream_options',
    ])
        delete body[key];

    if (body.reasoning && typeof body.reasoning === 'object') {
        const include = Array.isArray(body.include) ? [...body.include] : [];
        if (!include.includes('reasoning.encrypted_content'))
            include.push('reasoning.encrypted_content');
        body.include = include;
    }
}

export function listProviderAuthMethods(providerId, envLookup = GLib.getenv) {
    return Object.values(METHOD_DEFINITIONS)
        .filter((method) => method.providerId === providerId)
        .map((method) => {
            const descriptor = resolveDescriptor(method.providerId, method.id, envLookup);
            return {
                id: descriptor.id,
                name: descriptor.name,
                description: descriptor.description,
                riskTitle: descriptor.riskTitle ?? '',
                riskNote: descriptor.riskNote ?? '',
                kind: descriptor.kind,
                requestProfile: descriptor.requestProfile,
                ...availabilityForDescriptor(descriptor),
            };
        });
}

export class SecretServiceProviderTokenStore {
    constructor(secretService = Secret) {
        this._secretService = secretService;
        this._cache = new Map();
    }

    lookup(providerId, methodId) {
        const key = methodKey(providerId, methodId);
        if (this._cache.has(key))
            return this._cache.get(key);

        const raw = this._secretService.password_lookup_sync(
            PROVIDER_TOKEN_SCHEMA,
            { provider: String(providerId), method: String(methodId) },
            null,
        ) ?? '';
        if (!raw)
            return null;

        try {
            const token = JSON.parse(raw);
            this._cache.set(key, token);
            return token;
        } catch (_error) {
            return null;
        }
    }

    store(providerId, methodId, providerName, token) {
        const stored = this._secretService.password_store_sync(
            PROVIDER_TOKEN_SCHEMA,
            { provider: String(providerId), method: String(methodId) },
            this._secretService.COLLECTION_DEFAULT,
            `Cusco ${providerName} authorization`,
            JSON.stringify(token),
            null,
        );
        if (stored !== false)
            this._cache.set(methodKey(providerId, methodId), token);
        return stored;
    }

    clear(providerId, methodId) {
        this._cache.delete(methodKey(providerId, methodId));
        return this._secretService.password_clear_sync(
            PROVIDER_TOKEN_SCHEMA,
            { provider: String(providerId), method: String(methodId) },
            null,
        );
    }
}

export class MemoryProviderTokenStore {
    constructor(values = {}) {
        this._values = new Map(Object.entries(values));
    }

    lookup(providerId, methodId) {
        return this._values.get(methodKey(providerId, methodId)) ?? null;
    }

    store(providerId, methodId, _providerName, token) {
        this._values.set(methodKey(providerId, methodId), token);
        return true;
    }

    clear(providerId, methodId) {
        this._values.delete(methodKey(providerId, methodId));
        return true;
    }
}

export class ProviderAuthManager {
    constructor(options = {}) {
        this._tokenStore = options.tokenStore ?? new SecretServiceProviderTokenStore();
        this._envLookup = options.envLookup ?? GLib.getenv;
        this._openUri = options.openUri ?? ((uri) => Gio.AppInfo.launch_default_for_uri(uri, null));
        this._postToken = options.postToken ?? postToken;
        this._now = options.now ?? Date.now;
        this._refreshes = new Map();
    }

    listMethods(providerId) {
        return listProviderAuthMethods(providerId, this._envLookup);
    }

    getStatus(providerId, methodId) {
        const descriptor = resolveDescriptor(providerId, methodId, this._envLookup);
        const availability = availabilityForDescriptor(descriptor);
        let token = null;
        let error = null;
        try {
            token = this._tokenStore.lookup(providerId, methodId);
        } catch (caught) {
            error = caught;
        }

        return {
            configured: Boolean(token?.accessToken),
            source: token?.accessToken ? 'secret' : null,
            accountLabel: String(token?.accountLabel ?? ''),
            expiresAt: Number(token?.expiresAt ?? 0),
            available: availability.available,
            unavailableReason: availability.reason,
            error,
        };
    }

    async authenticate(providerId, methodId, options = {}) {
        const descriptor = resolveDescriptor(providerId, methodId, this._envLookup);
        const availability = availabilityForDescriptor(descriptor);
        if (!availability.available)
            throw createUserVisibleError(availability.reason);

        const state = GLib.uuid_string_random();
        const verifier = randomVerifier();
        const nonce = descriptor.includeNonce ? GLib.uuid_string_random() : '';
        let callback = null;
        let redirectUri = descriptor.redirectUri;

        if (!descriptor.manualCode) {
            callback = createCallbackListener(state, descriptor, {
                timeoutSeconds: options.timeoutSeconds,
            });
            redirectUri = callback.redirectUri;
        }

        const authorizationUrl = appendQuery(descriptor.authorizationEndpoint, {
            response_type: 'code',
            client_id: descriptor.clientId,
            redirect_uri: redirectUri,
            scope: descriptor.scope,
            state,
            nonce,
            code_challenge: createPkceChallenge(verifier),
            code_challenge_method: 'S256',
            ...descriptor.authorizationParams,
        });

        try {
            await this._openUri(authorizationUrl);
            const rawCode = descriptor.manualCode
                ? await options.requestAuthorizationCode?.({
                    providerId,
                    methodId,
                    authorizationUrl,
                    state,
                    instructions: 'After approving access in the browser, paste the returned code here.',
                })
                : await callback.promise;
            if (descriptor.manualCode && rawCode === undefined)
                throw createUserVisibleError('This provider requires the returned authorization code.');
            const code = descriptor.manualCode
                ? manualAuthorizationCode(rawCode, state)
                : String(rawCode);
            const response = await this._postToken(descriptor.tokenEndpoint, {
                grant_type: 'authorization_code',
                code,
                client_id: descriptor.clientId,
                client_secret: descriptor.clientSecret,
                redirect_uri: redirectUri,
                code_verifier: verifier,
                state: descriptor.manualCode ? state : undefined,
            }, {
                cancellable: options.cancellable ?? null,
                timeoutSeconds: options.httpTimeoutSeconds,
                format: descriptor.tokenFormat,
                headers: tokenRequestHeaders(descriptor),
            });
            const token = normalizeTokenResponse(response, descriptor);
            const stored = await this._tokenStore.store(
                providerId,
                methodId,
                options.providerName ?? providerId,
                token,
            );
            if (stored === false)
                throw createUserVisibleError('Secret Service did not store the provider authorization.');
            return this.getStatus(providerId, methodId);
        } finally {
            callback?.close();
        }
    }

    async clear(providerId, methodId) {
        await this._tokenStore.clear(providerId, methodId);
        return this.getStatus(providerId, methodId);
    }

    async _accessToken(providerId, methodId, options = {}) {
        const descriptor = resolveDescriptor(providerId, methodId, this._envLookup);
        const token = this._tokenStore.lookup(providerId, methodId);
        if (!token?.accessToken) {
            throw createUserVisibleError(
                `${descriptor.name} is not connected.`,
                `Sign in to ${descriptor.name} in Settings before sending.`,
            );
        }

        const expiresAt = Number(token.expiresAt ?? 0);
        if (!expiresAt || expiresAt - this._now() > TOKEN_REFRESH_SKEW_MS)
            return token;
        if (!token.refreshToken) {
            throw createUserVisibleError(
                `${descriptor.name} authorization expired without a refresh token.`,
                `Sign in to ${descriptor.name} again in Settings.`,
            );
        }

        const key = methodKey(providerId, methodId);
        if (!this._refreshes.has(key)) {
            const refresh = this._postToken(descriptor.tokenEndpoint, {
                grant_type: 'refresh_token',
                refresh_token: token.refreshToken,
                client_id: descriptor.clientId,
                client_secret: descriptor.clientSecret,
                scope: descriptor.refreshScope ?? undefined,
            }, {
                cancellable: options.cancellable ?? null,
                timeoutSeconds: options.timeoutSeconds,
                format: descriptor.tokenFormat,
                headers: tokenRequestHeaders(descriptor),
            }).then(async (response) => {
                const refreshed = normalizeTokenResponse(response, descriptor, token);
                const stored = await this._tokenStore.store(
                    providerId,
                    methodId,
                    options.providerName ?? providerId,
                    refreshed,
                );
                if (stored === false)
                    throw createUserVisibleError('Secret Service did not store the refreshed authorization.');
                return refreshed;
            }).finally(() => this._refreshes.delete(key));
            this._refreshes.set(key, refresh);
        }

        try {
            return await this._refreshes.get(key);
        } catch (error) {
            throw createUserVisibleError(
                `Could not refresh ${descriptor.name}: ${error.message}`,
                `${descriptor.name} needs attention. Sign in again in Settings.`,
            );
        }
    }

    async authorizeRequest(providerId, methodId, request, options = {}) {
        const descriptor = resolveDescriptor(providerId, methodId, this._envLookup);
        const token = await this._accessToken(providerId, methodId, options);
        const headers = { ...(request.headers ?? {}) };
        const body = request.body && typeof request.body === 'object'
            ? { ...request.body }
            : request.body;
        let url = String(request.url ?? '');

        headers.Authorization = `${token.tokenType || 'Bearer'} ${token.accessToken}`;
        delete headers['x-api-key'];

        switch (descriptor.requestProfile) {
        case 'openai-codex':
            if (request.operation !== 'chat')
                throw createUserVisibleError('ChatGPT subscription authorization does not support model discovery.');
            url = 'https://chatgpt.com/backend-api/codex/responses';
            if (token.accountId)
                headers['chatgpt-account-id'] = token.accountId;
            headers.originator = 'codex_tui_rs';
            headers.version = '0.146.0';
            headers['User-Agent'] = 'codex-tui/0.146.0 (Linux; x86_64)';
            if (body)
                normalizeCodexRequestBody(body, request.stream !== false);
            break;
        case 'anthropic-claude-code':
            if (request.operation !== 'chat')
                throw createUserVisibleError('Claude subscription authorization does not support model discovery.');
            url = 'https://api.anthropic.com/v1/messages?beta=true';
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,effort-2025-11-24,context-management-2025-06-27,extended-cache-ttl-2025-04-11';
            headers['User-Agent'] = 'claude-cli/2.1.220 (external, cli)';
            headers['X-Stainless-Lang'] = 'js';
            headers['X-Stainless-Package-Version'] = '0.94.0';
            headers['X-Stainless-OS'] = 'Linux';
            headers['X-Stainless-Arch'] = 'arm64';
            headers['X-Stainless-Runtime'] = 'node';
            headers['X-Stainless-Runtime-Version'] = 'v24.3.0';
            headers['X-Stainless-Retry-Count'] = '0';
            headers['X-Stainless-Timeout'] = '600';
            headers['X-App'] = 'cli';
            headers['Anthropic-Dangerous-Direct-Browser-Access'] = 'true';
            break;
        case 'google-gemini':
            url = url.replace(/([?&])key=[^&]*&?/g, '$1').replace(/[?&]$/, '');
            break;
        case 'grok-cli':
            if (request.operation !== 'chat')
                throw createUserVisibleError('Grok subscription authorization does not support model discovery.');
            url = 'https://cli-chat-proxy.grok.com/v1/responses';
            headers['X-XAI-Token-Auth'] = 'xai-grok-cli';
            headers['x-grok-client-version'] = '0.2.114';
            headers['x-grok-client-identifier'] = 'grok-shell';
            headers['User-Agent'] = 'xai-grok-workspace/0.2.114';
            break;
        default:
            throw new Error(`Unsupported provider request profile: ${descriptor.requestProfile}`);
        }

        return { ...request, url, headers, body };
    }
}

export function createDefaultProviderAuthManager(options = {}) {
    return new ProviderAuthManager(options);
}
