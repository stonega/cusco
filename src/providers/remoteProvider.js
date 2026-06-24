import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import { ChatProvider } from './provider.js';

const DISPLAY_STREAM_DELAY_MS = 10;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 45;

function createUserVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

function getApiKey(config) {
    if (config.apiKey)
        return config.apiKey;

    const apiKey = GLib.getenv(config.apiKeyEnvVar);

    if (!apiKey)
        throw createUserVisibleError(
            `${config.name} requires ${config.apiKeyEnvVar}`,
            `${config.name} requires ${config.apiKeyEnvVar}.`,
        );

    return apiKey;
}

function delay(milliseconds) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export function streamChunks(text) {
    return text.match(/\S+\s*/g) ?? [text];
}

function messageContent(message) {
    return String(message.content ?? '');
}

function providerMessages(messages) {
    let hasUserMessage = false;

    return messages.filter((message) => {
        if (message.role === 'system')
            return true;

        if (message.role === 'user') {
            hasUserMessage = true;
            return true;
        }

        return hasUserMessage && message.role === 'assistant';
    });
}

function normalizeUrl(baseUrl, path) {
    return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function encodeJsonBody(body) {
    return new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)));
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

function createSession(url, timeoutSeconds) {
    const options = { timeout: timeoutSeconds };

    if (shouldBypassProxy(url))
        options.proxy_resolver = new Gio.SimpleProxyResolver({ default_proxy: null });

    return new Soup.Session(options);
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

function responseStatusCode(message) {
    const statusCode = Number(message.status_code);

    if (Number.isFinite(statusCode))
        return statusCode;

    try {
        return Number(message.get_status());
    } catch (error) {
        const match = String(error?.message ?? '').match(/^(\d+) is not a valid value for enumeration Status$/);

        if (match)
            return Number.parseInt(match[1], 10);

        throw error;
    }
}

async function postJson(url, headers, body, options = {}) {
    const {
        cancellable = null,
        providerName = 'Provider',
        timeoutSeconds = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    } = options;
    const session = createSession(url, timeoutSeconds);
    const message = Soup.Message.new('POST', url);

    message.request_headers.append('Content-Type', 'application/json');

    for (const [name, value] of Object.entries(headers))
        message.request_headers.append(name, value);

    message.set_request_body_from_bytes('application/json', encodeJsonBody(body));

    let bytes;

    try {
        bytes = await sendAndRead(session, message, cancellable);
    } catch (error) {
        if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
            error.userMessage = `${providerName} request was cancelled.`;
        else if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
            error.userMessage = `${providerName} did not respond within ${timeoutSeconds} seconds.`;

        throw error;
    }

    const responseText = new TextDecoder().decode(bytes.get_data());
    let responseJson = null;

    try {
        responseJson = JSON.parse(responseText);
    } catch (_error) {
        responseJson = null;
    }

    const status = responseStatusCode(message);

    if (status < 200 || status >= 300) {
        const messageText = responseJson?.error?.message ?? responseJson?.message ?? responseText;
        throw createUserVisibleError(`${providerName} request failed (${status}): ${messageText}`);
    }

    return responseJson;
}

async function getJson(url, headers, options = {}) {
    const {
        cancellable = null,
        providerName = 'Provider',
        timeoutSeconds = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    } = options;
    const session = createSession(url, timeoutSeconds);
    const message = Soup.Message.new('GET', url);

    for (const [name, value] of Object.entries(headers))
        message.request_headers.append(name, value);

    let bytes;

    try {
        bytes = await sendAndRead(session, message, cancellable);
    } catch (error) {
        if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
            error.userMessage = `${providerName} model discovery was cancelled.`;
        else if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
            error.userMessage = `${providerName} did not return models within ${timeoutSeconds} seconds.`;

        throw error;
    }

    const responseText = new TextDecoder().decode(bytes.get_data());
    let responseJson = null;

    try {
        responseJson = JSON.parse(responseText);
    } catch (_error) {
        responseJson = null;
    }

    const status = responseStatusCode(message);

    if (status < 200 || status >= 300) {
        const messageText = responseJson?.error?.message ?? responseJson?.message ?? responseText;
        throw createUserVisibleError(`${providerName} model discovery failed (${status}): ${messageText}`);
    }

    return responseJson;
}

async function* displayStream(text, cancellable = null) {
    for (const chunk of streamChunks(text)) {
        if (isCancelled(cancellable))
            return;

        await delay(DISPLAY_STREAM_DELAY_MS);

        if (isCancelled(cancellable))
            return;

        yield chunk;
    }
}

export function openAiMessages(messages) {
    return providerMessages(messages).map((message) => ({
        role: message.role === 'system' ? 'developer' : message.role,
        content: messageContent(message),
    }));
}

export function openAiCompatibleMessages(messages) {
    return providerMessages(messages).map((message) => ({
        role: message.role,
        content: messageContent(message),
    }));
}

export function anthropicPayloadMessages(messages) {
    const normalizedMessages = providerMessages(messages);
    const system = normalizedMessages
        .filter((message) => message.role === 'system')
        .map(messageContent)
        .join('\n\n');
    const conversationMessages = normalizedMessages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
            role: message.role,
            content: messageContent(message),
        }));

    return { system, messages: conversationMessages };
}

export function geminiPayload(messages) {
    const normalizedMessages = providerMessages(messages);
    const systemMessages = normalizedMessages
        .filter((message) => message.role === 'system')
        .map(messageContent)
        .join('\n\n');
    const contents = normalizedMessages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: messageContent(message) }],
        }));

    const payload = { contents };

    if (systemMessages)
        payload.systemInstruction = { parts: [{ text: systemMessages }] };

    return payload;
}

