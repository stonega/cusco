export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
export const MIN_MAX_OUTPUT_TOKENS = 1;
export const DEFAULT_MAX_CONTINUATION_TURNS = 2;
export const CONTEXT_OUTPUT_RESERVE_TOKENS = 4096;
export const OUTPUT_CAPACITY_ERROR_CODE = 'CUSCO_OUTPUT_CAPACITY';

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

export function normalizeMaxOutputTokens(value) {
    const tokens = Number(value);

    if (!Number.isFinite(tokens) || tokens <= 0)
        return DEFAULT_MAX_OUTPUT_TOKENS;

    return Math.max(MIN_MAX_OUTPUT_TOKENS, Math.round(tokens));
}

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? '';
    } catch (_error) {
        return '[unserializable]';
    }
}

function estimateMessageInputCharacters(message) {
    let characters = String(message?.content ?? '').length;

    if (Array.isArray(message?.toolCalls))
        characters += safeJsonStringify(message.toolCalls).length;

    const providerParts = message?.providerParts ?? message?.metadata?.geminiProviderParts;

    if (Array.isArray(providerParts))
        characters += safeJsonStringify(providerParts).length;

    for (const attachment of message?.attachments ?? []) {
        if (attachment?.kind === 'image')
            characters += ESTIMATED_IMAGE_CHARS;
        else
            characters += safeJsonStringify({
                kind: attachment?.kind,
                name: attachment?.name,
                path: attachment?.path,
                contentType: attachment?.contentType ?? attachment?.mimeType,
            }).length;
    }

    return characters;
}

export function estimateRequestInputTokens(messages, tools = []) {
    const messageCharacters = (Array.isArray(messages) ? messages : [])
        .filter((message) => !message?.reasoning?.agentMode)
        .reduce((total, message) => total + estimateMessageInputCharacters(message), 0);
    const toolCharacters = Array.isArray(tools) && tools.length > 0
        ? safeJsonStringify(tools).length
        : 0;

    return Math.ceil((messageCharacters + toolCharacters) / CHARS_PER_TOKEN);
}

export function resolveEffectiveMaxOutputTokens({
    configuredMaxOutputTokens,
    callMaxOutputTokens,
    contextWindowTokens,
    estimatedInputTokens = 0,
    reserveTokens = CONTEXT_OUTPUT_RESERVE_TOKENS,
} = {}) {
    const configuredMaximum = normalizeMaxOutputTokens(configuredMaxOutputTokens);
    const requestedCallCap = Number(callMaxOutputTokens);
    const configuredWithCallCap = Number.isFinite(requestedCallCap) && requestedCallCap > 0
        ? Math.min(configuredMaximum, Math.round(requestedCallCap))
        : configuredMaximum;
    const contextWindow = Number(contextWindowTokens);

    if (!Number.isFinite(contextWindow) || contextWindow <= 0)
        return configuredWithCallCap;

    const inputTokens = Math.max(0, Math.round(Number(estimatedInputTokens) || 0));
    const reserve = Math.max(0, Math.round(Number(reserveTokens) || 0));
    const available = Math.floor(contextWindow - inputTokens - reserve);

    if (available <= 0)
        return 0;

    return Math.min(configuredWithCallCap, available);
}

export function createOutputCapacityError(message = 'The conversation does not have enough context capacity for another response.') {
    const error = new Error(message);
    error.code = OUTPUT_CAPACITY_ERROR_CODE;
    error.userMessage = message;
    error.nonRetryable = true;
    return error;
}

export function isOutputCapacityError(error) {
    return error?.code === OUTPUT_CAPACITY_ERROR_CODE;
}
