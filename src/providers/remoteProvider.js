import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import { ChatProvider } from './provider.js';
import {
    DEFAULT_MAX_CONTINUATION_TURNS,
    normalizeMaxOutputTokens,
} from './outputLimits.js';
import { getThinkingCapability, normalizeThinkingLevel } from './thinking.js';
import { normalizeTokenUsage } from './usage.js';

const DISPLAY_STREAM_DELAY_MS = 10;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 45;
const MAX_NETWORK_RECONNECTS = 5;
const NETWORK_RECONNECT_DELAY_MS = 250;
const CONTINUATION_PROMPT = [
    'Continue exactly where your previous assistant message stopped.',
    'Do not repeat completed text.',
    'Do not ask the user to reply "continue"; finish the requested work now.',
].join(' ');
const OPENAI_REASONING_EFFORTS = {
    off: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
};
const ANTHROPIC_DEFAULT_THINKING_BUDGETS = {
    auto: 2048,
    low: 1024,
    medium: 2048,
    high: 3072,
};
const SUPPORTED_GEMINI_MODEL_IDS = new Set([
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
]);
const MAX_NATIVE_TOOL_DESCRIPTION_CHARS = 1024;
const IMAGE_MIME_TYPES_BY_EXTENSION = new Map([
    ['.bmp', 'image/bmp'],
    ['.gif', 'image/gif'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
]);
const GEMINI_SCHEMA_FIELDS = new Set([
    'type',
    'format',
    'title',
    'description',
    'nullable',
    'enum',
    'maxItems',
    'minItems',
    'properties',
    'required',
    'minProperties',
    'maxProperties',
    'minLength',
    'maxLength',
    'pattern',
    'example',
    'anyOf',
    'propertyOrdering',
    'default',
    'items',
    'minimum',
    'maximum',
]);

function createUserVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

export function isTransientTlsError(error) {
    if (typeof error?.matches !== 'function')
        return false;

    return error.matches(Gio.TlsError, Gio.TlsError.HANDSHAKE)
        || error.matches(Gio.TlsError, Gio.TlsError.EOF);
}

const RETRYABLE_NETWORK_IO_ERRORS = [
    Gio.IOErrorEnum.TIMED_OUT,
    Gio.IOErrorEnum.HOST_NOT_FOUND,
    Gio.IOErrorEnum.HOST_UNREACHABLE,
    Gio.IOErrorEnum.NETWORK_UNREACHABLE,
    Gio.IOErrorEnum.CONNECTION_REFUSED,
    Gio.IOErrorEnum.CONNECTION_CLOSED,
    Gio.IOErrorEnum.NOT_CONNECTED,
    Gio.IOErrorEnum.BROKEN_PIPE,
    Gio.IOErrorEnum.PROXY_FAILED,
];

const RETRYABLE_INTERRUPTED_RESPONSE_IO_ERRORS = [
    Gio.IOErrorEnum.CONNECTION_CLOSED,
    Gio.IOErrorEnum.NOT_CONNECTED,
    Gio.IOErrorEnum.BROKEN_PIPE,
];

export function isNetworkError(error) {
    return isTransientTlsError(error)
        || RETRYABLE_NETWORK_IO_ERRORS.some((code) => isGioError(error, code));
}

function isRetryableInterruptedResponse(error) {
    return isTransientTlsError(error)
        || RETRYABLE_INTERRUPTED_RESPONSE_IO_ERRORS.some((code) => isGioError(error, code));
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

function imageMimeTypeForAttachment(attachment) {
    const explicitMimeType = String(attachment?.mimeType ?? attachment?.mime_type ?? '').trim().toLowerCase();

    if (explicitMimeType.startsWith('image/'))
        return explicitMimeType;

    const name = String(attachment?.name ?? attachment?.path ?? '').toLowerCase();
    const extension = [...IMAGE_MIME_TYPES_BY_EXTENSION.keys()].find((item) => name.endsWith(item));

    return extension ? IMAGE_MIME_TYPES_BY_EXTENSION.get(extension) : 'image/png';
}

function isSvgAttachment(attachment) {
    const explicitMimeType = String(attachment?.mimeType ?? attachment?.mime_type ?? '').trim().toLowerCase();

    if (explicitMimeType === 'image/svg+xml')
        return true;

    const name = String(attachment?.name ?? attachment?.path ?? '').toLowerCase();
    return name.endsWith('.svg');
}

function imageAttachments(message) {
    return (message?.attachments ?? []).filter((attachment) => {
        if (attachment?.kind !== 'image')
            return false;

        if (isSvgAttachment(attachment))
            return false;

        const path = String(attachment.path ?? '').trim();
        return Boolean(path) && GLib.file_test(path, GLib.FileTest.EXISTS);
    });
}

function encodedImageAttachment(attachment) {
    const [, contents] = GLib.file_get_contents(attachment.path);
    return {
        name: String(attachment.name ?? GLib.path_get_basename(attachment.path)),
        mimeType: imageMimeTypeForAttachment(attachment),
        data: GLib.base64_encode(contents),
    };
}

function encodedImageAttachments(message) {
    return imageAttachments(message).map(encodedImageAttachment);
}

function imageDataUrl(image) {
    return `data:${image.mimeType};base64,${image.data}`;
}

function providerMessages(messages) {
    let hasUserMessage = false;

    return messages.filter((message) => {
        if (message?.reasoning?.agentMode)
            return false;

        if (message.role === 'system')
            return true;

        if (message.role === 'user') {
            hasUserMessage = true;
            return true;
        }

        if (message.role === 'tool')
            return hasUserMessage;

        return hasUserMessage && message.role === 'assistant';
    });
}

function messageToolCalls(message) {
    return Array.isArray(message?.toolCalls)
        ? message.toolCalls.filter(call => String(call?.name ?? '').trim())
        : [];
}

function normalizeGeminiProviderParts(parts) {
    return Array.isArray(parts)
        ? parts
            .filter((part) => part && typeof part === 'object' && !Array.isArray(part))
            .map((part) => ({ ...part }))
        : [];
}

function messageGeminiProviderParts(message) {
    return normalizeGeminiProviderParts(
        message?.providerParts ?? message?.metadata?.geminiProviderParts,
    );
}

function toolArguments(input) {
    const source = String(input ?? '').trim();

    if (!source)
        return '{}';

    try {
        JSON.parse(source);
        return source;
    } catch (_error) {
        return JSON.stringify({ input: source });
    }
}

function toolInputObject(input) {
    try {
        const parsed = JSON.parse(toolArguments(input));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : { input: parsed };
    } catch (_error) {
        return { input: String(input ?? '') };
    }
}

function toolCallId(call, index = 0) {
    return String(call?.id ?? '').trim() || `cusco_tool_call_${index + 1}`;
}

function toolResultImageMessage(message, label) {
    return {
        ...message,
        role: 'user',
        content: `Post-action screenshot returned by ${label}.`,
        toolCalls: [],
    };
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

async function sendRequest(url, timeoutSeconds, cancellable, createMessage) {
    const session = createSession(url, timeoutSeconds);
    const message = createMessage();

    try {
        const bytes = await sendAndRead(session, message, cancellable);
        return { bytes, message };
    } catch (error) {
        error.providerResponseStarted = responseStatusCode(message) > 0;
        throw error;
    }
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
    let bytes;
    let message;

    try {
        ({ bytes, message } = await sendRequest(url, timeoutSeconds, cancellable, () => {
            const request = Soup.Message.new('POST', url);
            request.request_headers.append('Content-Type', 'application/json');

            for (const [name, value] of Object.entries(headers))
                request.request_headers.append(name, value);

            request.set_request_body_from_bytes('application/json', encodeJsonBody(body));
            return request;
        }));
    } catch (error) {
        if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
            error.userMessage = `${providerName} request was cancelled.`;
        else if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
            error.userMessage = `${providerName} did not respond within ${timeoutSeconds} seconds.`;
        else if (isTransientTlsError(error))
            error.userMessage = `${providerName} could not establish a secure connection. Try again.`;
        else if (isNetworkError(error))
            error.userMessage = `${providerName} could not connect. Check your network and try again.`;

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
    let bytes;
    let message;

    try {
        ({ bytes, message } = await sendRequest(url, timeoutSeconds, cancellable, () => {
            const request = Soup.Message.new('GET', url);

            for (const [name, value] of Object.entries(headers))
                request.request_headers.append(name, value);

            return request;
        }));
    } catch (error) {
        if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
            error.userMessage = `${providerName} model discovery was cancelled.`;
        else if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
            error.userMessage = `${providerName} did not return models within ${timeoutSeconds} seconds.`;
        else if (isTransientTlsError(error))
            error.userMessage = `${providerName} could not establish a secure connection. Try again.`;

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

function normalizeProviderResponse(response) {
    if (typeof response === 'string')
        return { text: response, reasoning: '', toolCalls: [], serverToolResults: [], providerParts: [] };

    if (!response || typeof response !== 'object')
        return { text: '', reasoning: '', toolCalls: [], serverToolResults: [], providerParts: [] };

    return {
        text: String(response.text ?? ''),
        reasoning: String(response.reasoning ?? ''),
        usage: normalizeTokenUsage(response.usage),
        finishReason: String(response.finishReason ?? ''),
        toolCalls: Array.isArray(response.toolCalls)
            ? response.toolCalls.map((toolCall) => {
                const thoughtSignature = toolCall?.thoughtSignature ?? toolCall?.thought_signature;

                return {
                    id: String(toolCall?.id ?? ''),
                    name: String(toolCall?.name ?? '').trim(),
                    input: String(toolCall?.input ?? ''),
                    ...(typeof thoughtSignature === 'string' && thoughtSignature
                        ? { thoughtSignature }
                        : {}),
                };
            }).filter((toolCall) => toolCall.name)
            : [],
        serverToolResults: Array.isArray(response.serverToolResults)
            ? response.serverToolResults.map((result) => ({
                name: ['x_search', 'google_maps', 'url_context'].includes(result?.name)
                    ? result.name
                    : 'search',
                label: String(result?.label ?? (result?.name === 'x_search' ? 'X Search' : 'Web Search')),
                query: String(result?.query ?? ''),
                results: deduplicateSearchResults(result?.results ?? []),
                providerId: String(result?.providerId ?? ''),
                providerName: String(result?.providerName ?? ''),
            }))
            : [],
        providerParts: normalizeGeminiProviderParts(response.providerParts),
    };
}

function normalizeFinishReason(reason) {
    return String(reason ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function stoppedForMaxOutput(reason) {
    return [
        'length',
        'max_tokens',
        'max_output_tokens',
        'token_limit',
        'output_token_limit',
    ].includes(normalizeFinishReason(reason));
}

function normalizeMaxContinuationTurns(value) {
    const turns = Number(value);

    if (!Number.isFinite(turns) || turns < 0)
        return DEFAULT_MAX_CONTINUATION_TURNS;

    return Math.min(5, Math.floor(turns));
}

function continuationMessages(messages, assistantText) {
    return [
        ...messages,
        {
            role: 'assistant',
            content: assistantText,
        },
        {
            role: 'user',
            content: CONTINUATION_PROMPT,
        },
    ];
}

function joinTextParts(parts) {
    return parts
        .map((part) => String(part ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
}

function compactToolDescription(tool) {
    const text = [
        tool.label ? `Label: ${tool.label}` : '',
        tool.description ?? '',
        tool.inputDescription ? `Input: ${tool.inputDescription}` : '',
    ].filter(Boolean).join('\n\n').trim();

    return text.length > MAX_NATIVE_TOOL_DESCRIPTION_CHARS
        ? `${text.slice(0, MAX_NATIVE_TOOL_DESCRIPTION_CHARS - 3)}...`
        : text;
}

function fallbackToolParameters(tool) {
    return {
        type: 'object',
        properties: {
            input: {
                type: 'string',
                description: tool.inputDescription
                    ? `Tool input. ${tool.inputDescription}`
                    : 'Tool input as text or JSON.',
            },
        },
        required: [],
        additionalProperties: true,
    };
}

function normalizeToolParameters(tool) {
    const schema = tool.inputSchema;

    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
        return fallbackToolParameters(tool);

    if (schema.type === 'object' || schema.properties)
        return {
            ...schema,
            type: 'object',
        };

    return fallbackToolParameters(tool);
}

function normalizeGeminiSchemaType(value) {
    if (Array.isArray(value)) {
        const nonNullTypes = value.filter((item) => item !== 'null');

        return {
            type: nonNullTypes.length > 0 ? String(nonNullTypes[0]) : null,
            nullable: value.includes('null'),
        };
    }

    return {
        type: value ? String(value) : null,
        nullable: false,
    };
}

function sanitizeGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
        return {};

    const sanitized = {};

    for (const [key, value] of Object.entries(schema)) {
        if (!GEMINI_SCHEMA_FIELDS.has(key))
            continue;

        if (key === 'type') {
            const normalized = normalizeGeminiSchemaType(value);

            if (normalized.type)
                sanitized.type = normalized.type;

            if (normalized.nullable)
                sanitized.nullable = true;

            continue;
        }

        if (key === 'properties') {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                continue;

            const properties = {};

            for (const [name, propertySchema] of Object.entries(value)) {
                const sanitizedProperty = sanitizeGeminiSchema(propertySchema);

                if (Object.keys(sanitizedProperty).length > 0)
                    properties[name] = sanitizedProperty;
            }

            if (Object.keys(properties).length > 0)
                sanitized.properties = properties;

            continue;
        }

        if (key === 'items') {
            const items = sanitizeGeminiSchema(value);

            if (Object.keys(items).length > 0)
                sanitized.items = items;

            continue;
        }

        if (key === 'anyOf') {
            if (!Array.isArray(value))
                continue;

            const anyOf = value
                .map((item) => sanitizeGeminiSchema(item))
                .filter((item) => Object.keys(item).length > 0);

            if (anyOf.length > 0)
                sanitized.anyOf = anyOf;

            continue;
        }

        if (key === 'enum' || key === 'required' || key === 'propertyOrdering') {
            if (Array.isArray(value))
                sanitized[key] = value.map((item) => String(item));

            continue;
        }

        sanitized[key] = value;
    }

    if (!sanitized.type && sanitized.properties)
        sanitized.type = 'object';

    if (!sanitized.type && sanitized.items)
        sanitized.type = 'array';

    return sanitized;
}

function normalizeGeminiToolParameters(tool) {
    return sanitizeGeminiSchema(normalizeToolParameters(tool));
}

function openAiCompatibleToolDefinitions(tools = []) {
    return (tools ?? [])
        .filter((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(String(tool?.name ?? '')))
        .map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: compactToolDescription(tool) || `Run ${tool.name}.`,
                parameters: normalizeToolParameters(tool),
            },
        }));
}

function openAiResponsesToolDefinitions(tools = []) {
    return openAiCompatibleToolDefinitions(tools).map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
}

function anthropicToolDefinitions(tools = []) {
    return (tools ?? [])
        .filter((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(String(tool?.name ?? '')))
        .map((tool) => ({
            name: tool.name,
            description: compactToolDescription(tool) || `Run ${tool.name}.`,
            input_schema: normalizeToolParameters(tool),
        }));
}

function geminiToolDefinitions(tools = []) {
    const declarations = (tools ?? [])
        .filter((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(String(tool?.name ?? '')))
        .map((tool) => ({
            name: tool.name,
            description: compactToolDescription(tool) || `Run ${tool.name}.`,
            parameters: normalizeGeminiToolParameters(tool),
        }));

    return declarations.length > 0
        ? [{ functionDeclarations: declarations }]
        : [];
}

function nativeSearchConfiguration(options = {}, api = '') {
    if (options.disableNativeSearch)
        return null;

    const tools = options.tools ?? [];

    if (!tools.some((tool) => tool?.name === 'search'))
        return null;

    const configuration = options.model?.nativeSearch === false
        ? null
        : options.model?.nativeSearch ?? options.provider?.nativeSearch ?? options.config?.nativeSearch;

    if (!configuration || configuration.api !== api)
        return null;

    return configuration;
}

function clientToolsForSearchConfiguration(tools = [], configuration = null) {
    return configuration
        ? tools.filter((tool) => tool?.name !== 'search')
        : tools;
}

function openAiNativeSearchToolDefinitions(configuration) {
    return (configuration?.tools ?? []).map((type) => ({ type }));
}

function anthropicNativeSearchToolDefinitions(configuration) {
    if (!configuration)
        return [];

    return [{
        type: configuration.version ?? 'web_search_20250305',
        name: 'web_search',
        max_uses: configuration.maxUses ?? 5,
    }];
}

function geminiNativeSearchToolDefinitions(configuration) {
    const definitions = {
        google_search: { googleSearch: {} },
        google_maps: { googleMaps: {} },
        url_context: { urlContext: {} },
    };

    return (configuration?.tools ?? [])
        .map((tool) => definitions[String(tool)] ?? null)
        .filter(Boolean);
}

function zaiNativeSearchToolDefinitions(configuration) {
    if (!configuration)
        return [];

    return [{
        type: 'web_search',
        web_search: {
            enable: true,
            search_engine: configuration.searchEngine ?? 'search-prime',
            search_result: true,
            count: configuration.count ?? 5,
            search_recency_filter: 'noLimit',
            content_size: 'high',
        },
    }];
}

function parseToolArgumentsInput(argumentsText) {
    const text = String(argumentsText ?? '').trim();

    if (!text)
        return '';

    try {
        const parsed = JSON.parse(text);

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const keys = Object.keys(parsed);

            if (keys.length === 1 && Object.hasOwn(parsed, 'input'))
                return String(parsed.input ?? '');

            return JSON.stringify(parsed);
        }

        return String(parsed ?? '');
    } catch (_error) {
        return text;
    }
}

function toolInputFromValue(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);

        if (keys.length === 1 && Object.hasOwn(value, 'input'))
            return String(value.input ?? '');

        return JSON.stringify(value);
    }

    return String(value ?? '');
}

function resultTitleFromUrl(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() ?? url;
    } catch (_error) {
        return url;
    }
}

function normalizeSearchResult(result) {
    const url = String(result?.url ?? result?.link ?? result?.uri ?? '').trim();

    if (!url)
        return null;

    return {
        title: String(result?.title ?? result?.name ?? resultTitleFromUrl(url)).trim() || resultTitleFromUrl(url),
        url,
        snippet: String(result?.snippet ?? result?.description ?? result?.content ?? result?.cited_text ?? '').trim(),
        ...(result?.publishedAt || result?.publish_date || result?.page_age
            ? { publishedAt: String(result.publishedAt ?? result.publish_date ?? result.page_age) }
            : {}),
    };
}

function deduplicateSearchResults(results) {
    const seenUrls = new Set();

    return results
        .map(normalizeSearchResult)
        .filter((result) => {
            if (!result || seenUrls.has(result.url))
                return false;

            seenUrls.add(result.url);
            return true;
        });
}

function openAiResponseCitations(response) {
    const results = [];

    for (const citation of response?.citations ?? []) {
        if (typeof citation === 'string')
            results.push({ url: citation });
        else
            results.push(citation);
    }

    for (const item of response?.output ?? []) {
        for (const content of item?.content ?? []) {
            for (const annotation of content?.annotations ?? []) {
                const citation = annotation?.url_citation ?? annotation;

                if (citation?.url) {
                    results.push({
                        url: citation.url,
                        title: citation.title,
                        snippet: citation.cited_text,
                    });
                }
            }
        }
    }

    return deduplicateSearchResults(results);
}

function searchCallArguments(item) {
    const action = item?.action ?? {};
    let args = item?.arguments ?? action;

    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch (_error) {
            args = { query: args };
        }
    }

    const queries = Array.isArray(args?.queries)
        ? args.queries
        : Array.isArray(action?.queries)
            ? action.queries
            : [];
    const query = String(args?.query ?? action?.query ?? '').trim();

    return {
        query: queries.map(String).filter(Boolean).join(' · ') || query,
        sources: deduplicateSearchResults([
            ...(Array.isArray(args?.sources) ? args.sources : []),
            ...(Array.isArray(action?.sources) ? action.sources : []),
        ]),
    };
}

function isXResult(result) {
    return /^https?:\/\/(?:www\.)?x\.com\//i.test(result?.url ?? '');
}

export function extractOpenAiServerToolResults(response, nativeSearchTools = []) {
    const calls = (response?.output ?? []).filter((item) => (
        item?.type === 'web_search_call' || item?.type === 'x_search_call'
    ));
    const citations = openAiResponseCitations(response);

    if (calls.length === 0 && citations.length === 0)
        return [];

    // xAI's Responses API always exposes a top-level `citations` array, but
    // does not guarantee a separate search-call item for every server-side
    // invocation. Preserve those citations as tool results even in that
    // shape so the native search is visible in Cusco's transcript/UI.
    if (calls.length === 0) {
        const configuredTools = nativeSearchTools
            .map(String)
            .filter((tool) => tool === 'web_search' || tool === 'x_search');

        if (configuredTools.length === 1) {
            const name = configuredTools[0] === 'x_search' ? 'x_search' : 'search';

            return [{
                name,
                label: name === 'x_search' ? 'X Search' : 'Web Search',
                query: '',
                results: citations,
            }];
        }

        const xResults = citations.filter(isXResult);
        const webResults = citations.filter((result) => !isXResult(result));
        const groups = [];

        if (webResults.length > 0)
            groups.push({ name: 'search', label: 'Web Search', results: webResults });

        if (xResults.length > 0)
            groups.push({ name: 'x_search', label: 'X Search', results: xResults });

        return groups.length > 0
            ? groups.map((group) => ({ ...group, query: '' }))
            : [{ name: 'search', label: 'Web Search', query: '', results: citations }];
    }

    const hasWebSearch = calls.some((item) => item.type === 'web_search_call');
    const hasXSearch = calls.some((item) => item.type === 'x_search_call');
    const grouped = new Map();

    for (const call of calls) {
        const name = call.type === 'x_search_call' ? 'x_search' : 'search';
        const current = grouped.get(name) ?? { queries: [], results: [] };
        const args = searchCallArguments(call);

        if (args.query)
            current.queries.push(args.query);

        current.results.push(...args.sources);
        grouped.set(name, current);
    }

    return [...grouped.entries()].map(([name, value]) => {
        let fallbackResults = citations;

        if (hasWebSearch && hasXSearch)
            fallbackResults = citations.filter((result) => name === 'x_search' ? isXResult(result) : !isXResult(result));

        return {
            name,
            label: name === 'x_search' ? 'X Search' : 'Web Search',
            query: [...new Set(value.queries)].join(' · '),
            results: deduplicateSearchResults(value.results.length > 0 ? value.results : fallbackResults),
        };
    });
}

export function extractAnthropicServerToolResults(response) {
    const uses = new Map((response?.content ?? [])
        .filter((content) => content?.type === 'server_tool_use' && content?.name === 'web_search')
        .map((content) => [String(content.id ?? ''), content]));
    const results = [];

    for (const content of response?.content ?? []) {
        if (content?.type !== 'web_search_tool_result')
            continue;

        const use = uses.get(String(content.tool_use_id ?? ''));
        const items = Array.isArray(content.content) ? content.content : [];

        results.push({
            name: 'search',
            label: 'Web Search',
            query: String(use?.input?.query ?? '').trim(),
            results: deduplicateSearchResults(items.filter((item) => item?.type === 'web_search_result')),
        });
    }

    if (results.length === 0 && uses.size > 0) {
        for (const use of uses.values()) {
            results.push({
                name: 'search',
                label: 'Web Search',
                query: String(use?.input?.query ?? '').trim(),
                results: [],
            });
        }
    }

    return results;
}

export function extractGeminiServerToolResults(response) {
    const candidate = response?.candidates?.[0] ?? {};
    const metadata = candidate.groundingMetadata ?? candidate.grounding_metadata ?? {};
    const queries = metadata.webSearchQueries ?? metadata.web_search_queries ?? [];
    const chunks = metadata.groundingChunks ?? metadata.grounding_chunks ?? [];
    const webResults = chunks.map((chunk) => {
        const web = chunk?.web ?? chunk?.retrievedContext ?? chunk?.retrieved_context;

        return web ? {
            url: web.uri ?? web.url,
            title: web.title,
            snippet: web.text,
        } : null;
    }).filter(Boolean);
    const mapsResults = chunks.map((chunk) => {
        const maps = chunk?.maps;

        return maps ? {
            url: maps.uri ?? maps.url ?? maps.googleMapsUri ?? maps.google_maps_uri,
            title: maps.title ?? maps.name,
            snippet: maps.text ?? (maps.placeId ?? maps.place_id
                ? `Google Maps place ${maps.placeId ?? maps.place_id}`
                : ''),
        } : null;
    }).filter(Boolean);
    const results = [];

    if (webResults.length > 0 || (queries.length > 0 && mapsResults.length === 0)) {
        results.push({
            name: 'search',
            label: 'Google Search',
            query: queries.map(String).filter(Boolean).join(' · '),
            results: deduplicateSearchResults(webResults),
        });
    }

    if (mapsResults.length > 0) {
        results.push({
            name: 'google_maps',
            label: 'Google Maps',
            query: queries.map(String).filter(Boolean).join(' · '),
            results: deduplicateSearchResults(mapsResults),
        });
    }

    const urlContextMetadata = candidate.urlContextMetadata ?? candidate.url_context_metadata ?? {};
    const urlMetadata = urlContextMetadata.urlMetadata ?? urlContextMetadata.url_metadata ?? [];
    const urlAttempts = urlMetadata.map((item) => {
        const url = item?.retrievedUrl ?? item?.retrieved_url;
        const status = item?.urlRetrievalStatus ?? item?.url_retrieval_status;

        return url ? {
            url,
            status: status ? String(status) : '',
        } : null;
    }).filter(Boolean);
    const urlResults = urlAttempts
        .filter((item) => !item.status || /(?:^|_)SUCCESS$/i.test(item.status))
        .map((item) => ({
            url: item.url,
            snippet: item.status,
        }));

    if (urlAttempts.length > 0) {
        results.push({
            name: 'url_context',
            label: 'URL Context',
            query: urlAttempts.map((item) => item.url).join(' · '),
            results: deduplicateSearchResults(urlResults),
        });
    }

    return results;
}

export function extractChatCompletionServerToolResults(response) {
    const items = response?.web_search ?? response?.webSearch ?? [];

    if (!Array.isArray(items) || items.length === 0)
        return [];

    return [{
        name: 'search',
        label: 'Web Search',
        query: '',
        results: deduplicateSearchResults(items),
    }];
}

function appendSearchSources(text, serverToolResults) {
    const sourceResults = new Map();

    for (const toolResult of serverToolResults ?? []) {
        for (const rawResult of toolResult?.results ?? []) {
            const result = normalizeSearchResult(rawResult);

            if (!result)
                continue;

            const existing = sourceResults.get(result.url);
            const attribution = toolResult?.name === 'google_maps' ? 'Google Maps' : '';
            sourceResults.set(result.url, {
                ...(existing ?? result),
                attribution: attribution || existing?.attribution || '',
            });
        }
    }

    const missingSources = [...sourceResults.values()].filter((result) => (
        result.attribution === 'Google Maps' || !String(text ?? '').includes(result.url)
    ));

    if (missingSources.length === 0)
        return String(text ?? '');

    const sourceList = missingSources
        .map((result) => `- [${result.title}](${result.url})${result.attribution ? ` — ${result.attribution}` : ''}`)
        .join('\n');

    return `${String(text ?? '').trim()}\n\nSources:\n${sourceList}`.trim();
}

export function extractOpenAiToolCalls(response) {
    const outputCalls = (response?.output ?? [])
        .filter((item) => item?.type === 'function_call')
        .map((item) => ({
            id: String(item.call_id ?? item.id ?? ''),
            name: String(item.name ?? '').trim(),
            input: parseToolArgumentsInput(item.arguments),
        }));
    const chatCalls = extractChatCompletionToolCalls(response);

    return [...outputCalls, ...chatCalls].filter((toolCall) => toolCall.name);
}

export function extractChatCompletionToolCalls(response) {
    const message = response?.choices?.[0]?.message ?? {};
    const nativeToolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
    const functionCall = message.function_call
        ? [{ id: '', function: message.function_call }]
        : [];

    return [...nativeToolCalls, ...functionCall]
        .map((toolCall) => {
            const call = toolCall.function ?? toolCall;
            const name = String(call?.name ?? '').trim();

            if (!name)
                return null;

            return {
                id: String(toolCall.id ?? ''),
                name,
                input: parseToolArgumentsInput(call.arguments),
            };
        })
        .filter(Boolean);
}

export function extractAnthropicToolCalls(response) {
    return (response?.content ?? [])
        .filter((content) => content?.type === 'tool_use')
        .map((content) => ({
            id: String(content.id ?? ''),
            name: String(content.name ?? '').trim(),
            input: toolInputFromValue(content.input),
        }))
        .filter((toolCall) => toolCall.name);
}

export function extractGeminiToolCalls(response) {
    return (response?.candidates?.[0]?.content?.parts ?? [])
        .map((part) => {
            const call = part.functionCall ?? part.function_call ?? null;

            if (!call)
                return null;

            const thoughtSignature = part.thoughtSignature ?? part.thought_signature;

            return {
                id: String(call.id ?? ''),
                name: String(call.name ?? '').trim(),
                input: toolInputFromValue(call.args ?? call.arguments ?? {}),
                ...(typeof thoughtSignature === 'string' && thoughtSignature
                    ? { thoughtSignature }
                    : {}),
            };
        })
        .filter(Boolean)
        .filter((toolCall) => toolCall.name);
}

function providerSupportsImageAttachments(provider) {
    return provider?.supportsImageAttachments !== false;
}

export function openAiMessages(messages) {
    const output = [];

    for (const message of providerMessages(messages)) {
        const toolCalls = messageToolCalls(message);

        if (message.role === 'assistant' && toolCalls.length > 0) {
            const content = messageContent(message);

            if (content) {
                output.push({
                    role: 'assistant',
                    content,
                });
            }

            toolCalls.forEach((call, index) => {
                output.push({
                    type: 'function_call',
                    call_id: toolCallId(call, index),
                    name: call.name,
                    arguments: toolArguments(call.input),
                });
            });
            continue;
        }

        if (message.role === 'tool') {
            output.push({
                type: 'function_call_output',
                call_id: String(message.toolCallId ?? '').trim() || 'cusco_tool_call_1',
                output: messageContent(message),
            });

            if (imageAttachments(message).length > 0) {
                output.push({
                    role: 'user',
                    content: openAiContent(
                        toolResultImageMessage(message, message.toolName ?? 'computer tool'),
                        { responses: true },
                    ),
                });
            }
            continue;
        }

        output.push({
            role: message.role === 'system' ? 'developer' : message.role,
            content: openAiContent(message, { responses: true }),
        });
    }

    return output;
}

export function openAiCompatibleMessages(messages, options = {}) {
    const includeImages = providerSupportsImageAttachments(options.provider ?? options.config);
    const output = [];

    for (const message of providerMessages(messages)) {
        const toolCalls = messageToolCalls(message);

        if (message.role === 'assistant' && toolCalls.length > 0) {
            output.push({
                role: 'assistant',
                content: messageContent(message) || null,
                tool_calls: toolCalls.map((call, index) => ({
                    id: toolCallId(call, index),
                    type: 'function',
                    function: {
                        name: call.name,
                        arguments: toolArguments(call.input),
                    },
                })),
            });
            continue;
        }

        if (message.role === 'tool') {
            output.push({
                role: 'tool',
                tool_call_id: String(message.toolCallId ?? '').trim() || 'cusco_tool_call_1',
                name: String(message.toolName ?? '').trim() || undefined,
                content: messageContent(message),
            });

            if (includeImages && imageAttachments(message).length > 0) {
                output.push({
                    role: 'user',
                    content: openAiContent(
                        toolResultImageMessage(message, message.toolName ?? 'computer tool'),
                        { includeImages: true },
                    ),
                });
            }
            continue;
        }

        output.push({
            role: message.role,
            content: openAiContent(message, { includeImages }),
        });
    }

    return output;
}

export function anthropicPayloadMessages(messages) {
    const normalizedMessages = providerMessages(messages);
    const system = normalizedMessages
        .filter((message) => message.role === 'system')
        .map(messageContent)
        .join('\n\n');
    const conversationMessages = normalizedMessages
        .filter((message) => (
            message.role === 'user'
            || message.role === 'assistant'
            || message.role === 'tool'
        ))
        .map((message) => {
            const toolCalls = messageToolCalls(message);

            if (message.role === 'assistant' && toolCalls.length > 0) {
                const text = messageContent(message);
                return {
                    role: 'assistant',
                    content: [
                        ...(text ? [{ type: 'text', text }] : []),
                        ...toolCalls.map((call, index) => ({
                            type: 'tool_use',
                            id: toolCallId(call, index),
                            name: call.name,
                            input: toolInputObject(call.input),
                        })),
                    ],
                };
            }

            if (message.role === 'tool') {
                return {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: String(message.toolCallId ?? '').trim() || 'cusco_tool_call_1',
                        content: anthropicContent(message),
                    }],
                };
            }

            return {
                role: message.role,
                content: anthropicContent(message),
            };
        });

    return { system, messages: conversationMessages };
}

export function geminiPayload(messages) {
    const normalizedMessages = providerMessages(messages);
    const systemMessages = normalizedMessages
        .filter((message) => message.role === 'system')
        .map(messageContent)
        .join('\n\n');
    const conversationMessages = normalizedMessages
        .filter((message) => (
            message.role === 'user'
            || message.role === 'assistant'
            || message.role === 'tool'
        ));
    const contents = [];
    let previousMessageWasTool = false;

    for (const message of conversationMessages) {
        const role = message.role === 'assistant' ? 'model' : 'user';
        const parts = geminiParts(message);

        if (message.role === 'tool' && previousMessageWasTool)
            contents.at(-1).parts.push(...parts);
        else
            contents.push({ role, parts });

        previousMessageWasTool = message.role === 'tool';
    }

    const payload = { contents };

    if (systemMessages)
        payload.systemInstruction = { parts: [{ text: systemMessages }] };

    return payload;
}

function openAiContent(message, options = {}) {
    const images = options.includeImages === false
        ? []
        : encodedImageAttachments(message);

    if (images.length === 0)
        return messageContent(message);

    const textType = options.responses ? 'input_text' : 'text';
    const imageType = options.responses ? 'input_image' : 'image_url';
    const text = messageContent(message);
    const parts = [];

    if (text)
        parts.push({ type: textType, text });

    for (const image of images) {
        if (options.responses) {
            parts.push({
                type: imageType,
                image_url: imageDataUrl(image),
            });
        } else {
            parts.push({
                type: imageType,
                image_url: {
                    url: imageDataUrl(image),
                },
            });
        }
    }

    return parts;
}

function anthropicContent(message) {
    const images = encodedImageAttachments(message);

    if (images.length === 0)
        return messageContent(message);

    const parts = images.map((image) => ({
        type: 'image',
        source: {
            type: 'base64',
            media_type: image.mimeType,
            data: image.data,
        },
    }));
    const text = messageContent(message);

    if (text)
        parts.push({ type: 'text', text });

    return parts;
}

function geminiParts(message) {
    const providerParts = messageGeminiProviderParts(message);

    if (message.role === 'assistant' && providerParts.length > 0)
        return providerParts;

    const parts = [];
    const text = messageContent(message);

    if (message.role === 'tool') {
        const id = String(message.toolCallId ?? '');
        parts.push({
            functionResponse: {
                name: String(message.toolName ?? '').trim() || 'unknown_tool',
                response: {
                    output: text,
                },
                ...(id ? { id } : {}),
            },
        });

        for (const image of encodedImageAttachments(message)) {
            parts.push({
                inline_data: {
                    mime_type: image.mimeType,
                    data: image.data,
                },
            });
        }

        return parts;
    }

    if (text)
        parts.push({ text });

    for (const call of messageToolCalls(message)) {
        const id = String(call.id ?? '');
        const thoughtSignature = call.thoughtSignature ?? call.thought_signature;
        const part = {
            functionCall: {
                name: call.name,
                args: toolInputObject(call.input),
                ...(id ? { id } : {}),
            },
        };

        if (typeof thoughtSignature === 'string' && thoughtSignature)
            part.thoughtSignature = thoughtSignature;

        parts.push(part);
    }

    for (const image of encodedImageAttachments(message)) {
        parts.push({
            inline_data: {
                mime_type: image.mimeType,
                data: image.data,
            },
        });
    }

    return parts.length > 0 ? parts : [{ text: '' }];
}

function getRequestedThinkingConfig(config, model, level) {
    const capability = getThinkingCapability(config, model);

    if (!capability)
        return null;

    const thinkingLevel = normalizeThinkingLevel(level);

    if (!capability.levels.includes(thinkingLevel))
        return null;

    return {
        ...capability,
        level: thinkingLevel,
    };
}

function buildOpenAiReasoningConfig(config, model, level) {
    const thinking = getRequestedThinkingConfig(config, model, level);

    if (!thinking || thinking.api !== 'openai-responses')
        return null;

    if (thinking.level === 'off')
        return { effort: OPENAI_REASONING_EFFORTS.off };

    const reasoning = {};
    const effort = OPENAI_REASONING_EFFORTS[thinking.level];

    if (effort)
        reasoning.effort = effort;

    if (thinking.summary)
        reasoning.summary = thinking.summary;

    return Object.keys(reasoning).length > 0 ? reasoning : null;
}

function buildAnthropicThinkingConfig(config, model, level) {
    const thinking = getRequestedThinkingConfig(config, model, level);

    if (!thinking)
        return null;

    if (thinking.level === 'off')
        return { thinking: { type: 'disabled' } };

    if (thinking.api === 'anthropic-adaptive') {
        const request = {
            thinking: {
                type: 'adaptive',
                display: thinking.display ?? 'summarized',
            },
        };

        if (thinking.level !== 'auto')
            request.outputConfig = { effort: thinking.level };

        return request;
    }

    if (thinking.api === 'anthropic-budget') {
        const budgets = thinking.budgets ?? ANTHROPIC_DEFAULT_THINKING_BUDGETS;
        const budget = budgets[thinking.level] ?? budgets.medium ?? ANTHROPIC_DEFAULT_THINKING_BUDGETS.medium;

        return {
            thinking: {
                type: 'enabled',
                budget_tokens: budget,
                display: thinking.display ?? 'summarized',
            },
        };
    }

    return null;
}

function buildGeminiThinkingConfig(config, model, level) {
    const thinking = getRequestedThinkingConfig(config, model, level);

    if (!thinking)
        return null;

    const request = {};

    if (thinking.includeThoughts !== false && thinking.level !== 'off')
        request.includeThoughts = true;

    if (thinking.api === 'gemini-thinking-level') {
        if (thinking.level !== 'auto')
            request.thinkingLevel = thinking.level;

        return Object.keys(request).length > 0 ? request : null;
    }

    return null;
}

function buildOpenAiCompatibleThinkingConfig(config, model, level) {
    const thinking = getRequestedThinkingConfig(config, model, level);

    if (!thinking)
        return null;

    if (thinking.api === 'kimi-thinking') {
        if (thinking.level === 'off')
            return { thinking: { type: 'disabled' } };

        return {
            thinking: {
                type: 'enabled',
                keep: thinking.keep ?? 'all',
            },
        };
    }

    if (thinking.api === 'kimi-k3-reasoning')
        return { reasoning_effort: thinking.level };

    if (thinking.api === 'deepseek-thinking') {
        if (thinking.level === 'off')
            return { thinking: { type: 'disabled' } };

        const request = { type: 'enabled' };

        if (thinking.level === 'high' || thinking.level === 'max')
            request.reasoning_effort = thinking.level;

        return { thinking: request };
    }

    if (thinking.api === 'zai-thinking') {
        if (thinking.level === 'off')
            return { thinking: { type: 'disabled' } };

        const request = {
            thinking: { type: 'enabled' },
        };

        if (thinking.supportsReasoningEffort && (thinking.level === 'high' || thinking.level === 'max'))
            request.reasoning_effort = thinking.level;

        return request;
    }

    if (thinking.api === 'xai-reasoning') {
        const effort = thinking.level === 'off'
            ? thinking.offEffort ?? 'none'
            : thinking.level;

        return {
            reasoning: { effort },
        };
    }

    return null;
}

export function buildOpenAiResponsesBody(messages, modelId, options = {}) {
    const body = {
        model: modelId,
        input: openAiMessages(messages),
        max_output_tokens: normalizeMaxOutputTokens(options.maxOutputTokens),
    };

    const provider = options.provider ?? options.config;
    const reasoning = buildOpenAiReasoningConfig(provider, options.model, options.thinkingLevel)
        ?? buildOpenAiCompatibleThinkingConfig(provider, options.model, options.thinkingLevel)?.reasoning;

    if (reasoning)
        body.reasoning = reasoning;

    const nativeSearch = nativeSearchConfiguration(options, 'openai-responses');
    const clientTools = clientToolsForSearchConfiguration(options.tools, nativeSearch);
    const tools = [
        ...openAiNativeSearchToolDefinitions(nativeSearch),
        ...openAiResponsesToolDefinitions(clientTools),
    ];

    if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }

    if (nativeSearch?.includeSources)
        body.include = ['web_search_call.action.sources'];

    return body;
}