export function buildOpenAiResponsesBody(messages, modelId) {
    return {
        model: modelId,
        input: openAiMessages(messages),
    };
}

export function buildOpenAiCompatibleChatBody(messages, modelId) {
    return {
        model: modelId,
        messages: openAiCompatibleMessages(messages),
        stream: false,
    };
}

export function buildAnthropicMessagesBody(messages, modelId) {
    const { system, messages: conversationMessages } = anthropicPayloadMessages(messages);
    const body = {
        model: modelId,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages: conversationMessages,
    };

    if (system)
        body.system = system;

    return body;
}

export function buildGeminiGenerateContentBody(messages) {
    return geminiPayload(messages);
}

export function extractOpenAiText(response) {
    if (response.output_text)
        return response.output_text;

    const outputItems = response.output ?? [];
    const text = outputItems
        .flatMap((item) => item.content ?? [])
        .map((content) => content.text ?? content.output_text ?? '')
        .join('');

    if (text)
        return text;

    return response.choices?.[0]?.message?.content ?? '';
}

export function extractChatCompletionText(response) {
    return response.choices?.[0]?.message?.content ?? '';
}

export function extractAnthropicText(response) {
    return (response.content ?? [])
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('\n');
}

export function extractGeminiText(response) {
    return (response.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');
}

function normalizeDiscoveredModel(item) {
    const rawId = item?.id ?? item?.name;

    if (!rawId)
        return null;

    const id = String(rawId).replace(/^models\//, '');
    const name = item.display_name ?? item.displayName ?? item.name ?? item.id ?? id;

    return {
        id,
        name: String(name).replace(/^models\//, ''),
        description: item.description ?? 'Discovered model.',
    };
}

export function extractDiscoveredModels(response) {
    const items = response?.data ?? response?.models ?? [];

    if (!Array.isArray(items))
        return [];

    const models = [];
    const seenIds = new Set();

    for (const item of items) {
        if (Array.isArray(item?.supportedGenerationMethods)
            && !item.supportedGenerationMethods.includes('generateContent')) {
            continue;
        }

        const model = normalizeDiscoveredModel(item);

        if (!model || seenIds.has(model.id))
            continue;

        seenIds.add(model.id);
        models.push(model);
    }

    return models;
}

export async function discoverOpenAiCompatibleModels(config, options = {}) {
    const response = await getJson(
        normalizeUrl(config.baseUrl, '/models'),
        { Authorization: `Bearer ${getApiKey(config)}` },
        {
            cancellable: options.cancellable ?? null,
            providerName: config.name,
            timeoutSeconds: options.timeoutSeconds,
        },
    );

    return extractDiscoveredModels(response);
}

export async function discoverAnthropicModels(config, options = {}) {
    const response = await getJson(
        normalizeUrl(config.baseUrl, '/models'),
        {
            'x-api-key': getApiKey(config),
            'anthropic-version': '2023-06-01',
        },
        {
            cancellable: options.cancellable ?? null,
            providerName: config.name,
            timeoutSeconds: options.timeoutSeconds,
        },
    );

    return extractDiscoveredModels(response);
}

export async function discoverGeminiModels(config, options = {}) {
    const url = `${normalizeUrl(config.baseUrl, '/models')}?key=${encodeURIComponent(getApiKey(config))}`;
    const response = await getJson(url, {}, {
        cancellable: options.cancellable ?? null,
        providerName: config.name,
        timeoutSeconds: options.timeoutSeconds,
    });

    return extractDiscoveredModels(response);
}

class RemoteProvider extends ChatProvider {
    constructor(config) {
        super({
            id: config.id,
            name: config.name,
        });
        this._config = config;
    }

    async *streamChat(messages, options = {}) {
        const responseText = await this._complete(
            messages,
            options.model?.id ?? this._config.defaultModelId,
            options,
        );

        if (!responseText)
            throw new Error(`${this.name} returned an empty response`);

        yield* displayStream(responseText, options.cancellable ?? null);
    }
}

export class OpenAiResponsesProvider extends RemoteProvider {
    async _complete(messages, modelId, options = {}) {
        const response = await postJson(
            normalizeUrl(this._config.baseUrl, '/responses'),
            { Authorization: `Bearer ${getApiKey(this._config)}` },
            buildOpenAiResponsesBody(messages, modelId),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        );

        return extractOpenAiText(response);
    }
}

export class OpenAiCompatibleChatProvider extends RemoteProvider {
    async _complete(messages, modelId, options = {}) {
        const response = await postJson(
            normalizeUrl(this._config.baseUrl, this._config.chatPath ?? '/chat/completions'),
            { Authorization: `Bearer ${getApiKey(this._config)}` },
            buildOpenAiCompatibleChatBody(messages, modelId),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        );

        return extractChatCompletionText(response);
    }
}

export class AnthropicMessagesProvider extends RemoteProvider {
    async _complete(messages, modelId, options = {}) {
        const response = await postJson(
            normalizeUrl(this._config.baseUrl, '/messages'),
            {
                'x-api-key': getApiKey(this._config),
                'anthropic-version': '2023-06-01',
            },
            buildAnthropicMessagesBody(messages, modelId),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        );

        return extractAnthropicText(response);
    }
}

export class GeminiGenerateContentProvider extends RemoteProvider {
    async _complete(messages, modelId, options = {}) {
        const url = `${normalizeUrl(this._config.baseUrl, `/models/${modelId}:generateContent`)}?key=${encodeURIComponent(getApiKey(this._config))}`;
        const response = await postJson(url, {}, buildGeminiGenerateContentBody(messages), {
            cancellable: options.cancellable ?? null,
            providerName: this.name,
            timeoutSeconds: options.timeoutSeconds,
        });

        return extractGeminiText(response);
    }
}
