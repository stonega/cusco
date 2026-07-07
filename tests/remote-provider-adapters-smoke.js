import GLib from 'gi://GLib?version=2.0';

import {
    buildAnthropicMessagesBody,
    buildGeminiGenerateContentBody,
    buildOpenAiCompatibleChatBody,
    buildOpenAiResponsesBody,
    extractAnthropicToolCalls,
    extractAnthropicReasoning,
    extractAnthropicText,
    extractAnthropicUsage,
    extractAnthropicFinishReason,
    extractChatCompletionFinishReason,
    extractChatCompletionReasoning,
    extractChatCompletionText,
    extractChatCompletionToolCalls,
    extractChatCompletionUsage,
    extractDiscoveredModels,
    extractGeminiFinishReason,
    extractGeminiReasoning,
    extractGeminiText,
    extractGeminiToolCalls,
    extractGeminiUsage,
    extractOpenAiFinishReason,
    extractOpenAiReasoning,
    extractOpenAiText,
    extractOpenAiToolCalls,
    extractOpenAiUsage,
    OpenAiCompatibleChatProvider,
} from '../src/providers/remoteProvider.js';
import { createMessage } from '../src/providers/provider.js';

function assertEqual(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

const messages = [
    createMessage('assistant', 'This welcome message should not be sent.'),
    createMessage('system', 'Keep answers concise.'),
    createMessage('user', 'Hello'),
    createMessage('assistant', 'Hi'),
    createMessage('user', 'Summarize Cusco'),
];
const imagePath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-provider-image-${GLib.uuid_string_random()}.png`,
]);
const imageBytes = new TextEncoder().encode('tiny-image');
const imageData = GLib.base64_encode(imageBytes);
GLib.file_set_contents(imagePath, imageBytes);
const imageMessages = [
    createMessage('user', 'Describe this image', {
        attachments: [{
            kind: 'image',
            name: 'tiny.png',
            path: imagePath,
        }],
    }),
];

const openAiBody = buildOpenAiResponsesBody(messages, 'gpt-test');
assertEqual(openAiBody.model, 'gpt-test', 'OpenAI model');
assertEqual(openAiBody.input.length, 4, 'OpenAI filtered message count');
assertEqual(openAiBody.input[0].role, 'developer', 'OpenAI system role');
assertEqual(openAiBody.max_output_tokens, 8192, 'OpenAI default max output tokens');

const mcpTool = {
    name: 'mcp__context7__resolve_library_id',
    label: 'context7: Resolve Context7 Library ID',
    description: 'Resolve a package name to a Context7 library ID.',
    inputDescription: 'JSON object with fields: query, libraryName.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string' },
            libraryName: { type: 'string' },
            metadata: {
                type: 'object',
                properties: {
                    source: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        required: ['query', 'libraryName'],
        additionalProperties: false,
    },
};
const openAiToolBody = buildOpenAiResponsesBody(messages, 'gpt-test', {
    tools: [mcpTool],
});
assertEqual(openAiToolBody.tool_choice, 'auto', 'OpenAI tool choice');
assertEqual(openAiToolBody.tools[0].name, 'mcp__context7__resolve_library_id', 'OpenAI tool name');

const openAiThinkingBody = buildOpenAiResponsesBody(messages, 'gpt-test', {
    provider: {
        thinking: {
            api: 'openai-responses',
            levels: ['off', 'auto', 'low', 'medium', 'high'],
            summary: 'auto',
        },
    },
    thinkingLevel: 'high',
    maxOutputTokens: 16000,
});
assertEqual(openAiThinkingBody.reasoning.effort, 'high', 'OpenAI reasoning effort');
assertEqual(openAiThinkingBody.reasoning.summary, 'auto', 'OpenAI reasoning summary');
assertEqual(openAiThinkingBody.max_output_tokens, 16000, 'OpenAI custom max output tokens');

const openAiImageBody = buildOpenAiResponsesBody(imageMessages, 'gpt-test');
assertEqual(openAiImageBody.input[0].content[0].type, 'input_text', 'OpenAI image prompt text part');
assertEqual(openAiImageBody.input[0].content[1].type, 'input_image', 'OpenAI image part');
assertEqual(openAiImageBody.input[0].content[1].image_url, `data:image/png;base64,${imageData}`, 'OpenAI image data URL');

const chatBody = buildOpenAiCompatibleChatBody(messages, 'chat-test');
assertEqual(chatBody.messages[0].role, 'system', 'OpenAI-compatible system role');
assertEqual(chatBody.max_tokens, 8192, 'OpenAI-compatible default max tokens');
assertEqual(chatBody.stream, false, 'OpenAI-compatible stream flag');
const chatImageBody = buildOpenAiCompatibleChatBody(imageMessages, 'chat-test');
assertEqual(chatImageBody.messages[0].content[0].type, 'text', 'OpenAI-compatible image prompt text part');
assertEqual(chatImageBody.messages[0].content[1].type, 'image_url', 'OpenAI-compatible image part');
assertEqual(chatImageBody.messages[0].content[1].image_url.url, `data:image/png;base64,${imageData}`, 'OpenAI-compatible image data URL');
const unsupportedChatImageBody = buildOpenAiCompatibleChatBody(imageMessages, 'chat-test', {
    provider: { supportsImageAttachments: false },
});
assertEqual(unsupportedChatImageBody.messages[0].content, 'Describe this image', 'Unsupported OpenAI-compatible provider omits image parts');

const chatToolBody = buildOpenAiCompatibleChatBody(messages, 'chat-test', {
    tools: [mcpTool],
});
assertEqual(chatToolBody.tool_choice, 'auto', 'OpenAI-compatible tool choice');
assertEqual(chatToolBody.tools[0].function.name, 'mcp__context7__resolve_library_id', 'OpenAI-compatible tool name');
assertEqual(chatToolBody.tools[0].function.parameters.required.length, 2, 'OpenAI-compatible tool schema');
const kimiThinkingBody = buildOpenAiCompatibleChatBody(messages, 'kimi-k2.6', {
    model: {
        thinking: {
            api: 'kimi-thinking',
            levels: ['off', 'auto'],
            keep: 'all',
        },
    },
    thinkingLevel: 'auto',
});
assertEqual(kimiThinkingBody.thinking.type, 'enabled', 'Kimi thinking enabled');
assertEqual(kimiThinkingBody.thinking.keep, 'all', 'Kimi preserved thinking');
const kimiThinkingOffBody = buildOpenAiCompatibleChatBody(messages, 'kimi-k2.6', {
    model: {
        thinking: {
            api: 'kimi-thinking',
            levels: ['off', 'auto'],
            keep: 'all',
        },
    },
    thinkingLevel: 'off',
});
assertEqual(kimiThinkingOffBody.thinking.type, 'disabled', 'Kimi thinking disabled');
const deepseekThinkingBody = buildOpenAiCompatibleChatBody(messages, 'deepseek-v4-pro', {
    model: {
        thinking: {
            api: 'deepseek-thinking',
            levels: ['off', 'auto', 'high', 'max'],
        },
    },
    thinkingLevel: 'high',
});
assertEqual(deepseekThinkingBody.thinking.type, 'enabled', 'DeepSeek thinking enabled');
assertEqual(deepseekThinkingBody.thinking.reasoning_effort, 'high', 'DeepSeek reasoning effort');
const deepseekMaxThinkingBody = buildOpenAiCompatibleChatBody(messages, 'deepseek-v4-pro', {
    model: {
        thinking: {
            api: 'deepseek-thinking',
            levels: ['off', 'auto', 'high', 'max'],
        },
    },
    thinkingLevel: 'max',
});
assertEqual(deepseekMaxThinkingBody.thinking.type, 'enabled', 'DeepSeek max thinking enabled');
assertEqual(deepseekMaxThinkingBody.thinking.reasoning_effort, 'max', 'DeepSeek max reasoning effort');
const deepseekThinkingOffBody = buildOpenAiCompatibleChatBody(messages, 'deepseek-v4-pro', {
    model: {
        thinking: {
            api: 'deepseek-thinking',
            levels: ['off', 'auto', 'high', 'max'],
        },
    },
    thinkingLevel: 'off',
});
assertEqual(deepseekThinkingOffBody.thinking.type, 'disabled', 'DeepSeek thinking disabled');
const zaiThinkingBody = buildOpenAiCompatibleChatBody(messages, 'glm-5.2', {
    model: {
        thinking: {
            api: 'zai-thinking',
            levels: ['off', 'auto', 'high', 'max'],
            supportsReasoningEffort: true,
        },
    },
    thinkingLevel: 'max',
});
assertEqual(zaiThinkingBody.thinking.type, 'enabled', 'Z.ai thinking enabled');
assertEqual(zaiThinkingBody.reasoning_effort, 'max', 'Z.ai reasoning effort');
const zaiThinkingOffBody = buildOpenAiCompatibleChatBody(messages, 'glm-5.2', {
    model: {
        thinking: {
            api: 'zai-thinking',
            levels: ['off', 'auto', 'high', 'max'],
            supportsReasoningEffort: true,
        },
    },
    thinkingLevel: 'off',
});
assertEqual(zaiThinkingOffBody.thinking.type, 'disabled', 'Z.ai thinking disabled');
assertEqual(hasOwn(zaiThinkingOffBody, 'reasoning_effort'), false, 'Z.ai disabled thinking omits reasoning effort');
const zaiTurboThinkingBody = buildOpenAiCompatibleChatBody(messages, 'glm-5-turbo', {
    model: {
        thinking: {
            api: 'zai-thinking',
            levels: ['off', 'auto'],
        },
    },
    thinkingLevel: 'auto',
});
assertEqual(zaiTurboThinkingBody.thinking.type, 'enabled', 'Z.ai GLM-5 Turbo thinking enabled');
assertEqual(hasOwn(zaiTurboThinkingBody, 'reasoning_effort'), false, 'Z.ai GLM-5 Turbo omits unsupported reasoning effort');

const anthropicBody = buildAnthropicMessagesBody(messages, 'claude-test');
assertEqual(anthropicBody.model, 'claude-test', 'Anthropic model');
assertEqual(anthropicBody.system, 'Keep answers concise.', 'Anthropic system text');
assertEqual(anthropicBody.max_tokens, 8192, 'Anthropic default max tokens');
assertEqual(anthropicBody.messages.length, 3, 'Anthropic conversation message count');
const anthropicImageBody = buildAnthropicMessagesBody(imageMessages, 'claude-test');
assertEqual(anthropicImageBody.messages[0].content[0].type, 'image', 'Anthropic image part');
assertEqual(anthropicImageBody.messages[0].content[0].source.media_type, 'image/png', 'Anthropic image MIME type');
assertEqual(anthropicImageBody.messages[0].content[0].source.data, imageData, 'Anthropic image data');
assertEqual(anthropicImageBody.messages[0].content[1].type, 'text', 'Anthropic image prompt text part');
const anthropicToolBody = buildAnthropicMessagesBody(messages, 'claude-test', {
    tools: [mcpTool],
});
assertEqual(anthropicToolBody.tools[0].name, 'mcp__context7__resolve_library_id', 'Anthropic tool name');
assertEqual(anthropicToolBody.tools[0].input_schema.required.length, 2, 'Anthropic tool schema');

const anthropicThinkingBody = buildAnthropicMessagesBody(messages, 'claude-test', {
    provider: {
        thinking: {
            api: 'anthropic-adaptive',
            levels: ['off', 'auto', 'low', 'medium', 'high'],
            display: 'summarized',
        },
    },
    thinkingLevel: 'low',
    maxOutputTokens: 12288,
});
assertEqual(anthropicThinkingBody.thinking.type, 'adaptive', 'Anthropic thinking type');
assertEqual(anthropicThinkingBody.thinking.effort, 'low', 'Anthropic thinking effort');
assertEqual(anthropicThinkingBody.thinking.display, 'summarized', 'Anthropic thinking display');
assertEqual(anthropicThinkingBody.max_tokens, 12288, 'Anthropic custom max tokens');

const geminiBody = buildGeminiGenerateContentBody(messages);
assertEqual(geminiBody.systemInstruction.parts[0].text, 'Keep answers concise.', 'Gemini system instruction');
assertEqual(geminiBody.contents[1].role, 'model', 'Gemini assistant role');
assertEqual(geminiBody.generationConfig.maxOutputTokens, 8192, 'Gemini default max output tokens');
const geminiImageBody = buildGeminiGenerateContentBody(imageMessages);
assertEqual(geminiImageBody.contents[0].parts[0].text, 'Describe this image', 'Gemini image prompt text part');
assertEqual(geminiImageBody.contents[0].parts[1].inline_data.mime_type, 'image/png', 'Gemini image MIME type');
assertEqual(geminiImageBody.contents[0].parts[1].inline_data.data, imageData, 'Gemini image data');
const geminiThinkingLevelBody = buildGeminiGenerateContentBody(messages, {
    model: {
        thinking: {
            api: 'gemini-thinking-level',
            levels: ['minimal', 'auto', 'low', 'medium', 'high'],
            includeThoughts: true,
        },
    },
    thinkingLevel: 'minimal',
});
assertEqual(geminiThinkingLevelBody.generationConfig.thinkingConfig.thinkingLevel, 'minimal', 'Gemini thinking level');
assertEqual(geminiThinkingLevelBody.generationConfig.thinkingConfig.includeThoughts, true, 'Gemini thought summaries');
const geminiToolBody = buildGeminiGenerateContentBody(messages, {
    tools: [mcpTool],
});
assertEqual(geminiToolBody.tools[0].functionDeclarations[0].name, 'mcp__context7__resolve_library_id', 'Gemini tool name');
const geminiToolParameters = geminiToolBody.tools[0].functionDeclarations[0].parameters;
assertEqual(hasOwn(geminiToolParameters, 'additionalProperties'), false, 'Gemini top-level schema omits additionalProperties');
assertEqual(hasOwn(geminiToolParameters.properties.metadata, 'additionalProperties'), false, 'Gemini nested schema omits additionalProperties');
const geminiFallbackToolBody = buildGeminiGenerateContentBody(messages, {
    tools: [{ name: 'calc', label: 'Calculator', description: 'Calculate.', inputDescription: 'Expression.' }],
});
const geminiFallbackParameters = geminiFallbackToolBody.tools[0].functionDeclarations[0].parameters;
assertEqual(geminiFallbackParameters.properties.input.type, 'string', 'Gemini fallback schema keeps text input');
assertEqual(hasOwn(geminiFallbackParameters, 'additionalProperties'), false, 'Gemini fallback schema omits additionalProperties');

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
assertEqual(extractOpenAiFinishReason({
    incomplete_details: { reason: 'max_output_tokens' },
}), 'max_output_tokens', 'OpenAI finish reason extraction');
const openAiToolCalls = extractOpenAiToolCalls({
    output: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'mcp__context7__resolve_library_id',
        arguments: '{"query":"React hooks","libraryName":"React"}',
    }],
});
assertEqual(openAiToolCalls[0].input, '{"query":"React hooks","libraryName":"React"}', 'OpenAI tool call extraction');
assertEqual(extractChatCompletionText({ choices: [{ message: { content: 'Chat text' } }] }), 'Chat text', 'Chat extraction');
assertEqual(extractChatCompletionReasoning({ choices: [{ message: { reasoning_content: 'Chat reasoning' } }] }), 'Chat reasoning', 'Chat reasoning extraction');
assertEqual(extractChatCompletionFinishReason({ choices: [{ finish_reason: 'length' }] }), 'length', 'Chat finish reason extraction');
assertEqual(extractChatCompletionUsage({
    usage: {
        prompt_tokens: 7,
        completion_tokens: 9,
        total_tokens: 16,
        completion_tokens_details: { reasoning_tokens: 4 },
    },
}).reasoningTokens, 4, 'Chat reasoning token extraction');
const chatToolCalls = extractChatCompletionToolCalls({
    choices: [{
        message: {
            tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: {
                    name: 'mcp__context7__resolve_library_id',
                    arguments: '{"query":"React hooks","libraryName":"React"}',
                },
            }],
        },
    }],
});
assertEqual(chatToolCalls[0].name, 'mcp__context7__resolve_library_id', 'Chat tool call name extraction');
assertEqual(chatToolCalls[0].input, '{"query":"React hooks","libraryName":"React"}', 'Chat tool call object input extraction');
const genericChatToolCalls = extractChatCompletionToolCalls({
    choices: [{
        message: {
            function_call: {
                name: 'calc',
                arguments: '{"input":"2 + 2"}',
            },
        },
    }],
});
assertEqual(genericChatToolCalls[0].input, '2 + 2', 'Chat tool call generic input extraction');
assertEqual(extractAnthropicText({ content: [{ type: 'text', text: 'Claude text' }] }), 'Claude text', 'Anthropic extraction');
assertEqual(extractAnthropicReasoning({ content: [{ type: 'thinking', thinking: 'Claude reasoning' }] }), 'Claude reasoning', 'Anthropic reasoning extraction');
assertEqual(extractAnthropicFinishReason({ stop_reason: 'max_tokens' }), 'max_tokens', 'Anthropic finish reason extraction');
const anthropicToolCalls = extractAnthropicToolCalls({
    content: [{
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mcp__context7__query_docs',
        input: { libraryId: '/reactjs/react.dev', query: 'useEffect cleanup' },
    }],
});
assertEqual(anthropicToolCalls[0].input, '{"libraryId":"/reactjs/react.dev","query":"useEffect cleanup"}', 'Anthropic tool call extraction');
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
assertEqual(extractGeminiFinishReason({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), 'MAX_TOKENS', 'Gemini finish reason extraction');
const geminiToolCalls = extractGeminiToolCalls({
    candidates: [{
        content: {
            parts: [{
                functionCall: {
                    name: 'mcp__context7__query_docs',
                    args: { libraryId: '/reactjs/react.dev', query: 'hooks' },
                },
            }],
        },
    }],
});
assertEqual(geminiToolCalls[0].input, '{"libraryId":"/reactjs/react.dev","query":"hooks"}', 'Gemini tool call extraction');
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

class ContinuingProvider extends OpenAiCompatibleChatProvider {
    constructor(responses) {
        super({
            id: 'continuing',
            name: 'Continuing Provider',
            defaultModelId: 'test-model',
            baseUrl: 'https://example.invalid',
            apiKey: 'test',
        });
        this.responses = responses;
        this.calls = [];
    }

    async _complete(messagesForRequest, _modelId, _options = {}) {
        this.calls.push(messagesForRequest);
        return this.responses.shift();
    }
}

const continuingProvider = new ContinuingProvider([
    { text: 'Part one ', finishReason: 'length' },
    { text: 'part two.', finishReason: 'stop' },
]);
let continuedText = '';

for await (const chunk of continuingProvider.streamChat([createMessage('user', 'Write a long answer')], {
    maxContinuationTurns: 1,
})) {
    if (typeof chunk === 'string')
        continuedText += chunk;
}

assertEqual(continuedText, 'Part one part two.', 'Automatic continuation text');
assertEqual(continuingProvider.calls.length, 2, 'Automatic continuation call count');
assertEqual(
    continuingProvider.calls[1].at(-1).content.includes('Do not ask the user'),
    true,
    'Automatic continuation prompt',
);

const toolCallingProvider = new ContinuingProvider([
    {
        toolCalls: [{
            name: 'calc',
            input: '2 + 2',
        }],
        finishReason: 'tool_calls',
    },
]);
let providerToolCall = null;

for await (const chunk of toolCallingProvider.streamChat([createMessage('user', 'Calculate')], {
    tools: [{ name: 'calc', label: 'Calculator', description: 'Calculate.', inputDescription: 'Expression.' }],
})) {
    if (chunk.type === 'tool_calls')
        providerToolCall = chunk.toolCalls[0];
}

assertEqual(providerToolCall.name, 'calc', 'Provider tool call chunk name');
assertEqual(providerToolCall.input, '2 + 2', 'Provider tool call chunk input');

if (GLib.file_test(imagePath, GLib.FileTest.EXISTS))
    GLib.unlink(imagePath);

print('Cusco remote provider adapters smoke passed');