export function buildOpenAiCompatibleChatBody(messages, modelId, options = {}) {
    const provider = options.provider ?? options.config;
    const thinkingCapability = getThinkingCapability(provider, options.model);
    const maxOutputTokensParameter = thinkingCapability?.maxOutputTokensParameter === 'max_completion_tokens'
        ? 'max_completion_tokens'
        : 'max_tokens';
    const body = {
        model: modelId,
        messages: openAiCompatibleMessages(messages, options),
        stream: false,
    };
    body[maxOutputTokensParameter] = normalizeMaxOutputTokens(options.maxOutputTokens);
    const thinking = buildOpenAiCompatibleThinkingConfig(provider, options.model, options.thinkingLevel);
    const nativeSearch = nativeSearchConfiguration(options, 'zai-chat-completions');
    const clientTools = clientToolsForSearchConfiguration(options.tools, nativeSearch);
    const tools = [
        ...zaiNativeSearchToolDefinitions(nativeSearch),
        ...openAiCompatibleToolDefinitions(clientTools),
    ];

    if (thinking)
        Object.assign(body, thinking);

    if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }

    return body;
}

export function buildAnthropicMessagesBody(messages, modelId, options = {}) {
    const { system, messages: conversationMessages } = anthropicPayloadMessages(messages);
    const thinkingConfig = buildAnthropicThinkingConfig(
        options.provider ?? options.config,
        options.model,
        options.thinkingLevel,
    );
    const body = {
        model: modelId,
        max_tokens: normalizeMaxOutputTokens(options.maxOutputTokens),
        messages: conversationMessages,
    };

    if (system)
        body.system = system;

    if (thinkingConfig) {
        body.thinking = thinkingConfig.thinking;

        if (thinkingConfig.outputConfig)
            body.output_config = thinkingConfig.outputConfig;

        if (Number.isFinite(body.thinking.budget_tokens) && body.thinking.budget_tokens >= body.max_tokens)
            body.max_tokens = body.thinking.budget_tokens + 1024;
    }

    const nativeSearch = nativeSearchConfiguration(options, 'anthropic-messages');
    const clientTools = clientToolsForSearchConfiguration(options.tools, nativeSearch);
    const tools = [
        ...anthropicNativeSearchToolDefinitions(nativeSearch),
        ...anthropicToolDefinitions(clientTools),
    ];

    if (tools.length > 0)
        body.tools = tools;

    return body;
}

