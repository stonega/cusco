import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';

import {
    buildAnthropicMessagesBody,
    buildGeminiGenerateContentBody,
    buildOpenAiCompatibleChatBody,
    buildOpenAiResponsesBody,
    extractAnthropicToolCalls,
    extractAnthropicServerToolResults,
    extractAnthropicReasoning,
    extractAnthropicText,
    extractAnthropicUsage,
    extractAnthropicFinishReason,
    extractChatCompletionFinishReason,
    extractChatCompletionReasoning,
    extractChatCompletionText,
    extractChatCompletionToolCalls,
    extractChatCompletionUsage,
    extractChatCompletionServerToolResults,
    extractDiscoveredModels,
    extractGeminiFinishReason,
    extractGeminiReasoning,
    extractGeminiText,
    extractGeminiToolCalls,
    extractGeminiUsage,
    extractGeminiServerToolResults,
    extractOpenAiFinishReason,
    extractOpenAiReasoning,
    extractOpenAiText,
    extractOpenAiToolCalls,
    extractOpenAiUsage,
    extractOpenAiServerToolResults,
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
    createMessage('assistant', '', {
        reasoning: {
            content: 'Internal agent reasoning',
            providerId: 'openai',
            modelId: 'gpt-test',
            thinkingLevel: 'high',
            agentMode: true,
        },
    }),
    createMessage('user', 'Summarize Cusco'),
];
const imagePath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-provider-image-${GLib.uuid_string_random()}.png`,
]);
const imageBytes = new TextEncoder().encode('tiny-image');
const imageData = GLib.base64_encode(imageBytes);
GLib.file_set_contents(imagePath, imageBytes);
const svgPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-provider-svg-${GLib.uuid_string_random()}.svg`,
]);
const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>');
GLib.file_set_contents(svgPath, svgBytes);
const imageMessages = [
    createMessage('user', 'Describe this image', {
        attachments: [{
            kind: 'image',
            name: 'tiny.png',
            path: imagePath,
        }],
    }),
];
const svgImageMessages = [
    createMessage('user', 'Read this SVG', {
        attachments: [{
            kind: 'image',
            name: 'icon.svg',
            mimeType: 'image/svg+xml',
            path: svgPath,
        }],
    }),
];
const nativeToolMessages = [
    createMessage('user', 'Inspect the window'),
    {
        ...createMessage('assistant', ''),
        toolCalls: [{
            id: 'call-computer-1',
            name: 'computer_step',
            input: '{"windowId":"42","actions":[{"action":"keypress","keys":["TAB"]}]}',
            thoughtSignature: 'gemini-thought-signature',
        }],
    },
    {
        ...createMessage('tool', 'The window changed.', {
            attachments: [{
                kind: 'image',
                name: 'updated-window.png',
                path: imagePath,
            }],
        }),
        toolCallId: 'call-computer-1',
        toolName: 'computer_step',
    },
];

const openAiBody = buildOpenAiResponsesBody(messages, 'gpt-test');
assertEqual(openAiBody.model, 'gpt-test', 'OpenAI model');
assertEqual(openAiBody.input.length, 4, 'OpenAI filtered message count');
assertEqual(openAiBody.input[0].role, 'developer', 'OpenAI system role');
assertEqual(openAiBody.input.some((message) => message.content === ''), false, 'OpenAI omitted Agent Mode reasoning messages');
assertEqual(openAiBody.max_output_tokens, 8192, 'OpenAI default max output tokens');
const openAiNativeToolBody = buildOpenAiResponsesBody(nativeToolMessages, 'gpt-test');
assertEqual(openAiNativeToolBody.input[1].type, 'function_call', 'OpenAI native function call history');
assertEqual(openAiNativeToolBody.input[2].type, 'function_call_output', 'OpenAI native function result history');
assertEqual(openAiNativeToolBody.input[3].content[1].type, 'input_image', 'OpenAI native tool screenshot history');

