import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import {
    createPkceChallenge,
    listProviderAuthMethods,
    MemoryProviderTokenStore,
    ProviderAuthManager,
} from '../src/providers/auth.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function unsignedJwt(payload) {
    const encode = (value) => GLib.base64_encode(
        new TextEncoder().encode(JSON.stringify(value)),
    ).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `${encode({ alg: 'none' })}.${encode(payload)}.`;
}

function sendAndRead(session, message) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_session, result) => {
            try {
                resolve(session.send_and_read_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function queryParameter(uri, name) {
    const parsed = GLib.Uri.parse(uri, GLib.UriFlags.NONE);
    for (const part of String(parsed.get_query() ?? '').split('&')) {
        const [rawName, rawValue = ''] = part.split('=');
        if (GLib.uri_unescape_string(rawName, null) === name)
            return GLib.uri_unescape_string(rawValue.replace(/\+/g, '%20'), null);
    }
    return '';
}

assert(
    createPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
        === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    'Provider OAuth PKCE did not match RFC 7636',
);

for (const [providerId, expectedMethodId] of [
    ['openai', 'chatgpt-subscription'],
    ['anthropic', 'claude-subscription'],
    ['gemini', 'google-oauth'],
    ['grok', 'grok-subscription'],
]) {
    assert(
        listProviderAuthMethods(providerId, () => '')
            .some((method) => method.id === expectedMethodId),
        `${providerId} did not expose ${expectedMethodId}`,
    );
}

assert(
    listProviderAuthMethods('gemini', () => '')[0].available === false,
    'Google OAuth should require a distributor-owned client ID',
);

const claudeSubscriptionMethod = listProviderAuthMethods('anthropic', () => '')
    .find((method) => method.id === 'claude-subscription');
assert(
    claudeSubscriptionMethod?.riskTitle === 'Claude Code OAuth risk'
        && claudeSubscriptionMethod.riskNote.includes('extra usage'),
    'Claude subscription did not expose its usage-accounting risk',
);

let openedUri = '';
let exchangedParams = null;
const anthropicTokens = new MemoryProviderTokenStore();
const anthropicManager = new ProviderAuthManager({
    tokenStore: anthropicTokens,
    envLookup: () => '',
    openUri: (uri) => {
        openedUri = uri;
    },
    postToken: async (_url, params, options) => {
        exchangedParams = { ...params, format: options.format };
        return {
            access_token: 'anthropic-access',
            refresh_token: 'anthropic-refresh',
            expires_in: 3600,
        };
    },
});

const anthropicStatus = await anthropicManager.authenticate(
    'anthropic',
    'claude-subscription',
    {
        providerName: 'Anthropic',
        requestAuthorizationCode: ({ state }) => `authorization-code#${state}`,
    },
);
assert(anthropicStatus.configured, 'Claude subscription token was not stored');
assert(openedUri.startsWith('https://claude.com/cai/oauth/authorize?'), 'Claude OAuth URL was wrong');
assert(openedUri.includes('code_challenge_method=S256'), 'Claude OAuth did not use PKCE S256');
assert(exchangedParams.code === 'authorization-code'
    && exchangedParams.state
    && exchangedParams.format === 'json', 'Claude OAuth code exchange was wrong');

const anthropicRequest = await anthropicManager.authorizeRequest(
    'anthropic',
    'claude-subscription',
    {
        operation: 'chat',
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': 'must-not-leak' },
        body: { model: 'claude-sonnet-5', stream: true },
        stream: true,
    },
);
assert(anthropicRequest.url === 'https://api.anthropic.com/v1/messages?beta=true',
    'Claude subscription request endpoint was wrong');
assert(anthropicRequest.headers.Authorization === 'Bearer anthropic-access'
    && !anthropicRequest.headers['x-api-key']
    && anthropicRequest.headers['anthropic-beta'].includes('oauth-2025-04-20'),
'Claude subscription headers were wrong');

const openAiIdToken = unsignedJwt({
    email: 'fixture@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture' },
});
let callbackResponsePromise = null;
let openAiExchangeParams = null;
const openAiCallbackTokens = new MemoryProviderTokenStore();
const openAiCallbackManager = new ProviderAuthManager({
    tokenStore: openAiCallbackTokens,
    envLookup: () => '',
    openUri: (uri) => {
        const state = queryParameter(uri, 'state');
        callbackResponsePromise = new Promise((resolve, reject) => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                const session = new Soup.Session();
                const callbackMessage = Soup.Message.new(
                    'GET',
                    `http://localhost:1455/auth/callback?code=openai-callback-code&state=${encodeURIComponent(state)}`,
                );
                sendAndRead(session, callbackMessage).then((bytes) => {
                    resolve(new TextDecoder().decode(bytes.get_data()));
                }, reject);
                return GLib.SOURCE_REMOVE;
            });
        });
    },
    postToken: async (_url, params) => {
        openAiExchangeParams = params;
        return {
            access_token: 'openai-callback-access',
            refresh_token: 'openai-callback-refresh',
            id_token: openAiIdToken,
            expires_in: 3600,
        };
    },
});
const openAiCallbackStatus = await openAiCallbackManager.authenticate(
    'openai',
    'chatgpt-subscription',
    { providerName: 'OpenAI' },
);
const openAiCallbackResponse = await callbackResponsePromise;
assert(openAiCallbackStatus.configured
    && openAiExchangeParams.code === 'openai-callback-code',
'OpenAI loopback callback did not exchange and store its authorization code');
assert(openAiCallbackResponse.includes('Cusco authorization complete'),
    'OpenAI loopback callback closed before sending the browser success page');

