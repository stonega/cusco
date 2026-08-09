import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import { ChatProvider } from './provider.js';
import {
    createOutputCapacityError,
    DEFAULT_MAX_CONTINUATION_TURNS,
    estimateRequestInputTokens,
    normalizeMaxOutputTokens,
    resolveEffectiveMaxOutputTokens,
} from './outputLimits.js';
import { getThinkingCapability, normalizeThinkingLevel } from './thinking.js';
import { normalizeTokenUsage } from './usage.js';

const DISPLAY_STREAM_DELAY_MS = 10;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 300;
const MAX_NETWORK_RECONNECTS = 5;
const NETWORK_RECONNECT_DELAY_MS = 250;
const RESPONSE_READ_CHUNK_BYTES = 16 * 1024;
const MAX_STREAM_LINE_CHARS = 16 * 1024 * 1024;
const MAX_STREAM_EVENT_CHARS = 16 * 1024 * 1024;
const MAX_UNFRAMED_RESPONSE_CHARS = 32 * 1024 * 1024;
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

function createHttpStatusError(message, status) {
    const error = createUserVisibleError(message);
    error.httpStatus = status;
    return error;
}

function createInterruptedStreamError(providerName) {
    const error = createUserVisibleError(`${providerName} response stream ended before completion.`);
    error.providerResponseStarted = true;
    error.retryableInterruptedResponse = true;
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
    return error?.retryableInterruptedResponse === true
        || isTransientTlsError(error)
        || RETRYABLE_INTERRUPTED_RESPONSE_IO_ERRORS.some((code) => isGioError(error, code));
}

