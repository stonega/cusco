import {
    estimateConversationUsage,
    estimateTokenCount,
    summarizeConversationStatistics,
    summarizeUsageDashboard,
} from '../src/chat/usage.js';

if (estimateTokenCount('') !== 0)
    throw new Error('Empty text should estimate to zero tokens');

if (estimateTokenCount('hello') !== 2)
    throw new Error(`Unexpected token estimate for short text: ${estimateTokenCount('hello')}`);

const usage = estimateConversationUsage([
    { content: 'hello' },
    { content: 'world!' },
]);

if (usage.messages !== 2 || usage.tokens !== 4 || usage.characters !== 11)
    throw new Error(`Unexpected conversation usage: ${JSON.stringify(usage)}`);

const statistics = summarizeConversationStatistics([
    { role: 'user', content: 'First prompt' },
    {
        role: 'assistant',
        content: 'First answer',
        usage: {
            inputTokens: 7129883,
            cachedInputTokens: 6776832,
            outputTokens: 30013,
            totalTokens: 7159896,
        },
    },
    {
        role: 'system',
        toolCall: {
            status: 'completed',
            output: 'Done',
        },
    },
    {
        role: 'system',
        toolCall: {
            status: 'running',
        },
    },
]);

if (statistics.totalMessages !== 4
    || statistics.userMessages !== 1
    || statistics.assistantMessages !== 1
    || statistics.toolCalls !== 2
    || statistics.toolResults !== 1) {
    throw new Error(`Unexpected message statistics: ${JSON.stringify(statistics)}`);
}

if (statistics.inputTokens !== 7129883
    || statistics.cachedInputTokens !== 6776832
    || statistics.uncachedInputTokens !== 353051
    || statistics.outputTokens !== 30013
    || statistics.totalTokens !== 7159896) {
    throw new Error(`Unexpected token statistics: ${JSON.stringify(statistics)}`);
}

const separateCacheStatistics = summarizeConversationStatistics([{
    role: 'assistant',
    usage: {
        inputTokens: 12,
        outputTokens: 14,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 5,
        totalTokens: 26,
    },
}]);

if (separateCacheStatistics.inputTokens !== 19
    || separateCacheStatistics.cachedInputTokens !== 5
    || separateCacheStatistics.uncachedInputTokens !== 14
    || separateCacheStatistics.totalTokens !== 33) {
    throw new Error(
        `Unexpected separate cache statistics: ${JSON.stringify(separateCacheStatistics)}`,
    );
}

const totalOnlyStatistics = summarizeConversationStatistics([{
    role: 'assistant',
    usage: {
        totalTokens: 42,
    },
}]);

if (totalOnlyStatistics.totalTokens !== 42)
    throw new Error(`Total-only usage was lost: ${JSON.stringify(totalOnlyStatistics)}`);

const localTimestamp = (year, month, day, hour = 12) => (
    new Date(year, month - 1, day, hour).toISOString()
);
const dashboard = summarizeUsageDashboard([
    {
        id: 'chat-openai',
        providerId: 'openai',
        modelId: 'gpt-5',
        messages: [
            {
                role: 'assistant',
                createdAt: localTimestamp(2026, 8, 9, 5),
                usage: {
                    inputTokens: 120,
                    cachedInputTokens: 80,
                    outputTokens: 30,
                    totalTokens: 150,
                },
            },
            {
                role: 'assistant',
                createdAt: localTimestamp(2026, 8, 8, 5),
                usage: {
                    inputTokens: 50,
                    outputTokens: 10,
                    totalTokens: 60,
                    providerId: 'anthropic',
                    modelId: 'claude-sonnet',
                },
            },
            {
                role: 'assistant',
                createdAt: localTimestamp(2026, 7, 1, 5),
                usage: {
                    inputTokens: 999,
                    outputTokens: 999,
                    totalTokens: 1998,
                },
            },
        ],
    },
    {
        id: 'chat-unreported',
        providerId: 'gemini',
        modelId: 'gemini-pro',
        messages: [{
            role: 'assistant',
            createdAt: localTimestamp(2026, 8, 7, 5),
            content: 'No provider usage metadata',
        }],
    },
], {
    days: 7,
    now: new Date(2026, 7, 9, 12),
});

if (dashboard.days !== 7
    || dashboard.daily.length !== 7
    || dashboard.totalTokens !== 210
    || dashboard.inputTokens !== 170
    || dashboard.cachedInputTokens !== 80
    || dashboard.uncachedInputTokens !== 90
    || dashboard.outputTokens !== 40
    || dashboard.reportedMessages !== 2
    || dashboard.assistantMessages !== 3
    || dashboard.conversationCount !== 2) {
    throw new Error(`Unexpected dashboard totals: ${JSON.stringify(dashboard)}`);
}

if (dashboard.breakdown.length !== 2
    || dashboard.breakdown[0].providerId !== 'openai'
    || dashboard.breakdown[0].totalTokens !== 150
    || dashboard.breakdown[1].providerId !== 'anthropic'
    || dashboard.breakdown[1].totalTokens !== 60) {
    throw new Error(`Unexpected dashboard breakdown: ${JSON.stringify(dashboard.breakdown)}`);
}

if (dashboard.daily.at(-1).date !== '2026-08-09'
    || dashboard.daily.at(-1).totalTokens !== 150
    || dashboard.daily.at(-2).totalTokens !== 60) {
    throw new Error(`Unexpected dashboard daily series: ${JSON.stringify(dashboard.daily)}`);
}

print('Cusco usage smoke passed');
