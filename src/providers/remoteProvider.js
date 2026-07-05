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
};
const ANTHROPIC_DEFAULT_THINKING_BUDGETS = {
    auto: 2048,
    low: 1024,
    medium: 2048,
    high: 3072,
};
const SUPPORTED_GEMINI_MODEL_IDS = new Set([
    'gemini-3.5-flash',
    'gemini-3.1-pro-preview',
]);
const MAX_NATIVE_TOOL_DESCRIPTION_CHARS = 1024;
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

function normalizeProviderResponse(response) {
    if (typeof response === 'string')
        return { text: response, reasoning: '', toolCalls: [] };

    if (!response || typeof response !== 'object')
        return { text: '', reasoning: '', toolCalls: [] };

    return {
        text: String(response.text ?? ''),
        reasoning: String(response.reasoning ?? ''),
        usage: normalizeTokenUsage(response.usage),
        finishReason: String(response.finishReason ?? ''),
        toolCalls: Array.isArray(response.toolCalls)
            ? response.toolCalls.map((toolCall) => ({
                id: String(toolCall?.id ?? ''),
                name: String(toolCall?.name ?? '').trim(),
                input: String(toolCall?.input ?? ''),
            })).filter((toolCall) => toolCall.name)
            : [],
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
        .map((part) => part.functionCall ?? part.function_call ?? null)
        .filter(Boolean)
        .map((call) => ({
            id: '',
            name: String(call.name ?? '').trim(),
            input: toolInputFromValue(call.args ?? call.arguments ?? {}),
        }))
        .filter((toolCall) => toolCall.name);
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
        return { type: 'disabled' };

    if (thinking.api === 'anthropic-adaptive') {
        const request = {
            type: 'adaptive',
            display: thinking.display ?? 'summarized',
        };

        if (thinking.level !== 'auto')
            request.effort = thinking.level;

        return request;
    }

    if (thinking.api === 'anthropic-budget') {
        const budgets = thinking.budgets ?? ANTHROPIC_DEFAULT_THINKING_BUDGETS;
        const budget = budgets[thinking.level] ?? budgets.medium ?? ANTHROPIC_DEFAULT_THINKING_BUDGETS.medium;

        return {
            type: 'enabled',
            budget_tokens: budget,
            display: thinking.display ?? 'summarized',
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

    return null;
}

export function buildOpenAiResponsesBody(messages, modelId, options = {}) {
    const body = {
        model: modelId,
        input: openAiMessages(messages),
        max_output_tokens: normalizeMaxOutputTokens(options.maxOutputTokens),
    };

    const reasoning = buildOpenAiReasoningConfig(options.provider ?? options.config, options.model, options.thinkingLevel);

    if (reasoning)
        body.reasoning = reasoning;

    const tools = openAiResponsesToolDefinitions(options.tools);

    if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }

    return body;
}

export function buildOpenAiCompatibleChatBody(messages, modelId, options = {}) {
    const body = {
        model: modelId,
        messages: openAiCompatibleMessages(messages),
        max_tokens: normalizeMaxOutputTokens(options.maxOutputTokens),
        stream: false,
    };
    const thinking = buildOpenAiCompatibleThinkingConfig(options.provider ?? options.config, options.model, options.thinkingLevel);
    const tools = openAiCompatibleToolDefinitions(options.tools);

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
    const thinking = buildAnthropicThinkingConfig(options.provider ?? options.config, options.model, options.thinkingLevel);
    const body = {
        model: modelId,
        max_tokens: normalizeMaxOutputTokens(options.maxOutputTokens),
        messages: conversationMessages,
    };

    if (system)
        body.system = system;

    if (thinking) {
        body.thinking = thinking;

        if (Number.isFinite(thinking.budget_tokens) && thinking.budget_tokens >= body.max_tokens)
            body.max_tokens = thinking.budget_tokens + 1024;
    }

    const tools = anthropicToolDefinitions(options.tools);

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

    const tools = geminiToolDefinitions(options.tools);

    if (tools.length > 0)
        payload.tools = tools;

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

export function extractOpenAiResponse(response) {
    return {
        text: extractOpenAiText(response),
        reasoning: extractOpenAiReasoning(response),
        usage: extractOpenAiUsage(response),
        finishReason: extractOpenAiFinishReason(response),
        toolCalls: extractOpenAiToolCalls(response),
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
    return {
        text: extractChatCompletionText(response),
        reasoning: extractChatCompletionReasoning(response),
        usage: extractChatCompletionUsage(response),
        finishReason: extractChatCompletionFinishReason(response),
        toolCalls: extractChatCompletionToolCalls(response),
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
    return {
        text: extractAnthropicText(response),
        reasoning: extractAnthropicReasoning(response),
        usage: extractAnthropicUsage(response),
        finishReason: extractAnthropicFinishReason(response),
        toolCalls: extractAnthropicToolCalls(response),
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

export function extractGeminiResponse(response) {
    return {
        text: extractGeminiText(response),
        reasoning: extractGeminiReasoning(response),
        usage: extractGeminiUsage(response),
        finishReason: extractGeminiFinishReason(response),
        toolCalls: extractGeminiToolCalls(response),
    };
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
            const response = normalizeProviderResponse(await this._complete(
                requestMessages,
                options.model?.id ?? this._config.defaultModelId,
                options,
            ));

            if (!response.text && !response.reasoning && !response.usage && response.toolCalls.length === 0)
                throw new Error(`${this.name} returned an empty response`);

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
                thinkingLevel: options.thinkingLevel,
                maxOutputTokens: options.maxOutputTokens,
            }),
            {
                cancellable: options.cancellable ?? null,
                providerName: this.name,
                timeoutSeconds: options.timeoutSeconds,
            },
        );

        return extractOpenAiResponse(response);
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
