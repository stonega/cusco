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
    extractChatCompletionResponse,
    extractChatCompletionReasoning,
    extractChatCompletionText,
    extractChatCompletionToolCalls,
    extractChatCompletionUsage,
    extractChatCompletionServerToolResults,
    extractDiscoveredModels,
    extractGeminiFinishReason,
    extractGeminiProviderParts,
    extractGeminiReasoning,
    extractGeminiResponse,
    extractGeminiText,
    extractGeminiToolCalls,
    extractGeminiUsage,
    extractGeminiServerToolResults,
    extractOpenAiFinishReason,
    extractOpenAiReasoning,
    extractOpenAiResponse,
    extractOpenAiText,
    extractOpenAiToolCalls,
    extractOpenAiUsage,
    extractOpenAiServerToolResults,
    openAiCompatibleMessages,
    openAiMessages,
    OpenAiCompatibleChatProvider,
} from '../src/providers/remoteProvider.js';
import { createMessage } from '../src/providers/provider.js';
import {
    estimateRequestInputTokens,
    isOutputCapacityError,
    resolveEffectiveMaxOutputTokens,
} from '../src/providers/outputLimits.js';

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
const deepSeekHistoryMessages = [
    createMessage('user', 'What is the next step?'),
    createMessage('assistant', 'Inspect the current state first.', {
        reasoning: {
            content: 'I should inspect before changing anything.',
            providerId: 'deepseek',
            modelId: 'deepseek-v4-pro',
            thinkingLevel: 'high',
        },
    }),
    createMessage('user', 'Continue.'),
];
const crossProviderReasoningMessages = [
    createMessage('user', 'Inspect the current state.'),
    createMessage('assistant', 'The state was inspected.', {
        reasoning: {
            content: 'OpenAI-only reasoning context.',
            providerId: 'openai',
            modelId: 'gpt-5.6',
            thinkingLevel: 'high',
        },
    }),
    createMessage('user', 'Continue with DeepSeek.'),
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
const bmpPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-provider-bmp-${GLib.uuid_string_random()}.bmp`,
]);
GLib.file_set_contents(bmpPath, imageBytes);
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
const bmpImageMessages = [
    createMessage('user', 'Read this bitmap', {
        attachments: [{
            kind: 'image',
            name: 'bitmap.bmp',
            mimeType: 'image/bmp',
            path: bmpPath,
        }],
    }),
];
const pdfPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    'cusco-provider-attachment.pdf',
]);
const pdfMessageContent = 'Translate this PDF\n\nPDF attachment: article.pdf (preview unavailable)';
const fileAttachmentMessages = [
    createMessage('user', pdfMessageContent, {
        attachments: [{
            kind: 'file',
            name: 'article.pdf',
            path: pdfPath,
            contentType: 'application/pdf',
            binary: true,
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
const parallelNativeToolMessages = [
    createMessage('user', 'Inspect and list the windows'),
    {
        ...createMessage('assistant', ''),
        toolCalls: [
            {
                id: 'call-observe',
                name: 'computer_observe',
                input: '{}',
                thoughtSignature: 'gemini-parallel-signature',
            },
            {
                id: 'call-list',
                name: 'computer_list',
                input: '{}',
            },
        ],
    },
    {
        ...createMessage('tool', 'Observed.'),
        toolCallId: 'call-observe',
        toolName: 'computer_observe',
    },
    {
        ...createMessage('tool', 'Listed.'),
        toolCallId: 'call-list',
        toolName: 'computer_list',
    },
];
const emptyAssistantHistoryMessages = [
    createMessage('user', 'Use the system calculator.'),
    createMessage('assistant', '', {
        usage: {
            inputTokens: 12,
            outputTokens: 0,
            totalTokens: 12,
        },
    }),
    createMessage('system', 'Calculator result\n\n12 * 12 = 144'),
    createMessage('assistant', '', {
        metadata: {
            geminiProviderParts: [{
                functionCall: {
                    name: 'computer_step',
                    args: { actions: [{ action: 'keypress', keys: ['1'] }] },
                },
            }],
        },
    }),
    createMessage('user', 'Try again.'),
];

const openAiBody = buildOpenAiResponsesBody(messages, 'gpt-test');
assertEqual(openAiBody.model, 'gpt-test', 'OpenAI model');
assertEqual(openAiBody.input.length, 4, 'OpenAI filtered message count');
assertEqual(openAiBody.input[0].role, 'developer', 'OpenAI system role');
assertEqual(openAiBody.input.some((message) => message.content === ''), false, 'OpenAI omitted Agent Mode reasoning messages');
assertEqual(openAiBody.max_output_tokens, 16384, 'OpenAI default max output tokens');
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
const fileAttachmentToolContext = [
    pdfMessageContent,
    'Local file attachments available to tools (use the exact path values; do not guess):',
    JSON.stringify([{ name: 'article.pdf', path: pdfPath }]),
].join('\n\n');
const openAiFileAttachmentBody = buildOpenAiResponsesBody(fileAttachmentMessages, 'gpt-test', {
    tools: [mcpTool],
});
assertEqual(
    openAiFileAttachmentBody.input[0].content,
    fileAttachmentToolContext,
    'OpenAI tool context includes the exact local attachment path',
);
assertEqual(
    buildOpenAiResponsesBody(fileAttachmentMessages, 'gpt-test').input[0].content,
    pdfMessageContent,
    'OpenAI requests without tools omit local attachment paths',
);
assertEqual(
    buildOpenAiCompatibleChatBody(fileAttachmentMessages, 'model-test', { tools: [mcpTool] })
        .messages[0].content,
    fileAttachmentToolContext,
    'Chat Completions tool context includes the exact local attachment path',
);
assertEqual(
    buildAnthropicMessagesBody(fileAttachmentMessages, 'claude-test', { tools: [mcpTool] })
        .messages[0].content,
    fileAttachmentToolContext,
    'Anthropic tool context includes the exact local attachment path',
);
assertEqual(
    buildGeminiGenerateContentBody(fileAttachmentMessages, { tools: [mcpTool] })
        .contents[0].parts[0].text,
    fileAttachmentToolContext,
    'Gemini tool context includes the exact local attachment path',
);
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
const deepSeekResponsesProviderConfig = {
    id: 'deepseek',
    apiFormat: 'openai-responses',
    supportsImageAttachments: false,
    supportsReasoningContentItems: true,
    nativeSearch: {
        api: 'openai-responses',
        tools: ['web_search'],
    },
};
const deepSeekResponsesModel = {
    id: 'deepseek-v4-pro',
    thinking: {
        api: 'openai-responses',
        levels: ['off', 'low', 'high', 'max'],
        defaultLevel: 'high',
    },
};
const deepSeekVisionModel = {
    id: 'deepseek-v4-flash-vision-exp',
    supportsImageAttachments: true,
    supportedImageMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    thinking: {
        api: 'openai-responses',
        levels: ['off', 'low', 'high', 'max'],
        defaultLevel: 'high',
    },
};
const deepSeekResponsesBody = buildOpenAiResponsesBody(
    deepSeekHistoryMessages,
    'deepseek-v4-pro',
    {
        provider: deepSeekResponsesProviderConfig,
        model: deepSeekResponsesModel,
        thinkingLevel: 'high',
        tools: [searchTool, mcpTool],
    },
);
assertEqual(deepSeekResponsesBody.input.length, 4, 'DeepSeek Responses history item count');
assertEqual(deepSeekResponsesBody.input[1].type, 'reasoning', 'DeepSeek reasoning history item');
assertEqual(
    deepSeekResponsesBody.input[1].content[0].text,
    'I should inspect before changing anything.',
    'DeepSeek reasoning history content',
);
assertEqual(hasOwn(deepSeekResponsesBody.input[1], 'summary'), false, 'DeepSeek omitted unsupported reasoning summary');
assertEqual(deepSeekResponsesBody.input[2].role, 'assistant', 'DeepSeek assistant history item');
assertEqual(deepSeekResponsesBody.reasoning.effort, 'high', 'DeepSeek Responses reasoning effort');
assertEqual(hasOwn(deepSeekResponsesBody.reasoning, 'summary'), false, 'DeepSeek omitted unsupported reasoning summary');
assertEqual(deepSeekResponsesBody.tools[0].type, 'web_search', 'DeepSeek native web search');
assertEqual(deepSeekResponsesBody.tools[1].name, 'mcp__context7__resolve_library_id', 'DeepSeek retained client tool');
assertEqual(hasOwn(deepSeekResponsesBody, 'include'), false, 'DeepSeek omitted unsupported include field');
const deepSeekImageBody = buildOpenAiResponsesBody(imageMessages, 'deepseek-v4-pro', {
    provider: deepSeekResponsesProviderConfig,
});
assertEqual(deepSeekImageBody.input[0].content, 'Describe this image', 'DeepSeek omitted image input');
const deepSeekVisionImageBody = buildOpenAiResponsesBody(
    imageMessages,
    'deepseek-v4-flash-vision-exp',
    {
        provider: deepSeekResponsesProviderConfig,
        model: deepSeekVisionModel,
    },
);
assertEqual(deepSeekVisionImageBody.input[0].content[1].type, 'input_image', 'DeepSeek vision image part');
assertEqual(
    deepSeekVisionImageBody.input[0].content[1].image_url,
    `data:image/png;base64,${imageData}`,
    'DeepSeek vision image data URL',
);
const deepSeekVisionBmpBody = buildOpenAiResponsesBody(
    bmpImageMessages,
    'deepseek-v4-flash-vision-exp',
    {
        provider: deepSeekResponsesProviderConfig,
        model: deepSeekVisionModel,
    },
);
assertEqual(deepSeekVisionBmpBody.input[0].content, 'Read this bitmap', 'DeepSeek vision omitted unsupported BMP input');
const deepSeekVisionOffBody = buildOpenAiResponsesBody(
    messages,
    'deepseek-v4-flash-vision-exp',
    {
        provider: deepSeekResponsesProviderConfig,
        model: deepSeekVisionModel,
        thinkingLevel: 'off',
    },
);
assertEqual(deepSeekVisionOffBody.reasoning.effort, 'none', 'DeepSeek vision disabled reasoning');
const deepSeekToolImageBody = buildOpenAiResponsesBody(nativeToolMessages, 'deepseek-v4-pro', {
    provider: deepSeekResponsesProviderConfig,
});
assertEqual(
    JSON.stringify(deepSeekToolImageBody.input).includes('input_image'),
    false,
    'DeepSeek omitted tool-result screenshots',
);
const deepSeekVisionToolImageBody = buildOpenAiResponsesBody(
    nativeToolMessages,
    'deepseek-v4-flash-vision-exp',
    {
        provider: deepSeekResponsesProviderConfig,
        model: deepSeekVisionModel,
    },
);
assertEqual(
    JSON.stringify(deepSeekVisionToolImageBody.input).includes('input_image'),
    true,
    'DeepSeek vision retained tool-result screenshots',
);
const deepSeekCrossProviderBody = buildOpenAiResponsesBody(
    crossProviderReasoningMessages,
    'deepseek-v4-pro',
    { provider: deepSeekResponsesProviderConfig },
);
assertEqual(
    deepSeekCrossProviderBody.input.some((item) => item.type === 'reasoning'),
    false,
    'DeepSeek omitted reasoning history from another provider',
);
const grokNativeSearchBody = buildOpenAiResponsesBody(messages, 'grok-4.6', {
    provider: {
        nativeSearch: {
            api: 'openai-responses',
            tools: ['web_search', 'x_search'],
        },
    },
    model: {
        thinking: {
            api: 'xai-reasoning',
            levels: ['low', 'medium', 'high', 'xhigh'],
        },
    },
    thinkingLevel: 'xhigh',
    tools: [searchTool],
});
assertEqual(grokNativeSearchBody.tools.map((tool) => tool.type).join(','), 'web_search,x_search', 'Grok native search tools');
assertEqual(grokNativeSearchBody.reasoning.effort, 'xhigh', 'Grok 4.6 Responses reasoning effort');

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
assertEqual(chatBody.max_tokens, 16384, 'OpenAI-compatible default max tokens');
assertEqual(chatBody.stream, false, 'OpenAI-compatible stream flag');
const strictStreamingChatBody = buildOpenAiCompatibleChatBody(messages, 'chat-test', {
    stream: true,
});
assertEqual(
    Object.hasOwn(strictStreamingChatBody, 'stream_options'),
    false,
    'OpenAI-compatible streaming usage options are opt-in',
);
const usageStreamingChatBody = buildOpenAiCompatibleChatBody(messages, 'chat-test', {
    provider: { supportsStreamUsageOptions: true },
    stream: true,
});
assertEqual(
    usageStreamingChatBody.stream_options?.include_usage,
    true,
    'OpenAI-compatible streaming usage options capability',
);
const strictChatHistoryBody = buildOpenAiCompatibleChatBody(emptyAssistantHistoryMessages, 'kimi-test');
assertEqual(strictChatHistoryBody.messages.length, 3, 'OpenAI-compatible omitted empty assistant history');
assertEqual(strictChatHistoryBody.messages.some((message) => message.role === 'assistant'), false, 'OpenAI-compatible has no empty assistant messages');
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
const zaiGlm53ThinkingBody = buildOpenAiCompatibleChatBody(messages, 'glm-5.3', {
    model: {
        thinking: {
            api: 'zai-thinking',
            levels: ['low', 'high', 'max'],
            defaultLevel: 'max',
            alwaysOn: true,
            supportsReasoningEffort: true,
        },
    },
    thinkingLevel: 'low',
    maxOutputTokens: 128000,
});
assertEqual(zaiGlm53ThinkingBody.thinking.type, 'enabled', 'Z.ai GLM-5.3 always enables thinking');
assertEqual(zaiGlm53ThinkingBody.reasoning_effort, 'low', 'Z.ai GLM-5.3 low reasoning effort');
assertEqual(zaiGlm53ThinkingBody.max_tokens, 128000, 'Z.ai GLM-5.3 maximum output tokens');
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
assertEqual(anthropicBody.max_tokens, 16384, 'Anthropic default max tokens');
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
let anthropicCapacityError = null;

try {
    buildAnthropicMessagesBody(messages, 'claude-haiku-test', {
        model: {
            thinking: {
                api: 'anthropic-budget',
                levels: ['off', 'high'],
                budgets: { high: 3072 },
            },
        },
        thinkingLevel: 'high',
        maxOutputTokens: 4000,
    });
} catch (error) {
    anthropicCapacityError = error;
}

assertEqual(isOutputCapacityError(anthropicCapacityError), true, 'Anthropic thinking respects effective output cap');
const anthropicXHighThinkingBody = buildAnthropicMessagesBody(messages, 'claude-opus-5', {
    model: {
        thinking: {
            api: 'anthropic-adaptive',
            levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
            display: 'summarized',
        },
    },
    thinkingLevel: 'xhigh',
});
assertEqual(anthropicXHighThinkingBody.thinking.type, 'adaptive', 'Claude Opus 5 adaptive thinking');
assertEqual(anthropicXHighThinkingBody.output_config.effort, 'xhigh', 'Claude Opus 5 xhigh effort');
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
assertEqual(geminiBody.generationConfig.maxOutputTokens, 16384, 'Gemini default max output tokens');
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
const geminiParallelToolHistory = buildGeminiGenerateContentBody(parallelNativeToolMessages);
assertEqual(geminiParallelToolHistory.contents.length, 3, 'Gemini parallel tool history content grouping');
assertEqual(geminiParallelToolHistory.contents[1].parts.length, 2, 'Gemini parallel function call grouping');
assertEqual(geminiParallelToolHistory.contents[1].parts[0].thoughtSignature, 'gemini-parallel-signature', 'Gemini parallel first call signature');
assertEqual(hasOwn(geminiParallelToolHistory.contents[1].parts[1], 'thoughtSignature'), false, 'Gemini parallel later call omits signature');
assertEqual(geminiParallelToolHistory.contents[2].parts.length, 2, 'Gemini parallel function response grouping');
assertEqual(geminiParallelToolHistory.contents[2].parts[0].functionResponse.name, 'computer_observe', 'Gemini parallel first response');
assertEqual(geminiParallelToolHistory.contents[2].parts[1].functionResponse.name, 'computer_list', 'Gemini parallel second response');
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
const gemini37Body = buildGeminiGenerateContentBody(messages, {
    model: {
        thinking: {
            api: 'gemini-thinking-level',
            levels: ['low', 'medium', 'high'],
            defaultLevel: 'medium',
            alwaysOn: true,
            includeThoughts: true,
        },
    },
    thinkingLevel: 'medium',
    maxOutputTokens: 65536,
});
assertEqual(gemini37Body.generationConfig.thinkingConfig.thinkingLevel, 'medium', 'Gemini 3.7 thinking level');
assertEqual(gemini37Body.generationConfig.thinkingConfig.includeThoughts, true, 'Gemini 3.7 thought summaries');
assertEqual(gemini37Body.generationConfig.maxOutputTokens, 65536, 'Gemini 3.7 maximum output tokens');
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
            tools: ['google_search', 'google_maps', 'url_context'],
        },
    },
    tools: [searchTool, mcpTool],
});
assertEqual(hasOwn(geminiNativeSearchBody.tools[0], 'googleSearch'), true, 'Gemini native Google Search');
assertEqual(geminiNativeSearchBody.tools.some((tool) => hasOwn(tool, 'googleMaps')), false, 'Gemini omitted incompatible Google Maps');
assertEqual(hasOwn(geminiNativeSearchBody.tools[1], 'urlContext'), true, 'Gemini native URL Context');
assertEqual(geminiNativeSearchBody.tools[2].functionDeclarations[0].name, 'mcp__context7__resolve_library_id', 'Gemini retained client tool');
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
assertEqual(extractOpenAiReasoning({
    output: [{
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'DeepSeek reasoning' }],
    }],
}), 'DeepSeek reasoning', 'DeepSeek reasoning content extraction');
const separatedDeepSeekResponse = extractOpenAiResponse({
    output: [{
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'DeepSeek reasoning' }],
    }, {
        type: 'message',
        content: [{ type: 'output_text', text: 'DeepSeek answer' }],
    }],
});
assertEqual(
    separatedDeepSeekResponse.reasoning,
    'DeepSeek reasoning',
    'DeepSeek response keeps reasoning in its own channel',
);
assertEqual(
    separatedDeepSeekResponse.text,
    'DeepSeek answer',
    'DeepSeek response excludes reasoning from answer text',
);
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

const malformedChatResponse = extractChatCompletionResponse({
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            tool_calls: [{
                id: 'call-malformed',
                type: 'function',
                function: { name: 'artifact_create', arguments: '{"content":"unfinished' },
            }],
        },
    }],
});
assertEqual(malformedChatResponse.toolCallIntegrity.status, 'malformed', 'Malformed chat tool-call status');
assertEqual(malformedChatResponse.toolCalls[0].argumentsValid, false, 'Malformed chat arguments validity');
assertEqual(malformedChatResponse.toolCalls[0].rawArguments, '{"content":"unfinished', 'Malformed chat raw arguments');
const malformedRuntimeMessages = [
    createMessage('user', 'Create an artifact'),
    {
        ...createMessage('assistant', ''),
        toolCalls: malformedChatResponse.toolCalls,
    },
    {
        ...createMessage('tool', 'The tool call was incomplete.'),
        toolCallId: 'call-malformed',
        toolName: 'artifact_create',
    },
];
assertEqual(
    openAiMessages(malformedRuntimeMessages)[1].arguments,
    '{"content":"unfinished',
    'OpenAI Responses malformed arguments history preservation',
);
assertEqual(
    openAiCompatibleMessages(malformedRuntimeMessages)[1].tool_calls[0].function.arguments,
    '{"content":"unfinished',
    'Chat Completions malformed arguments history preservation',
);

const truncatedChatResponse = extractChatCompletionResponse({
    choices: [{
        finish_reason: 'length',
        message: {
            tool_calls: [{
                id: 'call-truncated',
                type: 'function',
                function: { name: 'artifact_create', arguments: '{"content":"unfinished' },
            }],
        },
    }],
});
assertEqual(truncatedChatResponse.toolCallIntegrity.status, 'truncated', 'Truncated chat tool-call status');

const outputLimitedChatResponse = extractChatCompletionResponse({
    choices: [{
        finish_reason: 'length',
        message: {
            tool_calls: [{
                id: 'call-output-limited',
                type: 'function',
                function: { name: 'artifact_create', arguments: '{"content":"complete"}' },
            }],
        },
    }],
});
assertEqual(outputLimitedChatResponse.toolCallIntegrity.status, 'output_limited', 'Parseable output-limited tool-call status');

const mixedChatResponse = extractChatCompletionResponse({
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            tool_calls: [{
                id: 'call-valid-sibling',
                type: 'function',
                function: { name: 'calc', arguments: '{"input":"2 + 2"}' },
            }, {
                id: 'call-invalid-sibling',
                type: 'function',
                function: { name: 'artifact_create', arguments: '{"content":"unfinished' },
            }],
        },
    }],
});
assertEqual(mixedChatResponse.toolCallIntegrity.status, 'malformed', 'Mixed chat tool-call status');
assertEqual(mixedChatResponse.toolCalls.length, 2, 'Mixed chat tool-call preservation');

const unnamedTruncatedChatResponse = extractChatCompletionResponse({
    choices: [{
        finish_reason: 'length',
        message: {
            tool_calls: [{
                id: 'call-unnamed',
                type: 'function',
                function: { name: '', arguments: '{"content":"unfinished' },
            }],
        },
    }],
});
assertEqual(unnamedTruncatedChatResponse.toolCallIntegrity.status, 'truncated', 'Unnamed truncated call status');
assertEqual(unnamedTruncatedChatResponse.toolCalls.length, 1, 'Unnamed truncated call preservation');

const truncatedOpenAiResponse = extractOpenAiResponse({
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{
        type: 'function_call',
        call_id: 'call-openai-truncated',
        name: 'artifact_create',
        arguments: '{"content":"unfinished',
    }],
});
assertEqual(truncatedOpenAiResponse.toolCallIntegrity.status, 'truncated', 'OpenAI Responses truncated tool-call status');
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
const geminiProviderResponse = {
    candidates: [{
        content: {
            parts: [
                {
                    toolCall: {
                        id: 'server-search-1',
                        toolType: 'GOOGLE_SEARCH_WEB',
                        args: { queries: ['Cusco GNOME'] },
                    },
                    thoughtSignature: 'server-search-signature',
                },
                {
                    toolResponse: {
                        id: 'server-search-1',
                        toolType: 'GOOGLE_SEARCH_WEB',
                        response: { searchSuggestions: 'Cusco GNOME' },
                    },
                    thoughtSignature: 'server-result-signature',
                },
                { text: 'Grounded Gemini response.' },
            ],
        },
        groundingMetadata: {
            webSearchQueries: ['Cusco GNOME', 'cafes near Taipei 101'],
            groundingChunks: [
                { web: { uri: 'https://example.com/cusco', title: 'Cusco' } },
                {
                    maps: {
                        uri: 'https://maps.google.com/?cid=123',
                        title: 'Taipei Cafe',
                        placeId: 'places/cafe-123',
                    },
                },
            ],
        },
        urlContextMetadata: {
            urlMetadata: [{
                retrievedUrl: 'https://example.com/docs',
                urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
            }, {
                retrievedUrl: 'https://example.com/private',
                urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_UNSAFE',
            }],
        },
    }],
};
const geminiServerToolResults = extractGeminiServerToolResults(geminiProviderResponse);
assertEqual(geminiServerToolResults.map((result) => result.name).join(','), 'search,google_maps,url_context', 'Gemini server tool result groups');
assertEqual(geminiServerToolResults[1].results[0].title, 'Taipei Cafe', 'Gemini Maps source extraction');
assertEqual(geminiServerToolResults[2].results[0].url, 'https://example.com/docs', 'Gemini URL Context source extraction');
assertEqual(geminiServerToolResults[2].results.length, 1, 'Gemini URL Context excluded failed retrievals from sources');
assertEqual(extractGeminiResponse(geminiProviderResponse).text.includes('— Google Maps'), true, 'Gemini Maps attribution');

const geminiProviderParts = extractGeminiProviderParts(geminiProviderResponse);
const geminiProviderHistoryBody = buildGeminiGenerateContentBody([
    createMessage('user', 'Find and summarize this.'),
    createMessage('assistant', 'Grounded Gemini response.', {
        metadata: { geminiProviderParts },
    }),
    createMessage('user', 'Continue with those sources.'),
]);
assertEqual(geminiProviderHistoryBody.contents[1].parts[0].toolCall.id, 'server-search-1', 'Gemini server tool call history');
assertEqual(geminiProviderHistoryBody.contents[1].parts[1].toolResponse.id, 'server-search-1', 'Gemini server tool response history');
assertEqual(geminiProviderHistoryBody.contents[1].parts[0].thoughtSignature, 'server-search-signature', 'Gemini server tool signature history');
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
assertEqual(discoveredModels[0].maxOutputTokens, 16384, 'Discovered model default output limit');

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

class BudgetCapturingProvider extends OpenAiCompatibleChatProvider {
    constructor(responses) {
        super({
            id: 'budget-capturing',
            name: 'Budget Capturing Provider',
            defaultModelId: 'budget-model',
            baseUrl: 'https://example.invalid',
            apiKey: 'test',
            apiFormat: 'openai-chat-completions',
        });
        this.responses = [...responses];
        this.requests = [];
    }

    async _complete(messagesForRequest, _modelId, options = {}) {
        this.requests.push({ messages: messagesForRequest, options });
        return this.responses.shift() ?? { text: 'Done', finishReason: 'stop' };
    }
}

const budgetMessages = [createMessage('user', 'x'.repeat(4000))];
const budgetTools = Array.from({ length: 24 }, (_value, index) => ({
    name: `large_tool_${index}`,
    description: 'y'.repeat(1000),
    inputSchema: {
        type: 'object',
        properties: { content: { type: 'string' } },
    },
}));
const budgetModel = {
    id: 'budget-model',
    maxOutputTokens: 32768,
    contextWindowTokens: 20000,
};
const budgetProvider = new BudgetCapturingProvider([{ text: 'Budgeted', finishReason: 'stop' }]);

for await (const _chunk of budgetProvider.streamChat(budgetMessages, {
    model: budgetModel,
    tools: budgetTools,
})) {
    // Collect the provider request options through the test double.
}

const serializedBudgetTools = buildOpenAiCompatibleChatBody(
    budgetMessages,
    budgetModel.id,
    {
        provider: budgetProvider._config,
        model: budgetModel,
        tools: budgetTools,
        maxOutputTokens: budgetModel.maxOutputTokens,
    },
).tools;
const serializedToolEstimate = estimateRequestInputTokens([], serializedBudgetTools);
const expectedBudget = resolveEffectiveMaxOutputTokens({
    configuredMaxOutputTokens: budgetModel.maxOutputTokens,
    contextWindowTokens: budgetModel.contextWindowTokens,
    estimatedInputTokens: estimateRequestInputTokens(budgetMessages, serializedBudgetTools),
});
assertEqual(serializedToolEstimate > 4096, true, 'Serialized tool schemas exceed the context reserve');
assertEqual(budgetProvider.requests[0].options.maxOutputTokens, expectedBudget, 'Provider effective output budget');

const continuationBudgetProvider = new BudgetCapturingProvider([
    { text: 'Part one ', finishReason: 'length' },
    { text: 'part two.', finishReason: 'stop' },
]);

for await (const _chunk of continuationBudgetProvider.streamChat(
    [createMessage('user', 'Continue'.repeat(400))],
    {
        model: {
            id: 'budget-model',
            maxOutputTokens: 32768,
            contextWindowTokens: 17000,
        },
        maxContinuationTurns: 1,
    },
)) {
    // The second internal request must include the continuation history in its estimate.
}

assertEqual(continuationBudgetProvider.requests.length, 2, 'Budgeted continuation request count');
assertEqual(
    continuationBudgetProvider.requests[1].options.maxOutputTokens
        < continuationBudgetProvider.requests[0].options.maxOutputTokens,
    true,
    'Continuation output budget is recalculated',
);

const exhaustedBudgetProvider = new BudgetCapturingProvider([{ text: 'Must not dispatch', finishReason: 'stop' }]);
let exhaustedBudgetError = null;

try {
    for await (const _chunk of exhaustedBudgetProvider.streamChat(
        [createMessage('user', 'No capacity')],
        {
            model: {
                id: 'budget-model',
                maxOutputTokens: 32768,
                contextWindowTokens: 4096,
            },
        },
    )) {
        // A capacity failure should happen before any provider response.
    }
} catch (error) {
    exhaustedBudgetError = error;
}

assertEqual(isOutputCapacityError(exhaustedBudgetError), true, 'Exhausted context raises capacity error');
assertEqual(exhaustedBudgetProvider.requests.length, 0, 'Exhausted context prevents provider dispatch');

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

class InterruptedResponseProvider extends ContinuingProvider {
    constructor() {
        super([]);
        this.interrupted = false;
    }

    async _complete(messagesForRequest, _modelId, _options = {}) {
        this.calls.push(messagesForRequest);

        if (!this.interrupted) {
            this.interrupted = true;
            const error = new GLib.Error(
                Gio.tls_error_quark(),
                Gio.TlsError.HANDSHAKE,
                'Peer failed to perform TLS handshake: The TLS connection was non-properly terminated.',
            );
            error.providerResponseStarted = true;
            throw error;
        }

        return { text: 'Recovered after interruption', finishReason: 'stop' };
    }
}

const interruptedResponseProvider = new InterruptedResponseProvider();
const interruptedResponseStatuses = [];
let interruptedResponseText = '';

for await (const chunk of interruptedResponseProvider.streamChat([createMessage('user', 'Retry this interrupted request')])) {
    if (chunk?.type === 'status')
        interruptedResponseStatuses.push(chunk.text);
    else if (typeof chunk === 'string')
        interruptedResponseText += chunk;
}

assertEqual(interruptedResponseProvider.calls.length, 2, 'Interrupted response replay count');
assertEqual(interruptedResponseStatuses.length, 1, 'Interrupted response retry status count');
assertEqual(
    interruptedResponseStatuses[0],
    'Connection interrupted. Retrying 1/5\u2026',
    'Interrupted response retry status',
);
assertEqual(interruptedResponseText, 'Recovered after interruption', 'Interrupted response recovery text');

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