function isRetryableHttpError(error) {
    return error?.httpStatus === Soup.Status.REQUEST_TIMEOUT;
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

function messagesWithLocalAttachmentPaths(messages, tools = []) {
    if (!Array.isArray(tools) || tools.length === 0)
        return messages;

    return (messages ?? []).map((message) => {
        if (message?.role !== 'user')
            return message;

        const attachments = (message.attachments ?? [])
            .filter((attachment) => attachment?.kind === 'file')
            .map((attachment) => {
                const path = String(attachment?.path ?? '').trim();

                if (!path)
                    return null;

                return {
                    name: String(attachment?.name ?? GLib.path_get_basename(path)),
                    path,
                };
            })
            .filter(Boolean);

        if (attachments.length === 0)
            return message;

        const attachmentContext = [
            'Local file attachments available to tools (use the exact path values; do not guess):',
            JSON.stringify(attachments),
        ].join('\n\n');

        return {
            ...message,
            content: [messageContent(message), attachmentContext]
                .filter(Boolean)
                .join('\n\n'),
        };
    });
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

function assistantHasProviderPayload(message, options = {}) {
    if (messageContent(message) || messageToolCalls(message).length > 0)
        return true;

    if (options.includeImages !== false && imageAttachments(message).length > 0)
        return true;

    return options.includeGeminiProviderParts === true
        && messageGeminiProviderParts(message).length > 0;
}

function providerMessages(messages, options = {}) {
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

        return hasUserMessage
            && message.role === 'assistant'
            && assistantHasProviderPayload(message, options);
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

function toolArgumentsForHistory(call) {
    if (call?.argumentsValid === false
        && Object.hasOwn(call, 'rawArguments')) {
        return String(call.rawArguments ?? '');
    }

    return toolArguments(call?.input);
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

function createJsonPostRequest(url, headers, body, { stream = false } = {}) {
    const request = Soup.Message.new('POST', url);
    request.request_headers.append('Content-Type', 'application/json');

    if (stream)
        request.request_headers.append('Accept', 'text/event-stream');

    for (const [name, value] of Object.entries(headers))
        request.request_headers.append(name, value);

    request.set_request_body_from_bytes('application/json', encodeJsonBody(body));
    return request;
}

function parseJsonResponse(responseText) {
    try {
        return JSON.parse(responseText);
    } catch (_error) {
        return null;
    }
}

function decorateProviderRequestError(error, providerName, timeoutSeconds) {
    if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
        error.userMessage = `${providerName} request was cancelled.`;
    else if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
        error.userMessage = `${providerName} did not respond within ${timeoutSeconds} seconds.`;
    else if (isTransientTlsError(error))
        error.userMessage = `${providerName} could not establish a secure connection. Try again.`;
    else if (isNetworkError(error))
        error.userMessage = `${providerName} could not connect. Check your network and try again.`;

    return error;
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

function send(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
            try {
                resolve(session.send_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function readBytes(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(
            RESPONSE_READ_CHUNK_BYTES,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (_stream, result) => {
                try {
                    resolve(stream.read_bytes_finish(result));
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

function utf8SequenceLength(byte) {
    if ((byte & 0x80) === 0)
        return 1;

    if ((byte & 0xE0) === 0xC0)
        return 2;

    if ((byte & 0xF0) === 0xE0)
        return 3;

    if ((byte & 0xF8) === 0xF0)
        return 4;

    return 1;
}

function completeUtf8PrefixLength(bytes) {
    let sequenceStart = bytes.length - 1;
    let continuationBytes = 0;

    while (sequenceStart >= 0
        && continuationBytes < 3
        && (bytes[sequenceStart] & 0xC0) === 0x80) {
        continuationBytes++;
        sequenceStart--;
    }

    if (sequenceStart < 0)
        return 0;

    const availableBytes = bytes.length - sequenceStart;
    return utf8SequenceLength(bytes[sequenceStart]) > availableBytes
        ? sequenceStart
        : bytes.length;
}

function combineByteChunks(prefix, suffix) {
    if (prefix.length === 0)
        return suffix;

    const combined = new Uint8Array(prefix.length + suffix.length);
    combined.set(prefix);
    combined.set(suffix, prefix.length);
    return combined;
}

async function* readResponseStream(stream, cancellable) {
    const decoder = new TextDecoder();
    let pendingBytes = new Uint8Array(0);

    for (;;) {
        const bytes = await readBytes(stream, cancellable);

        if (bytes.get_size() === 0)
            break;

        const combined = combineByteChunks(pendingBytes, bytes.get_data());
        const prefixLength = completeUtf8PrefixLength(combined);
        const chunk = decoder.decode(combined.subarray(0, prefixLength));
        pendingBytes = combined.slice(prefixLength);

        if (chunk)
            yield chunk;
    }

    const finalChunk = pendingBytes.length > 0 ? decoder.decode(pendingBytes) : '';

    if (finalChunk)
        yield finalChunk;
}

async function readResponseText(stream, cancellable) {
    const parts = [];

    for await (const chunk of readResponseStream(stream, cancellable))
        parts.push(chunk);

    return parts.join('');
}

export class ServerSentEventDecoder {
    constructor(options = {}) {
        this._providerName = options.providerName ?? 'Provider';
        this._maxLineChars = options.maxLineChars ?? MAX_STREAM_LINE_CHARS;
        this._maxEventChars = options.maxEventChars ?? MAX_STREAM_EVENT_CHARS;
        this._lineBuffer = '';
        this._eventName = '';
        this._dataLines = [];
        this._dataChars = 0;
        this._atStart = true;
    }

    _oversizedStreamError(kind) {
        return createUserVisibleError(`${this._providerName} returned an oversized streaming ${kind}.`);
    }

    _dispatch(events) {
        if (this._dataLines.length === 0) {
            this._eventName = '';
            return;
        }

        events.push({
            event: this._eventName,
            data: this._dataLines.join('\n'),
        });
        this._eventName = '';
        this._dataLines = [];
        this._dataChars = 0;
    }

    _consumeLine(line, events) {
        if (!line) {
            this._dispatch(events);
            return;
        }

        if (line.startsWith(':'))
            return;

        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        let value = separator < 0 ? '' : line.slice(separator + 1);

        if (value.startsWith(' '))
            value = value.slice(1);

        if (field === 'event')
            this._eventName = value;
        else if (field === 'data') {
            this._dataChars += value.length + (this._dataLines.length > 0 ? 1 : 0);

            if (this._dataChars > this._maxEventChars)
                throw this._oversizedStreamError('event');

            this._dataLines.push(value);
        }
    }

    push(chunk) {
        let text = String(chunk ?? '');

        if (this._atStart && text) {
            this._atStart = false;

            if (text.startsWith('\uFEFF'))
                text = text.slice(1);
        }

        this._lineBuffer += text;
        const events = [];
        let newlineIndex = this._lineBuffer.search(/[\r\n]/);

        while (newlineIndex >= 0) {
            const newline = this._lineBuffer[newlineIndex];

            if (newline === '\r' && newlineIndex === this._lineBuffer.length - 1)
                break;

            const newlineLength = newline === '\r' && this._lineBuffer[newlineIndex + 1] === '\n'
                ? 2
                : 1;
            const line = this._lineBuffer.slice(0, newlineIndex);

            if (line.length > this._maxLineChars)
                throw this._oversizedStreamError('line');

            this._lineBuffer = this._lineBuffer.slice(newlineIndex + newlineLength);
            this._consumeLine(line, events);
            newlineIndex = this._lineBuffer.search(/[\r\n]/);
        }

        if (this._lineBuffer.length > this._maxLineChars)
            throw this._oversizedStreamError('line');

        return events;
    }

    finish() {
        return this.push('\n\n');
    }
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
        ({ bytes, message } = await sendRequest(
            url,
            timeoutSeconds,
            cancellable,
            () => createJsonPostRequest(url, headers, body),
        ));
    } catch (error) {
        throw decorateProviderRequestError(error, providerName, timeoutSeconds);
    }

    const responseText = new TextDecoder().decode(bytes.get_data());
    const responseJson = parseJsonResponse(responseText);

    const status = responseStatusCode(message);

    if (status < 200 || status >= 300) {
        const messageText = responseJson?.error?.message ?? responseJson?.message ?? responseText;
        throw createHttpStatusError(`${providerName} request failed (${status}): ${messageText}`, status);
    }

    return responseJson;
}

async function* postJsonStream(url, headers, body, options = {}) {
    const {
        cancellable = null,
        providerName = 'Provider',
        timeoutSeconds = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    } = options;
    const session = createSession(url, timeoutSeconds);
    const message = createJsonPostRequest(url, headers, body, { stream: true });
    let inputStream = null;

    try {
        inputStream = await send(session, message, cancellable);
        const status = responseStatusCode(message);

        if (status < 200 || status >= 300) {
            const responseText = await readResponseText(inputStream, cancellable);
            const responseJson = parseJsonResponse(responseText);

            const messageText = responseJson?.error?.message ?? responseJson?.message ?? responseText;
            throw createHttpStatusError(`${providerName} request failed (${status}): ${messageText}`, status);
        }

        const eventDecoder = new ServerSentEventDecoder({ providerName });
        const unframedResponseParts = [];
        let unframedResponseChars = 0;
        let sawEvent = false;

        const parseEvents = function* (events) {
            for (const event of events) {
                sawEvent = true;

                if (event.data === '[DONE]') {
                    yield { event: event.event, data: null, done: true };
                    continue;
                }

                try {
                    yield {
                        event: event.event,
                        data: JSON.parse(event.data),
                        done: false,
                    };
                } catch (_error) {
                    throw createUserVisibleError(`${providerName} returned a malformed streaming event.`);
                }
            }
        };

        for await (const chunk of readResponseStream(inputStream, cancellable)) {
            if (!sawEvent) {
                unframedResponseParts.push(chunk);
                unframedResponseChars += chunk.length;

                if (unframedResponseChars > MAX_UNFRAMED_RESPONSE_CHARS) {
                    throw createUserVisibleError(
                        `${providerName} returned an oversized unframed streaming response.`,
                    );
                }
            }

            const events = eventDecoder.push(chunk);

            for (const event of parseEvents(events))
                yield event;

            if (sawEvent) {
                unframedResponseParts.length = 0;
                unframedResponseChars = 0;
            }
        }

        for (const event of parseEvents(eventDecoder.finish()))
            yield event;

        const unframedResponse = unframedResponseParts.join('');

        if (!sawEvent && unframedResponse.trim()) {
            try {
                yield { event: '', data: JSON.parse(unframedResponse), done: false };
            } catch (_error) {
                throw createUserVisibleError(`${providerName} returned malformed JSON instead of a streaming response.`);
            }
        }
    } catch (error) {
        error.providerResponseStarted = responseStatusCode(message) > 0;

        throw decorateProviderRequestError(error, providerName, timeoutSeconds);
    } finally {
        try {
            inputStream?.close(null);
        } catch (_error) {
            // The stream may already be closed after EOF or cancellation.
        }
    }
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
        return {
            text: response,
            reasoning: '',
            toolCalls: [],
            toolCallIntegrity: { status: 'valid', reason: '' },
            serverToolResults: [],
            providerParts: [],
        };

    if (!response || typeof response !== 'object')
        return {
            text: '',
            reasoning: '',
            toolCalls: [],
            toolCallIntegrity: { status: 'valid', reason: '' },
            serverToolResults: [],
            providerParts: [],
        };

    const toolCalls = Array.isArray(response.toolCalls)
        ? response.toolCalls.map((toolCall) => {
            const thoughtSignature = toolCall?.thoughtSignature ?? toolCall?.thought_signature;

            return {
                id: String(toolCall?.id ?? ''),
                name: String(toolCall?.name ?? '').trim(),
                input: String(toolCall?.input ?? ''),
                argumentsValid: toolCall?.argumentsValid !== false,
                ...(Object.hasOwn(toolCall ?? {}, 'rawArguments')
                    ? { rawArguments: String(toolCall.rawArguments ?? '') }
                    : {}),
                ...(typeof thoughtSignature === 'string' && thoughtSignature
                    ? { thoughtSignature }
                    : {}),
            };
        })
        : [];
    const suppliedIntegrityStatus = String(response.toolCallIntegrity?.status ?? '');
    const allowedIntegrityStatuses = new Set(['valid', 'truncated', 'output_limited', 'malformed']);
    const integrityStatus = allowedIntegrityStatuses.has(suppliedIntegrityStatus)
        ? suppliedIntegrityStatus
        : toolCalls.some((toolCall) => !toolCall.name || !toolCall.argumentsValid)
            ? 'malformed'
            : 'valid';

    return {
        text: String(response.text ?? ''),
        reasoning: String(response.reasoning ?? ''),
        usage: normalizeTokenUsage(response.usage),
        finishReason: String(response.finishReason ?? ''),
        toolCalls,
        toolCallIntegrity: {
            status: integrityStatus,
            reason: String(response.toolCallIntegrity?.reason ?? ''),
        },
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

function requestOptionsWithEffectiveOutputBudget(messages, options, providerConfig = null) {
    const configuredMaxOutputTokens = normalizeMaxOutputTokens(options.model?.maxOutputTokens);
    const provider = options.provider ?? options.config ?? providerConfig;
    const toolApiFormat = providerToolApiFormat(provider);
    const requestTools = requestToolConfiguration({ ...options, provider }, toolApiFormat).tools;
    const estimatedInputTokens = estimateRequestInputTokens(messages, requestTools);
    const maxOutputTokens = resolveEffectiveMaxOutputTokens({
        configuredMaxOutputTokens,
        callMaxOutputTokens: options.maxOutputTokens,
        contextWindowTokens: options.model?.contextWindowTokens,
        estimatedInputTokens,
    });

    if (maxOutputTokens <= 0) {
        throw createOutputCapacityError(
            'This conversation has no room for another response. Compact the conversation and try again.',
        );
    }

    return {
        ...options,
        maxOutputTokens,
    };
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

function requestToolConfiguration(options = {}, api = '') {
    const nativeSearch = nativeSearchConfiguration(options, api);
    const clientTools = clientToolsForSearchConfiguration(options.tools, nativeSearch);
    let tools;

    if (api === 'openai-responses') {
        tools = [
            ...openAiNativeSearchToolDefinitions(nativeSearch),
            ...openAiResponsesToolDefinitions(clientTools),
        ];
    } else if (api === 'zai-chat-completions') {
        tools = [
            ...zaiNativeSearchToolDefinitions(nativeSearch),
            ...openAiCompatibleToolDefinitions(clientTools),
        ];
    } else if (api === 'anthropic-messages') {
        tools = [
            ...anthropicNativeSearchToolDefinitions(nativeSearch),
            ...anthropicToolDefinitions(clientTools),
        ];
    } else if (api === 'gemini-generate-content') {
        tools = [
            ...geminiNativeSearchToolDefinitions(nativeSearch),
            ...geminiToolDefinitions(clientTools),
        ];
    } else {
        tools = options.tools ?? [];
    }

    return { nativeSearch, clientTools, tools };
}

function providerToolApiFormat(provider) {
    return provider?.apiFormat === 'openai-chat-completions'
        ? 'zai-chat-completions'
        : String(provider?.apiFormat ?? '');
}

function parseToolArguments(argumentsText) {
    const rawArguments = String(argumentsText ?? '');
    const text = rawArguments.trim();

    try {
        const parsed = JSON.parse(text);
        let input;

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const keys = Object.keys(parsed);

            if (keys.length === 1 && Object.hasOwn(parsed, 'input'))
                input = String(parsed.input ?? '');
            else
                input = JSON.stringify(parsed);
        } else {
            input = String(parsed ?? '');
        }

        return {
            input,
            argumentsValid: true,
        };
    } catch (_error) {
        return {
            input: '',
            rawArguments,
            argumentsValid: false,
        };
    }
}

function classifyNativeToolCallIntegrity(toolCalls, finishReason) {
    if (toolCalls.length === 0)
        return { status: 'valid', reason: '' };

    const hasIncompleteCall = toolCalls.some((toolCall) => (
        !toolCall.name || !toolCall.argumentsValid
    ));

    if (stoppedForMaxOutput(finishReason)) {
        return hasIncompleteCall
            ? { status: 'truncated', reason: 'max_output_with_incomplete_tool_call' }
            : { status: 'output_limited', reason: 'max_output_with_tool_calls' };
    }

    if (hasIncompleteCall)
        return { status: 'malformed', reason: 'invalid_tool_call_arguments' };

    return { status: 'valid', reason: '' };
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
        .map((item) => {
            const parsedArguments = parseToolArguments(item.arguments);

            return {
                id: String(item.call_id ?? item.id ?? ''),
                name: String(item.name ?? '').trim(),
                ...parsedArguments,
            };
        });
    const chatCalls = extractChatCompletionToolCalls(response);

    return [...outputCalls, ...chatCalls];
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
            const parsedArguments = parseToolArguments(call?.arguments);

            return {
                id: String(toolCall.id ?? ''),
                name,
                ...parsedArguments,
            };
        });
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
                    arguments: toolArgumentsForHistory(call),
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

    for (const message of providerMessages(messages, { includeImages })) {
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
                        arguments: toolArgumentsForHistory(call),
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
    const normalizedMessages = providerMessages(messages, {
        includeGeminiProviderParts: true,
    });
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
        input: openAiMessages(messagesWithLocalAttachmentPaths(messages, options.tools)),
        max_output_tokens: normalizeMaxOutputTokens(options.maxOutputTokens),
    };

    if (options.stream === true)
        body.stream = true;

    const provider = options.provider ?? options.config;
    const reasoning = buildOpenAiReasoningConfig(provider, options.model, options.thinkingLevel)
        ?? buildOpenAiCompatibleThinkingConfig(provider, options.model, options.thinkingLevel)?.reasoning;

    if (reasoning)
        body.reasoning = reasoning;

    const { nativeSearch, tools } = requestToolConfiguration(options, 'openai-responses');

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
        messages: openAiCompatibleMessages(
            messagesWithLocalAttachmentPaths(messages, options.tools),
            options,
        ),
        stream: options.stream === true,
    };

    if (options.stream === true && provider?.supportsStreamUsageOptions === true)
        body.stream_options = { include_usage: true };

    body[maxOutputTokensParameter] = normalizeMaxOutputTokens(options.maxOutputTokens);
    const thinking = buildOpenAiCompatibleThinkingConfig(provider, options.model, options.thinkingLevel);
    const { tools } = requestToolConfiguration(options, 'zai-chat-completions');

    if (thinking)
        Object.assign(body, thinking);

    if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }

    return body;
}

export function buildAnthropicMessagesBody(messages, modelId, options = {}) {
    const { system, messages: conversationMessages } = anthropicPayloadMessages(
        messagesWithLocalAttachmentPaths(messages, options.tools),
    );
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

    if (options.stream === true)
        body.stream = true;

    if (system)
        body.system = system;

    if (thinkingConfig) {
        body.thinking = thinkingConfig.thinking;

        if (thinkingConfig.outputConfig)
            body.output_config = thinkingConfig.outputConfig;

        if (Number.isFinite(body.thinking.budget_tokens)
            && body.thinking.budget_tokens + 1024 > body.max_tokens) {
            throw createOutputCapacityError(
                'The selected thinking level does not fit in the available response capacity. Compact the conversation or choose a lower thinking level.',
            );
        }
    }

    const { tools } = requestToolConfiguration(options, 'anthropic-messages');

    if (tools.length > 0)
        body.tools = tools;

    return body;
}

export function buildGeminiGenerateContentBody(messages, options = {}) {
    const payload = geminiPayload(messagesWithLocalAttachmentPaths(messages, options.tools));
    const thinking = buildGeminiThinkingConfig(options.provider ?? options.config, options.model, options.thinkingLevel);

    payload.generationConfig = {
        maxOutputTokens: normalizeMaxOutputTokens(options.maxOutputTokens),
    };

    if (thinking)
        payload.generationConfig.thinkingConfig = thinking;

    const { nativeSearch, clientTools, tools } = requestToolConfiguration(
        options,
        'gemini-generate-content',
    );

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

    const finishReason = extractOpenAiFinishReason(response);
    const toolCalls = extractOpenAiToolCalls(response);

    return {
        text: appendSearchSources(extractOpenAiText(response), serverToolResults),
        reasoning: extractOpenAiReasoning(response),
        usage: extractOpenAiUsage(response),
        finishReason,
        toolCalls,
        toolCallIntegrity: classifyNativeToolCallIntegrity(toolCalls, finishReason),
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
    const finishReason = extractChatCompletionFinishReason(response);
    const toolCalls = extractChatCompletionToolCalls(response);

    return {
        text: appendSearchSources(extractChatCompletionText(response), serverToolResults),
        reasoning: extractChatCompletionReasoning(response),
        usage: extractChatCompletionUsage(response),
        finishReason,
        toolCalls,
        toolCallIntegrity: classifyNativeToolCallIntegrity(toolCalls, finishReason),
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

function streamEventError(providerName, event) {
    const error = event?.error ?? event?.response?.error;
    const message = error?.message ?? (typeof event?.message === 'string' ? event.message : '');

    if (!error && !message)
        return null;

    return createUserVisibleError(
        `${providerName} streaming request failed: ${message ?? 'Unknown provider error'}`,
    );
}

function streamedText(value) {
    if (typeof value === 'string')
        return value;

    if (!Array.isArray(value))
        return '';

    return value.map((part) => part?.text ?? part?.content ?? '').join('');
}

function appendIndexedToolCall(toolCalls, delta, fallbackIndex) {
    const index = Number.isInteger(delta?.index) ? delta.index : fallbackIndex;
    const current = toolCalls[index] ?? {
        idParts: [],
        type: 'function',
        nameParts: [],
        argumentParts: [],
    };
    const functionDelta = delta?.function ?? delta;

    current.idParts.push(String(delta?.id ?? ''));
    current.type = delta?.type ?? current.type;
    current.nameParts.push(String(functionDelta?.name ?? ''));
    current.argumentParts.push(String(functionDelta?.arguments ?? ''));
    toolCalls[index] = current;
}

function finalizedIndexedToolCalls(toolCalls) {
    return toolCalls.map((toolCall) => ({
        id: toolCall.idParts.join(''),
        type: toolCall.type,
        function: {
            name: toolCall.nameParts.join(''),
            arguments: toolCall.argumentParts.join(''),
        },
    }));
}

class OpenAiResponsesStreamState {
    constructor(providerName) {
        this.providerName = providerName;
        this.response = { output: [] };
        this.textParts = [];
        this.terminal = false;
    }

    push(event, done = false) {
        const deltas = [];

        if (done)
            return deltas;

        const error = streamEventError(this.providerName, event);

        if (error || event?.type === 'response.failed' || event?.type === 'error')
            throw error ?? createUserVisibleError(`${this.providerName} streaming request failed.`);

        if (event?.response && (event.type === 'response.created' || event.type === 'response.in_progress'))
            this.response = { ...this.response, ...event.response };

        if (event?.type === 'response.output_item.done' && event.item) {
            const index = Number.isInteger(event.output_index)
                ? event.output_index
                : this.response.output.length;
            this.response.output[index] = event.item;
        }

        if (event?.type === 'response.output_text.delta' || event?.type === 'response.refusal.delta') {
            const text = String(event.delta ?? '');
            this.textParts.push(text);

            if (text)
                deltas.push({ type: 'text', text });
        }

        if (event?.type === 'response.reasoning_summary_text.delta'
            || event?.type === 'response.reasoning_text.delta') {
            const text = String(event.delta ?? '');

            if (text)
                deltas.push({ type: 'reasoning', text });
        }

        if (event?.type === 'response.completed' || event?.type === 'response.incomplete') {
            this.response = event.response ?? this.response;
            this.terminal = true;
        } else if (!event?.type && (event?.output || event?.output_text)) {
            this.response = event;
            this.terminal = true;
        }

        return deltas;
    }

    finish() {
        if (!this.terminal)
            throw createInterruptedStreamError(this.providerName);

        if (!extractOpenAiText(this.response) && this.textParts.length > 0)
            this.response.output_text = this.textParts.join('');

        return this.response;
    }
}

class ChatCompletionStreamState {
    constructor(providerName) {
        this.providerName = providerName;
        this.response = {
            choices: [{
                message: { content: '', reasoning_content: '', tool_calls: [] },
                finish_reason: '',
            }],
        };
        this.textParts = [];
        this.reasoningParts = [];
        this.toolCallParts = [];
        this.functionCallParts = null;
        this.receivedCompleteResponse = false;
        this.terminal = false;
    }

    push(event, done = false) {
        const deltas = [];

        if (done) {
            this.terminal = true;
            return deltas;
        }

        const error = streamEventError(this.providerName, event);

        if (error)
            throw error;

        if (event?.choices?.[0]?.message) {
            this.response = event;
            this.receivedCompleteResponse = true;
            this.terminal = true;
            return deltas;
        }

        if (event?.usage)
            this.response.usage = event.usage;

        if (Array.isArray(event?.web_search))
            this.response.web_search = event.web_search;

        const choice = event?.choices?.[0];

        if (!choice)
            return deltas;

        const targetChoice = this.response.choices[0];
        const delta = choice.delta ?? {};
        const text = streamedText(delta.content);
        const reasoning = streamedText(
            delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_summary,
        );

        this.textParts.push(text);
        this.reasoningParts.push(reasoning);

        if (text)
            deltas.push({ type: 'text', text });

        if (reasoning)
            deltas.push({ type: 'reasoning', text: reasoning });

        for (const [index, toolCall] of (delta.tool_calls ?? []).entries())
            appendIndexedToolCall(this.toolCallParts, toolCall, index);

        if (delta.function_call) {
            this.functionCallParts ??= { name: [], arguments: [] };
            this.functionCallParts.name.push(String(delta.function_call.name ?? ''));
            this.functionCallParts.arguments.push(String(delta.function_call.arguments ?? ''));
        }

        if (choice.finish_reason) {
            targetChoice.finish_reason = choice.finish_reason;
            this.terminal = true;
        }

        return deltas;
    }

    finish() {
        if (!this.terminal)
            throw createInterruptedStreamError(this.providerName);

        if (!this.receivedCompleteResponse) {
            const targetMessage = this.response.choices[0].message;
            targetMessage.content = this.textParts.join('');
            targetMessage.reasoning_content = this.reasoningParts.join('');
            targetMessage.tool_calls = finalizedIndexedToolCalls(this.toolCallParts);

            if (this.functionCallParts) {
                targetMessage.function_call = {
                    name: this.functionCallParts.name.join(''),
                    arguments: this.functionCallParts.arguments.join(''),
                };
            }
        }

        return this.response;
    }
}

class AnthropicStreamState {
    constructor(providerName) {
        this.providerName = providerName;
        this.response = { content: [], usage: {} };
        this.terminal = false;
        this.textBlocksWithOutput = new Set();
    }

    _appendTextDelta(index, text, deltas) {
        if (!text)
            return;

        const firstDeltaForBlock = !this.textBlocksWithOutput.has(index);
        const separator = firstDeltaForBlock && this.textBlocksWithOutput.size > 0 ? '\n' : '';

        this.textBlocksWithOutput.add(index);
        deltas.push({ type: 'text', text: separator + text });
    }

    _finalizeBlock(block) {
        if (!block)
            return;

        if (block._textParts) {
            block.text = block._textParts.join('');
            delete block._textParts;
        }

        if (block._thinkingParts) {
            block.thinking = block._thinkingParts.join('');
            delete block._thinkingParts;
        }

        if (block._signatureParts) {
            block.signature = block._signatureParts.join('');
            delete block._signatureParts;
        }

        if (block._streamedInputParts) {
            const inputJson = block._streamedInputParts.join('');

            try {
                block.input = JSON.parse(inputJson || '{}');
            } catch (_error) {
                throw createUserVisibleError(`${this.providerName} returned malformed tool input.`);
            }

            delete block._streamedInputParts;
        }
    }

    push(event, done = false) {
        const deltas = [];

        if (done)
            return deltas;

        const error = streamEventError(this.providerName, event);

        if (error || event?.type === 'error')
            throw error ?? createUserVisibleError(`${this.providerName} streaming request failed.`);

        if (event?.type === 'message_start') {
            this.response = {
                ...this.response,
                ...event.message,
                content: [...(event.message?.content ?? [])],
                usage: { ...this.response.usage, ...(event.message?.usage ?? {}) },
            };
        } else if (event?.type === 'content_block_start') {
            const block = event.content_block;
            const text = block?.type === 'text' ? String(block.text ?? '') : '';
            const reasoning = block?.type === 'thinking' ? String(block.thinking ?? '') : '';
            const targetBlock = { ...block };

            if (block?.type === 'text') {
                targetBlock._textParts = [text];
                targetBlock.text = '';
            } else if (block?.type === 'thinking') {
                targetBlock._thinkingParts = [reasoning];
                targetBlock._signatureParts = [String(block.signature ?? '')];
                targetBlock.thinking = '';
                targetBlock.signature = '';
            }

            this.response.content[event.index] = targetBlock;

            this._appendTextDelta(event.index, text, deltas);

            if (reasoning)
                deltas.push({ type: 'reasoning', text: reasoning });
        } else if (event?.type === 'content_block_delta') {
            const block = this.response.content[event.index] ?? {};
            const delta = event.delta ?? {};

            if (delta.type === 'text_delta') {
                const text = String(delta.text ?? '');
                block._textParts ??= [String(block.text ?? '')];
                block._textParts.push(text);
                block.text = '';

                this._appendTextDelta(event.index, text, deltas);
            } else if (delta.type === 'thinking_delta') {
                const reasoning = String(delta.thinking ?? '');
                block._thinkingParts ??= [String(block.thinking ?? '')];
                block._thinkingParts.push(reasoning);
                block.thinking = '';

                if (reasoning)
                    deltas.push({ type: 'reasoning', text: reasoning });
            } else if (delta.type === 'input_json_delta') {
                block._streamedInputParts ??= [];
                block._streamedInputParts.push(String(delta.partial_json ?? ''));
            } else if (delta.type === 'signature_delta') {
                block._signatureParts ??= [String(block.signature ?? '')];
                block._signatureParts.push(String(delta.signature ?? ''));
                block.signature = '';
            }

            this.response.content[event.index] = block;
        } else if (event?.type === 'content_block_stop') {
            const block = this.response.content[event.index];
            this._finalizeBlock(block);
        } else if (event?.type === 'message_delta') {
            Object.assign(this.response, event.delta ?? {});
            this.response.usage = { ...this.response.usage, ...(event.usage ?? {}) };
        } else if (event?.type === 'message_stop') {
            this.terminal = true;
        } else if (event?.type === 'message' || (!event?.type && Array.isArray(event?.content))) {
            this.response = event;
            this.terminal = true;
        }

        return deltas;
    }

    finish() {
        if (!this.terminal)
            throw createInterruptedStreamError(this.providerName);

        for (const block of this.response.content ?? [])
            this._finalizeBlock(block);

        return this.response;
    }
}

function appendGeminiPart(parts, part) {
    const lastPart = parts[parts.length - 1];

    if (typeof part?.text === 'string'
        && !part.functionCall
        && !part.function_call
        && typeof lastPart?.text === 'string'
        && Boolean(lastPart.thought) === Boolean(part.thought)) {
        lastPart._textParts ??= [lastPart.text];
        lastPart._textParts.push(part.text);

        if (part.thoughtSignature ?? part.thought_signature)
            lastPart.thoughtSignature = part.thoughtSignature ?? part.thought_signature;

        return;
    }

    parts.push({
        ...part,
        ...(typeof part?.text === 'string' ? { _textParts: [part.text] } : {}),
    });
}

function finalizeGeminiParts(parts) {
    for (const part of parts) {
        if (!part?._textParts)
            continue;

        part.text = part._textParts.join('');
        delete part._textParts;
    }
}

class GeminiStreamState {
    constructor(providerName) {
        this.providerName = providerName;
        this.response = { candidates: [{ content: { parts: [] } }] };
        this.terminal = false;
    }

    push(event, done = false) {
        const deltas = [];

        if (done)
            return deltas;

        const error = streamEventError(this.providerName, event);

        if (error)
            throw error;

        if (event?.usageMetadata)
            this.response.usageMetadata = event.usageMetadata;

        const candidate = event?.candidates?.[0];

        if (!candidate)
            return deltas;

        const targetCandidate = this.response.candidates[0];
        const targetParts = targetCandidate.content.parts;

        for (const part of candidate.content?.parts ?? []) {
            const text = String(part?.text ?? '');

            if (text)
                deltas.push({ type: part.thought ? 'reasoning' : 'text', text });

            appendGeminiPart(targetParts, part);
        }

        for (const [key, value] of Object.entries(candidate)) {
            if (key !== 'content')
                targetCandidate[key] = value;
        }

        if (candidate.finishReason ?? candidate.finish_reason)
            this.terminal = true;

        return deltas;
    }

    finish() {
        if (!this.terminal)
            throw createInterruptedStreamError(this.providerName);

        finalizeGeminiParts(this.response.candidates?.[0]?.content?.parts ?? []);

        return this.response;
    }
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
    const maxOutputTokens = [
        item.maxOutputTokens,
        item.max_output_tokens,
        item.maxTokens,
        item.max_tokens,
        item.outputTokenLimit,
        item.output_token_limit,
    ].map(Number).find((tokens) => Number.isFinite(tokens) && tokens > 0);

    return {
        id,
        name: String(name).replace(/^models\//, ''),
        description: item.description ?? 'Discovered model.',
        ...(contextWindowTokens ? { contextWindowTokens: Math.round(contextWindowTokens) } : {}),
        maxOutputTokens: normalizeMaxOutputTokens(maxOutputTokens),
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
        let assistantReasoning = '';
        const maxContinuationTurns = normalizeMaxContinuationTurns(options.maxContinuationTurns);
        const prototype = Object.getPrototypeOf(this);
        const hasOwnBufferedCompletion = Object.hasOwn(prototype, '_complete');
        const hasOwnStreamingCompletion = Object.hasOwn(prototype, '_streamComplete');
        const useStreamingTransport = typeof this._streamComplete === 'function'
            && (hasOwnStreamingCompletion || !hasOwnBufferedCompletion);

        for (let turn = 0; turn <= maxContinuationTurns; turn++) {
            let response;
            const streamedTextParts = [];
            const streamedReasoningParts = [];
            const requestOptions = requestOptionsWithEffectiveOutputBudget(
                requestMessages,
                options,
                this._config,
            );

            for (let reconnectAttempt = 0; ; ) {
                let emittedResponseContent = false;

                try {
                    if (useStreamingTransport) {
                        for await (const chunk of this._streamComplete(
                            requestMessages,
                            options.model?.id ?? this._config.defaultModelId,
                            requestOptions,
                        )) {
                            if (chunk?.type === 'response') {
                                response = normalizeProviderResponse(chunk.response);
                            } else if (chunk?.type === 'reasoning') {
                                const reasoning = String(chunk.text ?? '');
                                streamedReasoningParts.push(reasoning);
                                emittedResponseContent ||= Boolean(reasoning);
                                yield { type: 'reasoning', text: reasoning };
                            } else {
                                const text = String(chunk?.text ?? chunk ?? '');
                                streamedTextParts.push(text);
                                emittedResponseContent ||= Boolean(text);

                                if (text)
                                    yield text;
                            }
                        }

                        if (!response)
                            throw createUserVisibleError(`${this.name} response stream did not include a final response.`);
                    } else {
                        response = normalizeProviderResponse(await this._complete(
                            requestMessages,
                            options.model?.id ?? this._config.defaultModelId,
                            requestOptions,
                        ));
                    }

                    break;
                } catch (error) {
                    const retryableHttpError = isRetryableHttpError(error);
                    const retryableInterruptedResponse = isRetryableInterruptedResponse(error);
                    const canReplayInterruptedResponse = retryableHttpError
                        || !error?.providerResponseStarted
                        || retryableInterruptedResponse;
                    const shouldReconnect = reconnectAttempt < MAX_NETWORK_RECONNECTS
                        && !isCancelled(options.cancellable)
                        && !emittedResponseContent
                        && canReplayInterruptedResponse
                        && (retryableHttpError || retryableInterruptedResponse || isNetworkError(error));

                    if (!shouldReconnect)
                        throw error;

                    reconnectAttempt++;
                    const statusPrefix = retryableHttpError
                        ? 'Request timed out. Retrying'
                        : error?.providerResponseStarted
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

            const streamedText = streamedTextParts.join('');
            const streamedReasoning = streamedReasoningParts.join('');

            if (!response.text
                && !streamedText
                && !response.reasoning
                && !streamedReasoning
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

            let turnReasoning;

            if (response.reasoning.startsWith(streamedReasoning)) {
                const remainingReasoning = response.reasoning.slice(streamedReasoning.length);
                turnReasoning = streamedReasoning + remainingReasoning;

                if (remainingReasoning) {
                    yield {
                        type: 'reasoning',
                        text: remainingReasoning,
                    };
                }
            } else if (streamedReasoning && response.reasoning) {
                turnReasoning = response.reasoning;
                yield {
                    type: 'reasoning',
                    text: assistantReasoning + response.reasoning,
                    replace: true,
                };
            } else {
                turnReasoning = streamedReasoning || response.reasoning;

                if (!streamedReasoning && response.reasoning) {
                    yield {
                        type: 'reasoning',
                        text: response.reasoning,
                    };
                }
            }

            assistantReasoning += turnReasoning;

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

            let turnText;

            if (response.text.startsWith(streamedText)) {
                const remainingText = response.text.slice(streamedText.length);
                turnText = streamedText + remainingText;

                if (remainingText) {
                    if (useStreamingTransport)
                        yield remainingText;
                    else
                        yield* displayStream(remainingText, options.cancellable ?? null);
                }
            } else if (streamedText) {
                turnText = response.text;
                yield {
                    type: 'text',
                    text: assistantText + response.text,
                    replace: true,
                };
            } else {
                turnText = response.text;

                if (response.text) {
                    if (useStreamingTransport)
                        yield response.text;
                    else
                        yield* displayStream(response.text, options.cancellable ?? null);
                }
            }

            assistantText += turnText;

            if (response.toolCalls.length > 0) {
                yield {
                    type: 'tool_calls',
                    toolCalls: response.toolCalls,
                    integrity: response.toolCallIntegrity,
                };
                return;
            }

            if (!turnText
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
    async *_streamComplete(messages, modelId, options = {}) {
        const state = new OpenAiResponsesStreamState(this.name);

        for await (const event of postJsonStream(
            normalizeUrl(this._config.baseUrl, '/responses'),
            { Authorization: `Bearer ${getApiKey(this._config)}` },
            buildOpenAiResponsesBody(messages, modelId, {
                provider: this._config,
                model: options.model,
                tools: options.tools,
                disableNativeSearch: options.disableNativeSearch,
                thinkingLevel: options.thinkingLevel,
                maxOutputTokens: options.maxOutputTokens,
                stream: true,
            }),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        )) {
            for (const delta of state.push(event.data, event.done))
                yield delta;
        }

        yield { type: 'response', response: extractOpenAiResponse(state.finish(), options) };
    }

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
    async *_streamComplete(messages, modelId, options = {}) {
        const state = new ChatCompletionStreamState(this.name);

        for await (const event of postJsonStream(
            normalizeUrl(this._config.baseUrl, this._config.chatPath ?? '/chat/completions'),
            { Authorization: `Bearer ${getApiKey(this._config)}` },
            buildOpenAiCompatibleChatBody(messages, modelId, {
                provider: this._config,
                model: options.model,
                tools: options.tools,
                disableNativeSearch: options.disableNativeSearch,
                thinkingLevel: options.thinkingLevel,
                maxOutputTokens: options.maxOutputTokens,
                stream: true,
            }),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        )) {
            for (const delta of state.push(event.data, event.done))
                yield delta;
        }

        yield { type: 'response', response: extractChatCompletionResponse(state.finish()) };
    }

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
    async *_streamComplete(messages, modelId, options = {}) {
        const state = new AnthropicStreamState(this.name);

        for await (const event of postJsonStream(
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
                stream: true,
            }),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        )) {
            for (const delta of state.push(event.data, event.done))
                yield delta;
        }

        yield { type: 'response', response: extractAnthropicResponse(state.finish()) };
    }

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
    async *_streamComplete(messages, modelId, options = {}) {
        const url = `${normalizeUrl(this._config.baseUrl, `/models/${modelId}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(getApiKey(this._config))}`;
        const state = new GeminiStreamState(this.name);

        for await (const event of postJsonStream(url, {}, buildGeminiGenerateContentBody(messages, {
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
        })) {
            for (const delta of state.push(event.data, event.done))
                yield delta;
        }

        yield { type: 'response', response: extractGeminiResponse(state.finish()) };
    }

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
