import { estimateConversationUsage, estimateTokenCount } from '../src/chat/usage.js';

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

print('Cusco usage smoke passed');