const compatibleNativeToolBody = buildOpenAiCompatibleChatBody(nativeToolMessages, 'model-test');
assertEqual(compatibleNativeToolBody.messages[1].tool_calls[0].function.name, 'computer_step', 'Chat Completions native function call history');
assertEqual(compatibleNativeToolBody.messages[2].role, 'tool', 'Chat Completions native function result history');
assertEqual(compatibleNativeToolBody.messages[3].content[1].type, 'image_url', 'Chat Completions native tool screenshot history');

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
const searchTool = {
    name: 'search',
    label: 'Web Search',
    description: 'Search the web.',
    inputDescription: 'Search query.',
};
const openAiToolBody = buildOpenAiResponsesBody(messages, 'gpt-test', {
    tools: [mcpTool],
});
assertEqual(openAiToolBody.tool_choice, 'auto', 'OpenAI tool choice');
assertEqual(openAiToolBody.tools[0].name, 'mcp__context7__resolve_library_id', 'OpenAI tool name');
const openAiNativeSearchBody = buildOpenAiResponsesBody(messages, 'gpt-test', {
    provider: {
        nativeSearch: {
            api: 'openai-responses',
            tools: ['web_search'],
            includeSources: true,
        },
    },
    tools: [searchTool, mcpTool],
});
assertEqual(openAiNativeSearchBody.tools[0].type, 'web_search', 'OpenAI native web search');
assertEqual(openAiNativeSearchBody.tools[1].name, 'mcp__context7__resolve_library_id', 'OpenAI retained client tool');
assertEqual(openAiNativeSearchBody.tools.some((tool) => tool.name === 'search'), false, 'OpenAI removed fallback search function');
assertEqual(openAiNativeSearchBody.include[0], 'web_search_call.action.sources', 'OpenAI requested complete search sources');
const grokNativeSearchBody = buildOpenAiResponsesBody(messages, 'grok-4.5', {
    provider: {
        nativeSearch: {
            api: 'openai-responses',
            tools: ['web_search', 'x_search'],
        },
    },
    model: {
        thinking: {
            api: 'xai-reasoning',
            levels: ['low', 'medium', 'high'],
        },
    },
    thinkingLevel: 'high',
    tools: [searchTool],
});
assertEqual(grokNativeSearchBody.tools.map((tool) => tool.type).join(','), 'web_search,x_search', 'Grok native search tools');
assertEqual(grokNativeSearchBody.reasoning.effort, 'high', 'Grok Responses reasoning effort');

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

const openAiXHighThinkingBody = buildOpenAiResponsesBody(messages, 'gpt-test', {
    provider: {
        thinking: {
            api: 'openai-responses',
            levels: ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'],
            summary: 'auto',
        },
    },
    thinkingLevel: 'xhigh',
});
assertEqual(openAiXHighThinkingBody.reasoning.effort, 'xhigh', 'OpenAI xhigh reasoning effort');

const openAiMaxThinkingBody = buildOpenAiResponsesBody(messages, 'gpt-test', {
    provider: {
        thinking: {
            api: 'openai-responses',
            levels: ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'],
            summary: 'auto',
        },
    },
    thinkingLevel: 'max',
});
assertEqual(openAiMaxThinkingBody.reasoning.effort, 'max', 'OpenAI max reasoning effort');

const openAiImageBody = buildOpenAiResponsesBody(imageMessages, 'gpt-test');
assertEqual(openAiImageBody.input[0].content[0].type, 'input_text', 'OpenAI image prompt text part');
assertEqual(openAiImageBody.input[0].content[1].type, 'input_image', 'OpenAI image part');
assertEqual(openAiImageBody.input[0].content[1].image_url, `data:image/png;base64,${imageData}`, 'OpenAI image data URL');
const openAiSvgBody = buildOpenAiResponsesBody(svgImageMessages, 'gpt-test');
assertEqual(openAiSvgBody.input[0].content, 'Read this SVG', 'OpenAI SVG attachment is not sent as an image part');

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
const chatSvgBody = buildOpenAiCompatibleChatBody(svgImageMessages, 'chat-test');
assertEqual(chatSvgBody.messages[0].content, 'Read this SVG', 'OpenAI-compatible SVG attachment is not sent as an image part');

