export function estimateTokenCount(text) {
    const normalized = String(text ?? '').trim();

    if (!normalized)
        return 0;

    return Math.max(1, Math.ceil(normalized.length / 4));
}

export function estimateConversationUsage(messages) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const characters = safeMessages.reduce((total, message) => (
        total + String(message?.content ?? '').length
    ), 0);
    const tokens = safeMessages.reduce((total, message) => (
        total + estimateTokenCount(message?.content)
    ), 0);

    return {
        characters,
        messages: safeMessages.length,
        tokens,
    };
}

function tokenCount(value) {
    const count = Number(value);

    return Number.isFinite(count) && count >= 0 ? Math.round(count) : 0;
}

function tokenInputBreakdown(usage) {
    const inputTokens = tokenCount(usage?.inputTokens);
    const hasSeparateCacheCounts = Number.isFinite(usage?.cacheCreationInputTokens)
        || Number.isFinite(usage?.cacheReadInputTokens);

    if (hasSeparateCacheCounts) {
        const cacheCreationTokens = tokenCount(usage.cacheCreationInputTokens);
        const cacheReadTokens = tokenCount(usage.cacheReadInputTokens);

        return {
            inputTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
            cachedInputTokens: cacheReadTokens,
        };
    }

    return {
        inputTokens,
        cachedInputTokens: Math.min(inputTokens, tokenCount(usage?.cachedInputTokens)),
    };
}

function hasToolResult(toolCall) {
    return String(toolCall?.status ?? 'completed').toLowerCase() !== 'running';
}

export function summarizeConversationStatistics(messages) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const statistics = {
        totalMessages: safeMessages.length,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
    };

    for (const message of safeMessages) {
        if (message?.role === 'user')
            statistics.userMessages += 1;
        else if (message?.role === 'assistant')
            statistics.assistantMessages += 1;

        if (message?.toolCall) {
            statistics.toolCalls += 1;

            if (hasToolResult(message.toolCall))
                statistics.toolResults += 1;
        }

        if (!message?.usage)
            continue;

        const input = tokenInputBreakdown(message.usage);
        const outputTokens = tokenCount(message.usage.outputTokens);
        statistics.inputTokens += input.inputTokens;
        statistics.cachedInputTokens += input.cachedInputTokens;
        statistics.outputTokens += outputTokens;
        statistics.totalTokens += Math.max(
            input.inputTokens + outputTokens,
            tokenCount(message.usage.totalTokens),
        );
    }

    statistics.cachedInputTokens = Math.min(
        statistics.inputTokens,
        statistics.cachedInputTokens,
    );
    statistics.uncachedInputTokens = statistics.inputTokens - statistics.cachedInputTokens;
    return statistics;
}
