import {
    buildAnthropicMessagesBody,
    buildGeminiGenerateContentBody,
    buildOpenAiCompatibleChatBody,
    buildOpenAiResponsesBody,
    extractAnthropicText,
    extractChatCompletionText,
    extractDiscoveredModels,
    extractGeminiText,
    extractOpenAiText,
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

const chatBody = buildOpenAiCompatibleChatBody(messages, 'chat-test');
assertEqual(chatBody.messages[0].role, 'system', 'OpenAI-compatible system role');
assertEqual(chatBody.stream, false, 'OpenAI-compatible stream flag');

const anthropicBody = buildAnthropicMessagesBody(messages, 'claude-test');
assertEqual(anthropicBody.model, 'claude-test', 'Anthropic model');
assertEqual(anthropicBody.system, 'Keep answers concise.', 'Anthropic system text');
assertEqual(anthropicBody.messages.length, 3, 'Anthropic conversation message count');

const geminiBody = buildGeminiGenerateContentBody(messages);
assertEqual(geminiBody.systemInstruction.parts[0].text, 'Keep answers concise.', 'Gemini system instruction');
assertEqual(geminiBody.contents[1].role, 'model', 'Gemini assistant role');

assertEqual(extractOpenAiText({ output_text: 'OpenAI text' }), 'OpenAI text', 'OpenAI output_text extraction');
assertEqual(extractChatCompletionText({ choices: [{ message: { content: 'Chat text' } }] }), 'Chat text', 'Chat extraction');
assertEqual(extractAnthropicText({ content: [{ type: 'text', text: 'Claude text' }] }), 'Claude text', 'Anthropic extraction');
assertEqual(extractGeminiText({ candidates: [{ content: { parts: [{ text: 'Gemini text' }] } }] }), 'Gemini text', 'Gemini extraction');

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