const chatToolBody = buildOpenAiCompatibleChatBody(messages, 'chat-test', {
    tools: [mcpTool],
});
assertEqual(chatToolBody.tool_choice, 'auto', 'OpenAI-compatible tool choice');
assertEqual(chatToolBody.tools[0].function.name, 'mcp__context7__resolve_library_id', 'OpenAI-compatible tool name');
assertEqual(chatToolBody.tools[0].function.parameters.required.length, 2, 'OpenAI-compatible tool schema');
const kimiK3Body = buildOpenAiCompatibleChatBody(messages, 'kimi-k3', {
    model: {
        thinking: {
            api: 'kimi-k3-reasoning',
            levels: ['max'],
            maxOutputTokensParameter: 'max_completion_tokens',
        },
    },
    thinkingLevel: 'max',
    maxOutputTokens: 32768,
});
assertEqual(kimiK3Body.reasoning_effort, 'max', 'Kimi K3 reasoning effort');
assertEqual(kimiK3Body.max_completion_tokens, 32768, 'Kimi K3 completion token field');
assertEqual(hasOwn(kimiK3Body, 'max_tokens'), false, 'Kimi K3 omits legacy max tokens');
assertEqual(hasOwn(kimiK3Body, 'thinking'), false, 'Kimi K3 omits K2 thinking parameter');
assertEqual(hasOwn(kimiK3Body, 'temperature'), false, 'Kimi K3 omits fixed sampling parameters');
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
const grokThinkingBody = buildOpenAiCompatibleChatBody(messages, 'grok-4.5', {
    model: {
        thinking: {
            api: 'xai-reasoning',
            levels: ['low', 'medium', 'high'],
            defaultLevel: 'high',
        },
    },
    thinkingLevel: 'high',
});
assertEqual(grokThinkingBody.reasoning.effort, 'high', 'Grok reasoning effort');
const grokOffThinkingBody = buildOpenAiCompatibleChatBody(messages, 'grok-4.3', {
    model: {
        thinking: {
            api: 'xai-reasoning',
            levels: ['off', 'low', 'medium', 'high'],
            defaultLevel: 'low',
            offEffort: 'none',
        },
    },
    thinkingLevel: 'off',
});
assertEqual(grokOffThinkingBody.reasoning.effort, 'none', 'Grok disabled reasoning effort');

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
const anthropicSvgBody = buildAnthropicMessagesBody(svgImageMessages, 'claude-test');
assertEqual(anthropicSvgBody.messages[0].content, 'Read this SVG', 'Anthropic SVG attachment is not sent as an image part');
const anthropicToolBody = buildAnthropicMessagesBody(messages, 'claude-test', {
    tools: [mcpTool],
});
assertEqual(anthropicToolBody.tools[0].name, 'mcp__context7__resolve_library_id', 'Anthropic tool name');
assertEqual(anthropicToolBody.tools[0].input_schema.required.length, 2, 'Anthropic tool schema');
const anthropicNativeToolHistory = buildAnthropicMessagesBody(nativeToolMessages, 'claude-test');
assertEqual(anthropicNativeToolHistory.messages[1].content[0].type, 'tool_use', 'Anthropic native tool call history');
assertEqual(anthropicNativeToolHistory.messages[2].content[0].type, 'tool_result', 'Anthropic native tool result history');
assertEqual(anthropicNativeToolHistory.messages[2].content[0].content[0].type, 'image', 'Anthropic native tool screenshot history');
const anthropicNativeSearchBody = buildAnthropicMessagesBody(messages, 'claude-test', {
    provider: {
        nativeSearch: {
            api: 'anthropic-messages',
            version: 'web_search_20250305',
            maxUses: 5,
        },
    },
    tools: [searchTool, mcpTool],
});
assertEqual(anthropicNativeSearchBody.tools[0].type, 'web_search_20250305', 'Anthropic native web search');
assertEqual(anthropicNativeSearchBody.tools[0].max_uses, 5, 'Anthropic search cap');
assertEqual(anthropicNativeSearchBody.tools[1].name, 'mcp__context7__resolve_library_id', 'Anthropic retained client tool');

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
assertEqual(anthropicThinkingBody.output_config.effort, 'low', 'Anthropic output effort');
assertEqual(hasOwn(anthropicThinkingBody.thinking, 'effort'), false, 'Anthropic effort is not nested in thinking');
assertEqual(anthropicThinkingBody.thinking.display, 'summarized', 'Anthropic thinking display');
assertEqual(anthropicThinkingBody.max_tokens, 12288, 'Anthropic custom max tokens');
const anthropicXHighThinkingBody = buildAnthropicMessagesBody(messages, 'claude-opus-4-8', {
    model: {
        thinking: {
            api: 'anthropic-adaptive',
            levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
            display: 'summarized',
        },
    },
    thinkingLevel: 'xhigh',
});
assertEqual(anthropicXHighThinkingBody.thinking.type, 'adaptive', 'Claude Opus 4.8 adaptive thinking');
assertEqual(anthropicXHighThinkingBody.output_config.effort, 'xhigh', 'Claude Opus 4.8 xhigh effort');
const anthropicThinkingOffBody = buildAnthropicMessagesBody(messages, 'claude-sonnet-5', {
    model: {
        thinking: {
            api: 'anthropic-adaptive',
            levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
    },
    thinkingLevel: 'off',
});
assertEqual(anthropicThinkingOffBody.thinking.type, 'disabled', 'Claude Sonnet 5 thinking disabled');
assertEqual(hasOwn(anthropicThinkingOffBody, 'output_config'), false, 'Disabled Claude thinking omits effort');

const geminiBody = buildGeminiGenerateContentBody(messages);
assertEqual(geminiBody.systemInstruction.parts[0].text, 'Keep answers concise.', 'Gemini system instruction');
assertEqual(geminiBody.contents[1].role, 'model', 'Gemini assistant role');
assertEqual(geminiBody.generationConfig.maxOutputTokens, 8192, 'Gemini default max output tokens');
const geminiImageBody = buildGeminiGenerateContentBody(imageMessages);
assertEqual(geminiImageBody.contents[0].parts[0].text, 'Describe this image', 'Gemini image prompt text part');
assertEqual(geminiImageBody.contents[0].parts[1].inline_data.mime_type, 'image/png', 'Gemini image MIME type');
assertEqual(geminiImageBody.contents[0].parts[1].inline_data.data, imageData, 'Gemini image data');
const geminiNativeToolHistory = buildGeminiGenerateContentBody(nativeToolMessages);
assertEqual(geminiNativeToolHistory.contents[1].parts[0].functionCall.name, 'computer_step', 'Gemini native function call history');
assertEqual(geminiNativeToolHistory.contents[1].parts[0].functionCall.id, 'call-computer-1', 'Gemini native function call ID history');
assertEqual(geminiNativeToolHistory.contents[1].parts[0].thoughtSignature, 'gemini-thought-signature', 'Gemini thought signature history');
assertEqual(geminiNativeToolHistory.contents[2].parts[0].functionResponse.name, 'computer_step', 'Gemini native function result history');
assertEqual(geminiNativeToolHistory.contents[2].parts[0].functionResponse.id, 'call-computer-1', 'Gemini native function response ID history');
assertEqual(geminiNativeToolHistory.contents[2].parts[1].inline_data.mime_type, 'image/png', 'Gemini native tool screenshot history');
const geminiSvgBody = buildGeminiGenerateContentBody(svgImageMessages);
assertEqual(geminiSvgBody.contents[0].parts.length, 1, 'Gemini SVG attachment is not sent as an image part');
assertEqual(geminiSvgBody.contents[0].parts[0].text, 'Read this SVG', 'Gemini SVG prompt text part');
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
const geminiNativeSearchBody = buildGeminiGenerateContentBody(messages, {
    provider: {
        nativeSearch: {
            api: 'gemini-generate-content',
            tools: ['google_search'],
        },
    },
    tools: [searchTool, mcpTool],
});
assertEqual(hasOwn(geminiNativeSearchBody.tools[0], 'googleSearch'), true, 'Gemini native Google Search');
assertEqual(geminiNativeSearchBody.tools[1].functionDeclarations[0].name, 'mcp__context7__resolve_library_id', 'Gemini retained client tool');
assertEqual(geminiNativeSearchBody.toolConfig.includeServerSideToolInvocations, true, 'Gemini exposed server tool activity');
assertEqual(geminiNativeSearchBody.toolConfig.functionCallingConfig.mode, 'VALIDATED', 'Gemini validated combined tools');
const geminiFallbackToolBody = buildGeminiGenerateContentBody(messages, {
    tools: [{ name: 'calc', label: 'Calculator', description: 'Calculate.', inputDescription: 'Expression.' }],
});
const geminiFallbackParameters = geminiFallbackToolBody.tools[0].functionDeclarations[0].parameters;
assertEqual(geminiFallbackParameters.properties.input.type, 'string', 'Gemini fallback schema keeps text input');
assertEqual(hasOwn(geminiFallbackParameters, 'additionalProperties'), false, 'Gemini fallback schema omits additionalProperties');

const zaiNativeSearchBody = buildOpenAiCompatibleChatBody(messages, 'glm-5.2', {
    provider: {
        nativeSearch: {
            api: 'zai-chat-completions',
            tools: ['web_search'],
            searchEngine: 'search-prime',
            count: 5,
        },
    },
    tools: [searchTool, mcpTool],
});
assertEqual(zaiNativeSearchBody.tools[0].type, 'web_search', 'Z.ai native web search');
assertEqual(zaiNativeSearchBody.tools[0].web_search.search_engine, 'search-prime', 'Z.ai search engine');
assertEqual(zaiNativeSearchBody.tools[1].function.name, 'mcp__context7__resolve_library_id', 'Z.ai retained client tool');

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
const grokCitationOnlyResults = extractOpenAiServerToolResults({
    citations: [
        'https://x.com/xai/status/123',
        'https://x.ai/news/grok',
    ],
}, ['web_search', 'x_search']);
assertEqual(grokCitationOnlyResults.length, 2, 'Grok citation-only native search groups');
assertEqual(grokCitationOnlyResults.find((result) => result.name === 'x_search').results[0].url, 'https://x.com/xai/status/123', 'Grok X citation extraction');
assertEqual(grokCitationOnlyResults.find((result) => result.name === 'search').results[0].url, 'https://x.ai/news/grok', 'Grok web citation extraction');
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
                    id: 'gemini-call-1',
                    name: 'mcp__context7__query_docs',
                    args: { libraryId: '/reactjs/react.dev', query: 'hooks' },
                },
                thoughtSignature: 'gemini-response-signature',
            }],
        },
    }],
});
assertEqual(geminiToolCalls[0].id, 'gemini-call-1', 'Gemini tool call ID extraction');
assertEqual(geminiToolCalls[0].input, '{"libraryId":"/reactjs/react.dev","query":"hooks"}', 'Gemini tool call extraction');
assertEqual(geminiToolCalls[0].thoughtSignature, 'gemini-response-signature', 'Gemini thought signature extraction');
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
        {
            name: 'models/gemini-test',
            displayName: 'Gemini Test',
            supportedGenerationMethods: ['generateContent'],
            inputTokenLimit: 1048576,
        },
        { name: 'models/embed-test', supportedGenerationMethods: ['embedContent'] },
        { id: 'chat-test' },
    ],
});

