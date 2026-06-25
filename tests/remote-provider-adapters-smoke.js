import {
    buildAnthropicMessagesBody,
    buildGeminiGenerateContentBody,
    buildOpenAiCompatibleChatBody,
    buildOpenAiResponsesBody,
    extractAnthropicReasoning,
    extractAnthropicText,
    extractAnthropicUsage,
    extractChatCompletionReasoning,
    extractChatCompletionText,
    extractChatCompletionUsage,
    extractDiscoveredModels,
    extractGeminiReasoning,
    extractGeminiText,
    extractGeminiUsage,
    extractOpenAiReasoning,
    extractOpenAiText,
    extractOpenAiUsage,
} from '../src/providers/remoteProvider.js';
import { createMessage } from '../src/providers/provider.js';

function assertEqual(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const messages = [
    createMessage('assistant', 'This welcome message should not be sent.'),
    createMessage('system', 'Keep answers concise.'),
    createMessage('user', 'Hello'),
    createMessage('assistant', 'Hi'),
    createMessage('user', 'Summarize Cusco'),
];

const openAiBody = buildOpenAiResponsesBody(messages, 'gpt-test');
assertEqual(openAiBody.model, 'gpt-test', 'OpenAI model');
assertEqual(openAiBody.input.length, 4, 'OpenAI filtered message count');
assertEqual(openAiBody.input[0].role, 'developer', 'OpenAI system role');

const openAiThinkingBody = buildOpenAiResponsesBody(messages, 'gpt-test', {
    provider: {
        thinking: {
            api: 'openai-responses',
            levels: ['off', 'auto', 'low', 'medium', 'high'],
            summary: 'auto',
        },
    },
    thinkingLevel: 'high',
});
assertEqual(openAiThinkingBody.reasoning.effort, 'high', 'OpenAI reasoning effort');
assertEqual(openAiThinkingBody.reasoning.summary, 'auto', 'OpenAI reasoning summary');

const chatBody = buildOpenAiCompatibleChatBody(messages, 'chat-test');
assertEqual(chatBody.messages[0].role, 'system', 'OpenAI-compatible system role');
assertEqual(chatBody.stream, false, 'OpenAI-compatible stream flag');

const anthropicBody = buildAnthropicMessagesBody(messages, 'claude-test');
assertEqual(anthropicBody.model, 'claude-test', 'Anthropic model');
assertEqual(anthropicBody.system, 'Keep answers concise.', 'Anthropic system text');
assertEqual(anthropicBody.messages.length, 3, 'Anthropic conversation message count');

const anthropicThinkingBody = buildAnthropicMessagesBody(messages, 'claude-test', {
    provider: {
        thinking: {
            api: 'anthropic-adaptive',
            levels: ['off', 'auto', 'low', 'medium', 'high'],
            display: 'summarized',
        },
    },
    thinkingLevel: 'low',
});
assertEqual(anthropicThinkingBody.thinking.type, 'adaptive', 'Anthropic thinking type');
assertEqual(anthropicThinkingBody.thinking.effort, 'low', 'Anthropic thinking effort');
assertEqual(anthropicThinkingBody.thinking.display, 'summarized', 'Anthropic thinking display');

const geminiBody = buildGeminiGenerateContentBody(messages);
assertEqual(geminiBody.systemInstruction.parts[0].text, 'Keep answers concise.', 'Gemini system instruction');
assertEqual(geminiBody.contents[1].role, 'model', 'Gemini assistant role');

assertEqual(extractOpenAiText({ output_text: 'OpenAI text' }), 'OpenAI text', 'OpenAI output_text extraction');
assertEqual(extractOpenAiReasoning({
    output: [{
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'OpenAI reasoning' }],
    }],
}), 'OpenAI reasoning', 'OpenAI reasoning extraction');
const openAiUsage = extractOpenAiUsage({
    usage: {
        input_tokens: 10,
        output_tokens: 8,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 5 },
    },
});
assertEqual(openAiUsage.inputTokens, 10, 'OpenAI input token extraction');
assertEqual(openAiUsage.reasoningTokens, 5, 'OpenAI reasoning token extraction');
assertEqual(openAiUsage.cachedInputTokens, 3, 'OpenAI cached token extraction');
assertEqual(extractChatCompletionText({ choices: [{ message: { content: 'Chat text' } }] }), 'Chat text', 'Chat extraction');
assertEqual(extractChatCompletionReasoning({ choices: [{ message: { reasoning_content: 'Chat reasoning' } }] }), 'Chat reasoning', 'Chat reasoning extraction');
assertEqual(extractChatCompletionUsage({
    usage: {
        prompt_tokens: 7,
        completion_tokens: 9,
        total_tokens: 16,
        completion_tokens_details: { reasoning_tokens: 4 },
    },
}).reasoningTokens, 4, 'Chat reasoning token extraction');
assertEqual(extractAnthropicText({ content: [{ type: 'text', text: 'Claude text' }] }), 'Claude text', 'Anthropic extraction');
assertEqual(extractAnthropicReasoning({ content: [{ type: 'thinking', thinking: 'Claude reasoning' }] }), 'Claude reasoning', 'Anthropic reasoning extraction');
assertEqual(extractAnthropicUsage({
    usage: {
        input_tokens: 12,
        output_tokens: 14,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 5,
    },
}).cacheReadInputTokens, 5, 'Anthropic cache read token extraction');
assertEqual(extractGeminiText({ candidates: [{ content: { parts: [{ text: 'Gemini thought', thought: true }, { text: 'Gemini text' }] } }] }), 'Gemini text', 'Gemini extraction');
assertEqual(extractGeminiReasoning({ candidates: [{ content: { parts: [{ text: 'Gemini thought', thought: true }] } }] }), 'Gemini thought', 'Gemini reasoning extraction');
assertEqual(extractGeminiUsage({
    usageMetadata: {
        promptTokenCount: 6,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 4,
        totalTokenCount: 18,
    },
}).reasoningTokens, 4, 'Gemini thought token extraction');

const discoveredModels = extractDiscoveredModels({
    models: [
        { name: 'models/gemini-test', displayName: 'Gemini Test', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embed-test', supportedGenerationMethods: ['embedContent'] },
        { id: 'chat-test' },
    ],
});

assertEqual(discoveredModels.length, 2, 'Discovered model count');
assertEqual(discoveredModels[0].id, 'gemini-test', 'Gemini model prefix normalization');

print('Cusco remote provider adapters smoke passed');
