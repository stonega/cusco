const TOKEN_USAGE_FIELDS = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
];

function normalizeTokenCount(value) {
    const count = Number(value);

    if (!Number.isFinite(count) || count < 0)
        return null;

    return Math.round(count);
}

function firstTokenCount(...values) {
    for (const value of values) {
        const count = normalizeTokenCount(value);

        if (count !== null)
            return count;
    }

    return null;
}

function hasTokenCounts(usage) {
    return TOKEN_USAGE_FIELDS.some((field) => Number.isFinite(usage[field]));
}

function addOptionalString(target, key, value) {
    const stringValue = String(value ?? '').trim();

    if (stringValue)
        target[key] = stringValue;
}

export function normalizeTokenUsage(value, metadata = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;

    const usage = {
        inputTokens: firstTokenCount(
            value.inputTokens,
            value.input_tokens,
            value.prompt_tokens,
            value.promptTokenCount,
            value.total_input_tokens,
        ),
        outputTokens: firstTokenCount(
            value.outputTokens,
            value.output_tokens,
            value.completion_tokens,
            value.candidatesTokenCount,
            value.total_output_tokens,
        ),
        reasoningTokens: firstTokenCount(
            value.reasoningTokens,
            value.reasoning_tokens,
            value.thinking_tokens,
            value.thoughtsTokenCount,
            value.total_thought_tokens,
            value.output_tokens_details?.reasoning_tokens,
            value.completion_tokens_details?.reasoning_tokens,
        ),
        totalTokens: firstTokenCount(
            value.totalTokens,
            value.total_tokens,
            value.totalTokenCount,
        ),
        cachedInputTokens: firstTokenCount(
            value.cachedInputTokens,
            value.cached_input_tokens,
            value.cachedContentTokenCount,
            value.input_tokens_details?.cached_tokens,
            value.prompt_tokens_details?.cached_tokens,
            value.cache_read_input_tokens,
        ),
        cacheCreationInputTokens: firstTokenCount(
            value.cacheCreationInputTokens,
            value.cache_creation_input_tokens,
        ),
        cacheReadInputTokens: firstTokenCount(
            value.cacheReadInputTokens,
            value.cache_read_input_tokens,
        ),
    };

    if (usage.totalTokens === null) {
        const countedTokens = [
            usage.inputTokens,
            usage.outputTokens,
            usage.outputTokens === null ? usage.reasoningTokens : null,
        ].filter(Number.isFinite);

        usage.totalTokens = countedTokens.length > 0
            ? countedTokens.reduce((sum, count) => sum + count, 0)
            : null;
    }

    const normalized = {};

    for (const field of TOKEN_USAGE_FIELDS) {
        if (usage[field] !== null)
            normalized[field] = usage[field];
    }

    if (!hasTokenCounts(normalized))
        return null;

    if (value.estimated !== undefined || metadata.estimated !== undefined)
        normalized.estimated = Boolean(value.estimated ?? metadata.estimated);

    addOptionalString(normalized, 'providerId', metadata.providerId ?? value.providerId);
    addOptionalString(normalized, 'modelId', metadata.modelId ?? value.modelId);
    addOptionalString(normalized, 'thinkingLevel', metadata.thinkingLevel ?? value.thinkingLevel);

    normalized.createdAt = String(metadata.createdAt ?? value.createdAt ?? new Date().toISOString());

    return normalized;
}