const openAiTokens = new MemoryProviderTokenStore({
    'openai:chatgpt-subscription': {
        accessToken: 'openai-access',
        refreshToken: 'openai-refresh',
        idToken: openAiIdToken,
        tokenType: 'Bearer',
        accountId: 'account-fixture',
        accountLabel: 'fixture@example.com',
        expiresAt: Date.now() + 3600_000,
    },
});
const openAiManager = new ProviderAuthManager({
    tokenStore: openAiTokens,
    envLookup: () => '',
});
const openAiRequest = await openAiManager.authorizeRequest(
    'openai',
    'chatgpt-subscription',
    {
        operation: 'chat',
        url: 'https://api.openai.com/v1/responses',
        headers: {},
        body: {
            model: 'gpt-5.6-sol',
            stream: true,
            max_output_tokens: 4096,
            reasoning: { effort: 'high' },
            input: [{ role: 'developer', content: [{ type: 'input_text', text: 'Follow Cusco instructions.' }] }],
        },
        stream: true,
    },
);
assert(openAiRequest.url === 'https://chatgpt.com/backend-api/codex/responses',
    'ChatGPT subscription request endpoint was wrong');
assert(openAiRequest.headers['chatgpt-account-id'] === 'account-fixture'
    && openAiRequest.body.store === false
    && openAiRequest.body.stream === true
    && openAiRequest.body.instructions === 'Follow Cusco instructions.'
    && openAiRequest.body.max_output_tokens === undefined
    && openAiRequest.body.include.includes('reasoning.encrypted_content'),
'ChatGPT subscription request profile was incomplete');

let refreshCount = 0;
const grokTokens = new MemoryProviderTokenStore({
    'grok:grok-subscription': {
        accessToken: 'expired',
        refreshToken: 'grok-refresh',
        tokenType: 'Bearer',
        expiresAt: 1,
    },
});
const grokManager = new ProviderAuthManager({
    tokenStore: grokTokens,
    envLookup: () => '',
    now: () => 10_000,
    postToken: async (_url, params) => {
        refreshCount++;
        assert(params.grant_type === 'refresh_token', 'Expired OAuth token did not use refresh_token');
        await Promise.resolve();
        return {
            access_token: 'grok-refreshed',
            refresh_token: 'grok-refresh-rotated',
            expires_in: 3600,
        };
    },
});
const [grokRequestOne, grokRequestTwo] = await Promise.all([
    grokManager.authorizeRequest('grok', 'grok-subscription', {
        operation: 'chat', url: 'https://api.x.ai/v1/responses', headers: {}, body: {}, stream: true,
    }),
    grokManager.authorizeRequest('grok', 'grok-subscription', {
        operation: 'chat', url: 'https://api.x.ai/v1/responses', headers: {}, body: {}, stream: true,
    }),
]);
assert(refreshCount === 1, 'Concurrent provider requests did not share one token refresh');
assert(grokRequestOne.headers.Authorization === 'Bearer grok-refreshed'
    && grokRequestTwo.url === 'https://cli-chat-proxy.grok.com/v1/responses'
    && grokRequestTwo.headers['X-XAI-Token-Auth'] === 'xai-grok-cli',
'Grok subscription request profile was incomplete');

const geminiTokens = new MemoryProviderTokenStore({
    'gemini:google-oauth': {
        accessToken: 'google-access',
        refreshToken: 'google-refresh',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
    },
});
const geminiManager = new ProviderAuthManager({
    tokenStore: geminiTokens,
    envLookup: (name) => name === 'CUSCO_GEMINI_OAUTH_CLIENT_ID' ? 'cusco-client' : '',
});
const geminiRequest = await geminiManager.authorizeRequest(
    'gemini',
    'google-oauth',
    {
        operation: 'chat',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=must-not-leak',
        headers: {},
        body: {},
        stream: false,
    },
);
assert(geminiRequest.headers.Authorization === 'Bearer google-access'
    && !geminiRequest.url.includes('key='), 'Google OAuth request leaked an API key');

await anthropicManager.clear('anthropic', 'claude-subscription');
assert(!anthropicManager.getStatus('anthropic', 'claude-subscription').configured,
    'Disconnect did not clear the provider OAuth token');

print('Cusco provider auth smoke passed');
