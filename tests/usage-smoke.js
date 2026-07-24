import {
    estimateConversationUsage,
    estimateTokenCount,
    summarizeConversationStatistics,
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

print('Cusco usage smoke passed');