assertEqual(discoveredModels.length, 2, 'Discovered model count');
assertEqual(discoveredModels[0].id, 'gemini-test', 'Gemini model prefix normalization');
assertEqual(discoveredModels[0].contextWindowTokens, 1048576, 'Discovered context window normalization');

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

class ReconnectingProvider extends ContinuingProvider {
    constructor(failuresBeforeSuccess) {
        super([]);
        this.failuresBeforeSuccess = failuresBeforeSuccess;
    }

    async _complete(messagesForRequest, _modelId, _options = {}) {
        this.calls.push(messagesForRequest);

        if (this.failuresBeforeSuccess > 0) {
            this.failuresBeforeSuccess--;
            throw new GLib.Error(
                Gio.io_error_quark(),
                Gio.IOErrorEnum.NETWORK_UNREACHABLE,
                'Network unreachable',
            );
        }

        return { text: 'Recovered', finishReason: 'stop' };
    }
}

const reconnectingProvider = new ReconnectingProvider(5);
const reconnectStatuses = [];
let reconnectedText = '';

for await (const chunk of reconnectingProvider.streamChat([createMessage('user', 'Retry this request')])) {
    if (chunk?.type === 'status')
        reconnectStatuses.push(chunk.text);
    else if (typeof chunk === 'string')
        reconnectedText += chunk;
}

assertEqual(reconnectingProvider.calls.length, 6, 'Network reconnect request count');
assertEqual(reconnectStatuses.length, 5, 'Network reconnect status count');
assertEqual(reconnectStatuses[0], 'Reconnecting 1/5\u2026', 'First network reconnect status');
assertEqual(reconnectStatuses[4], 'Reconnecting 5/5\u2026', 'Final network reconnect status');
assertEqual(reconnectedText, 'Recovered', 'Network reconnect response');

const toolCallingProvider = new ContinuingProvider([
    {
        toolCalls: [{
            id: 'gemini-call-1',
            name: 'calc',
            input: '2 + 2',
            thoughtSignature: 'gemini-provider-signature',
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
assertEqual(providerToolCall.id, 'gemini-call-1', 'Provider tool call chunk ID');
assertEqual(providerToolCall.thoughtSignature, 'gemini-provider-signature', 'Provider tool call chunk thought signature');

if (GLib.file_test(imagePath, GLib.FileTest.EXISTS))
    GLib.unlink(imagePath);

print('Cusco remote provider adapters smoke passed');