export function buildGeminiGenerateContentBody(messages, options = {}) {
    const payload = geminiPayload(messages);
    const thinking = buildGeminiThinkingConfig(options.provider ?? options.config, options.model, options.thinkingLevel);

    payload.generationConfig = {
        maxOutputTokens: normalizeMaxOutputTokens(options.maxOutputTokens),
    };

    if (thinking)
        payload.generationConfig.thinkingConfig = thinking;

    const nativeSearch = nativeSearchConfiguration(options, 'gemini-generate-content');
    const clientTools = clientToolsForSearchConfiguration(options.tools, nativeSearch);
    const tools = [
        ...geminiNativeSearchToolDefinitions(nativeSearch),
        ...geminiToolDefinitions(clientTools),
    ];

    if (tools.length > 0)
        payload.tools = tools;

    if (nativeSearch) {
        payload.toolConfig = {
            includeServerSideToolInvocations: true,
            ...(clientTools.length > 0
                ? { functionCallingConfig: { mode: 'VALIDATED' } }
                : {}),
        };
    }

    return payload;
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

export function extractOpenAiReasoning(response) {
    return joinTextParts((response.output ?? [])
        .filter((item) => item.type === 'reasoning')
        .flatMap((item) => item.summary ?? [])
        .map((summary) => summary.text ?? summary.content ?? ''));
}

export function extractOpenAiUsage(response) {
    return normalizeTokenUsage(response.usage);
}

export function extractOpenAiFinishReason(response) {
    if (response.incomplete_details?.reason)
        return response.incomplete_details.reason;

    const incompleteOutput = (response.output ?? []).find((item) => item.incomplete_details?.reason);

    return incompleteOutput?.incomplete_details?.reason
        ?? response.choices?.[0]?.finish_reason
        ?? '';
}

export function extractOpenAiResponse(response, options = {}) {
    const serverToolResults = extractOpenAiServerToolResults(
        response,
        options.provider?.nativeSearch?.tools ?? options.nativeSearchTools ?? [],
    );

    return {
        text: appendSearchSources(extractOpenAiText(response), serverToolResults),
        reasoning: extractOpenAiReasoning(response),
        usage: extractOpenAiUsage(response),
        finishReason: extractOpenAiFinishReason(response),
        toolCalls: extractOpenAiToolCalls(response),
        serverToolResults,
    };
}

export function extractChatCompletionText(response) {
    return response.choices?.[0]?.message?.content ?? '';
}

export function extractChatCompletionReasoning(response) {
    const message = response.choices?.[0]?.message ?? {};
    return joinTextParts([
        message.reasoning_content,
        message.reasoning,
        message.reasoning_summary,
    ]);
}

export function extractChatCompletionUsage(response) {
    return normalizeTokenUsage(response.usage);
}

export function extractChatCompletionFinishReason(response) {
    return response.choices?.[0]?.finish_reason ?? '';
}

export function extractChatCompletionResponse(response) {
    const serverToolResults = extractChatCompletionServerToolResults(response);

    return {
        text: appendSearchSources(extractChatCompletionText(response), serverToolResults),
        reasoning: extractChatCompletionReasoning(response),
        usage: extractChatCompletionUsage(response),
        finishReason: extractChatCompletionFinishReason(response),
        toolCalls: extractChatCompletionToolCalls(response),
        serverToolResults,
    };
}

export function extractAnthropicText(response) {
    return (response.content ?? [])
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('\n');
}

export function extractAnthropicReasoning(response) {
    return joinTextParts((response.content ?? [])
        .filter((content) => content.type === 'thinking')
        .map((content) => content.thinking ?? content.summary ?? ''));
}

export function extractAnthropicUsage(response) {
    return normalizeTokenUsage(response.usage);
}

export function extractAnthropicFinishReason(response) {
    return response.stop_reason ?? '';
}

export function extractAnthropicResponse(response) {
    const serverToolResults = extractAnthropicServerToolResults(response);

    return {
        text: appendSearchSources(extractAnthropicText(response), serverToolResults),
        reasoning: extractAnthropicReasoning(response),
        usage: extractAnthropicUsage(response),
        finishReason: extractAnthropicFinishReason(response),
        toolCalls: extractAnthropicToolCalls(response),
        serverToolResults,
    };
}

export function extractGeminiText(response) {
    return (response.candidates?.[0]?.content?.parts ?? [])
        .filter((part) => !part.thought)
        .map((part) => part.text ?? '')
        .join('');
}

export function extractGeminiReasoning(response) {
    return joinTextParts((response.candidates?.[0]?.content?.parts ?? [])
        .filter((part) => part.thought)
        .map((part) => part.text ?? ''));
}

export function extractGeminiUsage(response) {
    return normalizeTokenUsage(response.usageMetadata ?? response.usage);
}

export function extractGeminiFinishReason(response) {
    return response.candidates?.[0]?.finishReason ?? '';
}

export function extractGeminiProviderParts(response) {
    return normalizeGeminiProviderParts(response?.candidates?.[0]?.content?.parts);
}

export function extractGeminiResponse(response) {
    const serverToolResults = extractGeminiServerToolResults(response);

    return {
        text: appendSearchSources(extractGeminiText(response), serverToolResults),
        reasoning: extractGeminiReasoning(response),
        usage: extractGeminiUsage(response),
        finishReason: extractGeminiFinishReason(response),
        toolCalls: extractGeminiToolCalls(response),
        serverToolResults,
        providerParts: extractGeminiProviderParts(response),
    };
}

function normalizeDiscoveredModel(item) {
    const rawId = item?.id ?? item?.name;

    if (!rawId)
        return null;

    const id = String(rawId).replace(/^models\//, '');
    const name = item.display_name ?? item.displayName ?? item.name ?? item.id ?? id;
    const contextWindowTokens = [
        item.contextWindowTokens,
        item.context_window_tokens,
        item.contextLengthTokens,
        item.context_length_tokens,
        item.contextLength,
        item.context_length,
        item.inputTokenLimit,
        item.input_token_limit,
        item.maxInputTokens,
        item.max_input_tokens,
    ].map(Number).find((tokens) => Number.isFinite(tokens) && tokens > 0);

    return {
        id,
        name: String(name).replace(/^models\//, ''),
        description: item.description ?? 'Discovered model.',
        ...(contextWindowTokens ? { contextWindowTokens: Math.round(contextWindowTokens) } : {}),
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

function geminiDiscoveredThinkingCapability(modelId) {
    const id = String(modelId ?? '').toLowerCase();

    if (!id.startsWith('gemini-'))
        return null;

    if (id.startsWith('gemini-3.1-pro') || id.startsWith('gemini-3-pro')) {
        return {
            api: 'gemini-thinking-level',
            levels: ['auto', 'low', 'medium', 'high'],
            includeThoughts: true,
        };
    }

    if (id.startsWith('gemini-3.')) {
        return {
            api: 'gemini-thinking-level',
            levels: ['minimal', 'auto', 'low', 'medium', 'high'],
            includeThoughts: true,
        };
    }

    return null;
}

export async function discoverGeminiModels(config, options = {}) {
    const url = `${normalizeUrl(config.baseUrl, '/models')}?key=${encodeURIComponent(getApiKey(config))}`;
    const response = await getJson(url, {}, {
        cancellable: options.cancellable ?? null,
        providerName: config.name,
        timeoutSeconds: options.timeoutSeconds,
    });

    return extractDiscoveredModels(response)
        .filter((model) => SUPPORTED_GEMINI_MODEL_IDS.has(model.id))
        .map((model) => {
            const thinking = geminiDiscoveredThinkingCapability(model.id);

            return thinking ? { ...model, thinking } : model;
        });
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
        let requestMessages = messages;
        let assistantText = '';
        const maxContinuationTurns = normalizeMaxContinuationTurns(options.maxContinuationTurns);

        for (let turn = 0; turn <= maxContinuationTurns; turn++) {
            let response;

            for (let reconnectAttempt = 0; ; ) {
                try {
                    response = normalizeProviderResponse(await this._complete(
                        requestMessages,
                        options.model?.id ?? this._config.defaultModelId,
                        options,
                    ));
                    break;
                } catch (error) {
                    // send_and_read_async does not expose response bytes until the
                    // complete JSON body is available. A dropped TLS connection can
                    // therefore be replayed safely even after headers were received.
                    const canReplayInterruptedResponse = !error?.providerResponseStarted
                        || isRetryableInterruptedResponse(error);
                    const shouldReconnect = reconnectAttempt < MAX_NETWORK_RECONNECTS
                        && !isCancelled(options.cancellable)
                        && canReplayInterruptedResponse
                        && isNetworkError(error);

                    if (!shouldReconnect)
                        throw error;

                    reconnectAttempt++;
                    const statusPrefix = error?.providerResponseStarted
                        ? 'Connection interrupted. Retrying'
                        : 'Reconnecting';
                    yield {
                        type: 'status',
                        text: `${statusPrefix} ${reconnectAttempt}/${MAX_NETWORK_RECONNECTS}\u2026`,
                        status: 'reconnecting',
                        attempt: reconnectAttempt,
                        maxAttempts: MAX_NETWORK_RECONNECTS,
                    };
                    await delay(NETWORK_RECONNECT_DELAY_MS);
                }
            }

            if (!response.text
                && !response.reasoning
                && !response.usage
                && response.toolCalls.length === 0
                && response.serverToolResults.length === 0) {
                throw new Error(`${this.name} returned an empty response`);
            }

            if (response.usage) {
                yield {
                    type: 'usage',
                    usage: response.usage,
                };
            }

            if (response.reasoning) {
                yield {
                    type: 'reasoning',
                    text: response.reasoning,
                };
            }

            if (response.providerParts.length > 0) {
                yield {
                    type: 'provider_context',
                    providerParts: response.providerParts,
                };
            }

            if (response.serverToolResults.length > 0) {
                yield {
                    type: 'server_tool_results',
                    serverToolResults: response.serverToolResults.map((result) => ({
                        ...result,
                        providerId: this.id,
                        providerName: this.name,
                    })),
                };
            }

            if (response.text) {
                assistantText += response.text;
                yield* displayStream(response.text, options.cancellable ?? null);
            }

            if (response.toolCalls.length > 0) {
                yield {
                    type: 'tool_calls',
                    toolCalls: response.toolCalls,
                };
                return;
            }

            if (!response.text
                || !stoppedForMaxOutput(response.finishReason)
                || turn >= maxContinuationTurns
                || isCancelled(options.cancellable)) {
                return;
            }

            requestMessages = continuationMessages(messages, assistantText);
        }
    }
}

export class OpenAiResponsesProvider extends RemoteProvider {
    async _complete(messages, modelId, options = {}) {
        const response = await postJson(
            normalizeUrl(this._config.baseUrl, '/responses'),
            { Authorization: `Bearer ${getApiKey(this._config)}` },
            buildOpenAiResponsesBody(messages, modelId, {
                provider: this._config,
                model: options.model,
                tools: options.tools,
                disableNativeSearch: options.disableNativeSearch,
                thinkingLevel: options.thinkingLevel,
                maxOutputTokens: options.maxOutputTokens,
            }),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        );

        return extractOpenAiResponse(response, options);
    }
}

export class OpenAiCompatibleChatProvider extends RemoteProvider {
    async _complete(messages, modelId, options = {}) {
        const response = await postJson(
            normalizeUrl(this._config.baseUrl, this._config.chatPath ?? '/chat/completions'),
            { Authorization: `Bearer ${getApiKey(this._config)}` },
            buildOpenAiCompatibleChatBody(messages, modelId, {
                provider: this._config,
                model: options.model,
                tools: options.tools,
                disableNativeSearch: options.disableNativeSearch,
                thinkingLevel: options.thinkingLevel,
                maxOutputTokens: options.maxOutputTokens,
            }),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        );

        return extractChatCompletionResponse(response);
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
            buildAnthropicMessagesBody(messages, modelId, {
                provider: this._config,
                model: options.model,
                tools: options.tools,
                disableNativeSearch: options.disableNativeSearch,
                thinkingLevel: options.thinkingLevel,
                maxOutputTokens: options.maxOutputTokens,
            }),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        );

        return extractAnthropicResponse(response);
    }
}

export class GeminiGenerateContentProvider extends RemoteProvider {
    async _complete(messages, modelId, options = {}) {
        const url = `${normalizeUrl(this._config.baseUrl, `/models/${modelId}:generateContent`)}?key=${encodeURIComponent(getApiKey(this._config))}`;
        const response = await postJson(url, {}, buildGeminiGenerateContentBody(messages, {
            provider: this._config,
            model: options.model,
            tools: options.tools,
            disableNativeSearch: options.disableNativeSearch,
            thinkingLevel: options.thinkingLevel,
            maxOutputTokens: options.maxOutputTokens,
        }), {
            cancellable: options.cancellable ?? null,
            providerName: this.name,
            timeoutSeconds: options.timeoutSeconds,
        });

        return extractGeminiResponse(response);
    }
}
