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

function summarizeTokenUsage(usage) {
    const input = tokenInputBreakdown(usage);
    const inputTokens = input.inputTokens;
    const cachedInputTokens = Math.min(inputTokens, input.cachedInputTokens);
    const outputTokens = tokenCount(usage?.outputTokens);

    return {
        inputTokens,
        cachedInputTokens,
        uncachedInputTokens: inputTokens - cachedInputTokens,
        outputTokens,
        totalTokens: Math.max(
            inputTokens + outputTokens,
            tokenCount(usage?.totalTokens),
        ),
    };
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

        const usage = summarizeTokenUsage(message.usage);
        statistics.inputTokens += usage.inputTokens;
        statistics.cachedInputTokens += usage.cachedInputTokens;
        statistics.outputTokens += usage.outputTokens;
        statistics.totalTokens += usage.totalTokens;
    }

    statistics.cachedInputTokens = Math.min(
        statistics.inputTokens,
        statistics.cachedInputTokens,
    );
    statistics.uncachedInputTokens = statistics.inputTokens - statistics.cachedInputTokens;
    return statistics;
}

function localDayTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);

    if (!Number.isFinite(date.getTime()))
        return null;

    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localDayKey(timestamp) {
    const date = new Date(timestamp);
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
    ].join('-');
}

function usageIdentity(conversation, message) {
    return {
        providerId: String(message?.usage?.providerId ?? conversation?.providerId ?? '').trim()
            || 'unknown',
        modelId: String(message?.usage?.modelId ?? conversation?.modelId ?? '').trim()
            || 'unknown',
    };
}

export function summarizeUsageDashboard(conversations, options = {}) {
    const days = Math.max(1, Math.round(Number(options.days) || 30));
    const today = localDayTimestamp(options.now ?? new Date()) ?? localDayTimestamp(new Date());
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (days - 1));
    const daily = Array.from({ length: days }, (_value, index) => {
        const date = new Date(startDate);
        date.setDate(date.getDate() + index);

        return {
            date: localDayKey(date.getTime()),
            totalTokens: 0,
        };
    });
    const start = startDate.getTime();
    const dailyByDate = new Map(daily.map((entry) => [entry.date, entry]));
    const breakdownByIdentity = new Map();
    const conversationIds = new Set();
    const summary = {
        days,
        startDate: daily[0].date,
        endDate: daily.at(-1).date,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalMessages: 0,
        assistantMessages: 0,
        reportedMessages: 0,
        estimatedMessages: 0,
        conversationCount: 0,
        daily,
        breakdown: [],
    };

    for (const conversation of Array.isArray(conversations) ? conversations : []) {
        for (const message of Array.isArray(conversation?.messages) ? conversation.messages : []) {
            const messageDay = localDayTimestamp(
                message?.usage?.createdAt
                ?? message?.createdAt
                ?? conversation?.updatedAt,
            );

            if (messageDay === null || messageDay < start || messageDay > today)
                continue;

            summary.totalMessages += 1;
            conversationIds.add(String(conversation?.id ?? ''));

            if (message?.role === 'assistant')
                summary.assistantMessages += 1;

            if (!message?.usage)
                continue;

            const statistics = summarizeTokenUsage(message.usage);
            const date = localDayKey(messageDay);
            const dailyEntry = dailyByDate.get(date);
            const { providerId, modelId } = usageIdentity(conversation, message);
            const identityKey = `${providerId}\u0000${modelId}`;
            let breakdownEntry = breakdownByIdentity.get(identityKey);

            if (!breakdownEntry) {
                breakdownEntry = {
                    providerId,
                    modelId,
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                };
                breakdownByIdentity.set(identityKey, breakdownEntry);
            }

            if (message?.role === 'assistant')
                summary.reportedMessages += 1;
            summary.estimatedMessages += message.usage.estimated ? 1 : 0;

            summary.inputTokens += statistics.inputTokens;
            summary.cachedInputTokens += statistics.cachedInputTokens;
            summary.outputTokens += statistics.outputTokens;
            summary.totalTokens += statistics.totalTokens;
            dailyEntry.totalTokens += statistics.totalTokens;
            breakdownEntry.inputTokens += statistics.inputTokens;
            breakdownEntry.outputTokens += statistics.outputTokens;
            breakdownEntry.totalTokens += statistics.totalTokens;
        }
    }

    summary.uncachedInputTokens = summary.inputTokens - summary.cachedInputTokens;
    summary.conversationCount = conversationIds.size;
    summary.breakdown = [...breakdownByIdentity.values()].sort((left, right) => (
        right.totalTokens - left.totalTokens
        || left.providerId.localeCompare(right.providerId)
        || left.modelId.localeCompare(right.modelId)
    ));
    return summary;
}
