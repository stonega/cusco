import {
    AUTO_COMPACTION_THRESHOLD_RATIO,
    buildCompactedMessageList,
    buildCompactionPrompt,
    CONTEXT_COMPACTION_SUMMARY_KIND,
    createCompactionSummaryMessage,
    findCompactionBoundary,
    getContextUsageState,
    prepareContextCompaction,
} from '../src/chat/compaction.js';
import { createMessage } from '../src/providers/provider.js';

function assertEqual(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const belowThreshold = getContextUsageState([
    createMessage('user', 'a'.repeat(316)),
], 100);
assertEqual(belowThreshold.tokens, 79, 'Below-threshold token estimate');
assertEqual(belowThreshold.shouldCompact, false, '79% should not compact');

const atThreshold = getContextUsageState([
    createMessage('user', 'a'.repeat(320)),
], 100);
assertEqual(atThreshold.tokens, 80, 'At-threshold token estimate');
assertEqual(atThreshold.thresholdRatio, AUTO_COMPACTION_THRESHOLD_RATIO, 'Default threshold ratio');
assertEqual(atThreshold.shouldCompact, true, '80% should compact');

const messages = [
    createMessage('user', 'First task details '.repeat(20)),
    createMessage('assistant', 'First answer '.repeat(20)),
    createMessage('user', 'Second task details '.repeat(20)),
    createMessage('assistant', 'Second answer '.repeat(20)),
    createMessage('user', 'Latest request'),
    createMessage('assistant', 'Latest answer'),
];
const boundary = findCompactionBoundary(messages, 1000);
assertEqual(messages[boundary].role, 'user', 'Compaction boundary should start at a user turn');

const previousSummary = createCompactionSummaryMessage('Previous compacted state', {
    providerId: 'openai',
    modelId: 'gpt-test',
    tokensBefore: 100,
    tokensAfter: 20,
    messagesCompacted: 2,
});
const compaction = prepareContextCompaction([
    previousSummary,
    ...messages,
], 1000);

if (!compaction)
    throw new Error('Expected compaction preparation');

if (compaction.previousSummary !== 'Previous compacted state')
    throw new Error('Previous summary was not carried forward');

const prompt = buildCompactionPrompt(compaction);

if (!prompt.includes('Previous compacted state') || !prompt.includes('Messages being compacted'))
    throw new Error('Compaction prompt did not include required sections');

const compacted = buildCompactedMessageList('Fresh compacted summary', compaction, {
    providerId: 'openai',
    modelId: 'gpt-test',
});

assertEqual(compacted[0].role, 'system', 'Summary checkpoint role');
assertEqual(compacted[0].metadata.kind, CONTEXT_COMPACTION_SUMMARY_KIND, 'Summary checkpoint metadata kind');

if (!compacted[0].content.includes('Fresh compacted summary'))
    throw new Error('Summary checkpoint content did not include summary');

if (compacted.length >= messages.length + 1)
    throw new Error('Compacted message list did not reduce message count');

print('Cusco compaction smoke passed');
