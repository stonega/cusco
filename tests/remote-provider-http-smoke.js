import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import {
    AnthropicMessagesProvider,
    discoverOpenAiCompatibleModels,
    GeminiGenerateContentProvider,
    isNetworkError,
    isTransientTlsError,
    OpenAiCompatibleChatProvider,
    OpenAiResponsesProvider,
    ServerSentEventDecoder,
} from '../src/providers/remoteProvider.js';
import { createMessage } from '../src/providers/provider.js';

function assertEqual(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const tlsHandshakeError = new GLib.Error(
    Gio.tls_error_quark(),
    Gio.TlsError.HANDSHAKE,
    'TLS handshake failed',
);
const tlsEofError = new GLib.Error(
    Gio.tls_error_quark(),
    Gio.TlsError.EOF,
    'TLS connection terminated',
);
const badCertificateError = new GLib.Error(
    Gio.tls_error_quark(),
    Gio.TlsError.BAD_CERTIFICATE,
    'Bad certificate',
);
const networkUnreachableError = new GLib.Error(
    Gio.io_error_quark(),
    Gio.IOErrorEnum.NETWORK_UNREACHABLE,
    'Network unreachable',
);
const cancelledError = new GLib.Error(
    Gio.io_error_quark(),
    Gio.IOErrorEnum.CANCELLED,
    'Cancelled',
);

assertEqual(isTransientTlsError(tlsHandshakeError), true, 'TLS handshake errors are transient');
assertEqual(isTransientTlsError(tlsEofError), true, 'TLS EOF errors are transient');
assertEqual(isTransientTlsError(badCertificateError), false, 'Certificate errors are not transient');
assertEqual(isNetworkError(networkUnreachableError), true, 'Network unreachable errors are retryable');
assertEqual(isNetworkError(cancelledError), false, 'Cancellation errors are not retryable');

function setJsonResponse(message, body) {
    message.set_status(Soup.Status.OK, null);
    message.set_response('application/json', Soup.MemoryUse.COPY, JSON.stringify(body));
}

function setJsonErrorResponse(message, status, body) {
    message.set_status(status, null);
    message.set_response('application/json', Soup.MemoryUse.COPY, JSON.stringify(body));
}

function requestJson(message) {
    return JSON.parse(new TextDecoder().decode(message.get_request_body().flatten().get_data()));
}

function setEventStreamResponse(message, chunks) {
    const responseBody = message.get_response_body();
    let chunkIndex = 0;
    let finished = false;

    message.set_status(Soup.Status.OK, null);
    message.get_response_headers().replace('Content-Type', 'text/event-stream');
    message.get_response_headers().set_encoding(Soup.Encoding.CHUNKED);
    responseBody.set_accumulate(false);
    message.connect('finished', () => {
        finished = true;
    });

    const appendChunk = () => {
        if (finished)
            return GLib.SOURCE_REMOVE;

        responseBody.append_bytes(new GLib.Bytes(new TextEncoder().encode(chunks[chunkIndex])));
        chunkIndex++;

        if (chunkIndex === chunks.length) {
            responseBody.complete();
            message.unpause();
            return GLib.SOURCE_REMOVE;
        }

        message.unpause();
        return GLib.SOURCE_CONTINUE;
    };

    appendChunk();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, appendChunk);
}

const fragmentedDecoder = new ServerSentEventDecoder();
let fragmentedEvents = fragmentedDecoder.push('event: message\r\ndata: {"text":"hel');
fragmentedEvents.push(...fragmentedDecoder.push('lo"}\r\n\r\n'));
assertEqual(fragmentedEvents.length, 1, 'Fragmented SSE event count');
assertEqual(fragmentedEvents[0].event, 'message', 'Fragmented SSE event name');
assertEqual(fragmentedEvents[0].data, '{"text":"hello"}', 'Fragmented SSE event data');

const standardDecoder = new ServerSentEventDecoder();
const standardEvents = standardDecoder.push('\uFEFF: keepalive\revent: message\rdata: first\rdata: second\r\revent: stale\r\rdata: final\r\r');
standardEvents.push(...standardDecoder.finish());
assertEqual(standardEvents.length, 2, 'Standard SSE boundary event count');
assertEqual(standardEvents[0].event, 'message', 'CR-only SSE event name');
assertEqual(standardEvents[0].data, 'first\nsecond', 'Multiline SSE data');
assertEqual(standardEvents[1].event, '', 'SSE event name resets without data');
assertEqual(standardEvents[1].data, 'final', 'UTF-8 BOM and comment handling');

let oversizedLineError = null;

try {
    new ServerSentEventDecoder({
        providerName: 'Limited Provider',
        maxLineChars: 8,
    }).push('data: oversized');
} catch (error) {
    oversizedLineError = error;
}

assertEqual(
    oversizedLineError?.userMessage,
    'Limited Provider returned an oversized streaming line.',
    'Oversized SSE line error',
);

let oversizedEventError = null;

try {
    new ServerSentEventDecoder({
        providerName: 'Limited Provider',
        maxLineChars: 32,
        maxEventChars: 8,
    }).push('data: 12345\ndata: 6789\n\n');
} catch (error) {
    oversizedEventError = error;
}

assertEqual(
    oversizedEventError?.userMessage,
    'Limited Provider returned an oversized streaming event.',
    'Oversized SSE event error',
);

async function collectStreamChunks(provider, options = {}) {
    const chunks = [];

    for await (const chunk of provider.streamChat([createMessage('user', 'Stream this')], {
        timeoutSeconds: 5,
        ...options,
    }))
        chunks.push(chunk);

    return chunks;
}

function textChunks(chunks) {
    return chunks.filter((chunk) => typeof chunk === 'string');
}

function resolvedText(chunks) {
    let text = '';

    for (const chunk of chunks) {
        if (typeof chunk === 'string')
            text += chunk;
        else if (chunk?.type === 'text')
            text = chunk.replace ? String(chunk.text ?? '') : text + String(chunk.text ?? '');
    }

    return text;
}

async function collectTextChunks(provider) {
    return textChunks(await collectStreamChunks(provider));
}

function eventData(data) {
    return `data: ${JSON.stringify(data)}\n\n`;
}

const server = new Soup.Server();
let sawNativeTools = false;
let sawStreamingRequest = false;
let sawStreamingUsageRequest = false;
let sawDeepSeekResponsesRequest = false;
let sawAuthorizedRequest = false;
let interruptedStreamRequestCount = 0;
let interruptedBeforeOutputRequestCount = 0;
let strictStreamingRequestAccepted = false;
let rateLimitedRequestCount = 0;
let requestTimeoutRequestCount = 0;

GLib.setenv('NO_PROXY', '127.0.0.1,localhost', true);
GLib.setenv('no_proxy', '127.0.0.1,localhost', true);
GLib.unsetenv('HTTP_PROXY');
GLib.unsetenv('HTTPS_PROXY');
GLib.unsetenv('http_proxy');
GLib.unsetenv('https_proxy');

server.add_handler('/v1/models', (_server, message) => {
    setJsonResponse(message, {
        data: [
            { id: 'local-model', name: 'Local Model' },
        ],
    });
});

server.add_handler('/v1/chat/completions', (_server, message) => {
    const request = requestJson(message);
    sawNativeTools = Array.isArray(request.tools)
        && request.tools.some((tool) => tool.function?.name === 'calc');

    setJsonResponse(message, {
        choices: [
            {
                message: {
                    content: 'Local provider response',
                },
            },
        ],
    });
});

server.add_handler('/v1/chat/authorized', (_server, message) => {
    const request = requestJson(message);
    sawAuthorizedRequest = message.get_request_headers().get_one('X-Cusco-Auth') === 'oauth-fixture'
        && request.auth_profile === true;
    setJsonResponse(message, {
        choices: [{ message: { content: 'Authorized provider response' } }],
    });
});

server.add_handler('/v1/chat/streaming', (_server, message) => {
    const request = requestJson(message);
    sawStreamingRequest = request.stream === true;
    sawStreamingUsageRequest = request.stream_options?.include_usage === true;
    setEventStreamResponse(message, [
        eventData({ choices: [{ delta: { content: 'Hello ' }, finish_reason: null }] }),
        eventData({
            choices: [{
                delta: {
                    content: 'world',
                    tool_calls: [{
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'calc', arguments: '{"expression":"' },
                    }],
                },
                finish_reason: null,
            }],
        }),
        eventData({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        function: { arguments: '2+2"}' },
                    }],
                },
                finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
        'data: [DONE]\n\n',
    ]);
});

server.add_handler('/v1/chat/truncated-tool', (_server, message) => {
    setEventStreamResponse(message, [
        eventData({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: 'call-truncated-stream',
                        type: 'function',
                        function: { name: 'artifact_create', arguments: '{"content":"' },
                    }],
                },
                finish_reason: null,
            }],
        }),
        eventData({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        function: { arguments: 'unfinished' },
                    }],
                },
                finish_reason: 'length',
            }],
        }),
        'data: [DONE]\n\n',
    ]);
});

server.add_handler('/v1/chat/output-limited-tool', (_server, message) => {
    setEventStreamResponse(message, [
        eventData({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: 'call-output-limited-stream',
                        type: 'function',
                        function: { name: 'artifact_create', arguments: '{"content":"complete"}' },
                    }],
                },
                finish_reason: 'length',
            }],
        }),
        'data: [DONE]\n\n',
    ]);
});

server.add_handler('/v1/chat/interrupted', (_server, message) => {
    interruptedStreamRequestCount++;
    setEventStreamResponse(message, [
        eventData({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }),
    ]);
});

server.add_handler('/v1/chat/interrupted-before-output', (_server, message) => {
    interruptedBeforeOutputRequestCount++;

    if (interruptedBeforeOutputRequestCount === 1) {
        setEventStreamResponse(message, [
            eventData({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
        ]);
        return;
    }

    setEventStreamResponse(message, [
        eventData({ choices: [{ delta: { content: 'Recovered before output' }, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
    ]);
});

server.add_handler('/v1/chat/final-reconciliation', (_server, message) => {
    setEventStreamResponse(message, [
        eventData({ choices: [{ delta: { content: 'Answer ' }, finish_reason: null }] }),
        eventData({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            web_search: [{ title: 'Documentation', url: 'https://example.com/docs' }],
        }),
        'data: [DONE]\n\n',
    ]);
});

server.add_handler('/v1/chat/strict-streaming', (_server, message) => {
    const request = requestJson(message);

    if (Object.hasOwn(request, 'stream_options')) {
        setJsonErrorResponse(message, Soup.Status.BAD_REQUEST, {
            error: { message: 'Unknown field: stream_options' },
        });
        return;
    }

    strictStreamingRequestAccepted = true;
    setEventStreamResponse(message, [
        eventData({ choices: [{ delta: { content: 'Strict stream accepted' }, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
    ]);
});

server.add_handler('/v1/chat/utf8-boundary', (_server, message) => {
    const eventPrefix = 'data: {"choices":[{"delta":{"content":"';
    const paddingLength = (16 * 1024) - 1 - new TextEncoder().encode(eventPrefix).length;
    const content = `${'x'.repeat(paddingLength)}🙂tail`;

    setEventStreamResponse(message, [
        eventData({ choices: [{ delta: { content }, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
    ]);
});

server.add_handler('/v1/responses', (_server, message) => {
    const request = requestJson(message);

    if (request.stream !== true)
        throw new Error('OpenAI Responses request did not enable streaming');

    setEventStreamResponse(message, [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-test","output":[]}}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"OpenAI thought"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OpenAI "}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"stream"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-test","status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"OpenAI thought"}]},{"type":"message","content":[{"type":"output_text","text":"OpenAI stream"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
    ]);
});

server.add_handler('/deepseek/responses', (_server, message) => {
    const request = requestJson(message);
    const hasWebSearch = request.tools?.some((tool) => tool?.type === 'web_search');
    const hasCalc = request.tools?.some((tool) => tool?.type === 'function' && tool?.name === 'calc');

    sawDeepSeekResponsesRequest = request.stream === true
        && request.model === 'deepseek-v4-pro'
        && request.reasoning?.effort === 'high'
        && !Object.hasOwn(request.reasoning ?? {}, 'summary')
        && hasWebSearch
        && hasCalc;

    setEventStreamResponse(message, [
        'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"deepseek-resp-test","output":[]}}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","sequence_number":1,"delta":"DeepSeek thought"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":2,"delta":"DeepSeek "}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":3,"delta":"stream"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","sequence_number":4,"response":{"id":"deepseek-resp-test","status":"completed","output":[{"type":"reasoning","content":[{"type":"reasoning_text","text":"DeepSeek thought"}],"summary":[]},{"type":"message","content":[{"type":"output_text","text":"DeepSeek stream"}]}],"usage":{"input_tokens":7,"input_tokens_details":{"cached_tokens":2},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":3},"total_tokens":12}}}\n\n',
    ]);
});

server.add_handler('/v1/messages', (_server, message) => {
    const request = requestJson(message);

    if (request.stream !== true)
        throw new Error('Anthropic request did not enable streaming');

    setEventStreamResponse(message, [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-test","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Anthropic"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"calc","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"expression\\":\\"2+2\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"stream"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":3,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"thinking_delta","thinking":"Anthropic thought"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"signature_delta","signature":"signature-1"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":3}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
});

server.add_handler('/v1/models/local-model:streamGenerateContent', (_server, message) => {
    setEventStreamResponse(message, [
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini thought","thought":true}]}}]}\n\n',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"stream"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
    ]);
});

server.add_handler('/v1/rate-limited', (_server, message) => {
    rateLimitedRequestCount++;
    setJsonErrorResponse(message, 429, {
        error: {
            message: 'Rate limit exceeded',
        },
    });
});

server.add_handler('/v1/request-timeout', (_server, message) => {
    requestTimeoutRequestCount++;

    if (requestTimeoutRequestCount === 1) {
        setJsonErrorResponse(message, Soup.Status.REQUEST_TIMEOUT, {
            error: {
                message: 'Upstream response stream timed out',
            },
        });
        return;
    }

    setJsonResponse(message, {
        choices: [
            {
                message: {
                    content: 'Recovered after HTTP 408',
                },
            },
        ],
    });
});

let listening = false;
let localProviderConfig = null;

try {
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    listening = true;
} catch (error) {
    print(`Cusco remote provider HTTP smoke skipped: ${error.message}`);
}

if (listening) {
    try {
        const serverBaseUrl = server.get_uris()[0].to_string().replace(/\/$/, '');
        const baseUrl = `${serverBaseUrl}/v1`;
        const config = {
            id: 'local-openai-compatible',
            name: 'Local OpenAI Compatible',
            baseUrl,
            apiKey: 'test-key',
            defaultModelId: 'local-model',
        };
        localProviderConfig = config;

        const models = await discoverOpenAiCompatibleModels(config, { timeoutSeconds: 5 });
        assertEqual(models.length, 1, 'Discovered model count');
        assertEqual(models[0].id, 'local-model', 'Discovered model id');

        const provider = new OpenAiCompatibleChatProvider(config);
        let text = '';

        for await (const chunk of provider.streamChat([createMessage('user', 'Hello')], {
            timeoutSeconds: 5,
            tools: [{
                name: 'calc',
                label: 'Calculator',
                description: 'Evaluate a math expression.',
                inputDescription: 'Expression.',
            }],
        }))
            text += chunk;

        assertEqual(text, 'Local provider response', 'Streamed provider text');
        assertEqual(sawNativeTools, true, 'Native tool definitions were sent');

        const authorizedProvider = new OpenAiCompatibleChatProvider({
            ...config,
            apiKey: '',
            authorizeRequest: async (request) => ({
                ...request,
                url: `${baseUrl}/chat/authorized`,
                headers: { ...request.headers, 'X-Cusco-Auth': 'oauth-fixture' },
                body: { ...request.body, auth_profile: true },
            }),
        });
        const authorizedText = await collectTextChunks(authorizedProvider);
        assertEqual(authorizedText.join(''), 'Authorized provider response', 'Authorized provider text');
        assertEqual(sawAuthorizedRequest, true, 'Provider request authorizer was applied before transport');

        const streamingProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'Streaming Provider',
            chatPath: '/chat/streaming',
            supportsStreamUsageOptions: true,
        });
        const streamingEvents = await collectStreamChunks(streamingProvider);
        const streamingChunks = textChunks(streamingEvents);
        const streamingUsage = streamingEvents.find((chunk) => chunk?.type === 'usage');
        const streamingToolCalls = streamingEvents.find((chunk) => chunk?.type === 'tool_calls');

        assertEqual(sawStreamingRequest, true, 'Streaming request flag');
        assertEqual(sawStreamingUsageRequest, true, 'Streaming usage request flag');
        assertEqual(streamingChunks.length, 2, 'Network stream chunk count');
        assertEqual(streamingChunks[0], 'Hello ', 'First network stream chunk');
        assertEqual(streamingChunks[1], 'world', 'Second network stream chunk');
        assertEqual(streamingUsage?.usage?.totalTokens, 6, 'Network stream usage');
        assertEqual(streamingToolCalls?.toolCalls?.[0]?.name, 'calc', 'Network stream tool name');
        assertEqual(
            streamingToolCalls?.toolCalls?.[0]?.input,
            '{"expression":"2+2"}',
            'Network stream fragmented tool input',
        );
        assertEqual(streamingToolCalls?.integrity?.status, 'valid', 'Network stream valid tool integrity');

        const truncatedToolProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'Truncated Tool Provider',
            chatPath: '/chat/truncated-tool',
        });
        const truncatedToolEvents = await collectStreamChunks(truncatedToolProvider);
        const truncatedToolChunk = truncatedToolEvents.find(chunk => chunk?.type === 'tool_calls');

        assertEqual(truncatedToolChunk?.integrity?.status, 'truncated', 'Network stream truncated tool integrity');
        assertEqual(truncatedToolChunk?.toolCalls?.length, 1, 'Network stream truncated tool preservation');
        assertEqual(truncatedToolChunk?.toolCalls?.[0]?.argumentsValid, false, 'Network stream truncated arguments validity');
        assertEqual(truncatedToolChunk?.toolCalls?.[0]?.input, '', 'Network stream truncated arguments are not executable');
        assertEqual(
            truncatedToolChunk?.toolCalls?.[0]?.rawArguments,
            '{"content":"unfinished',
            'Network stream truncated raw arguments',
        );

        const outputLimitedToolProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'Output Limited Tool Provider',
            chatPath: '/chat/output-limited-tool',
        });
        const outputLimitedToolEvents = await collectStreamChunks(outputLimitedToolProvider);
        const outputLimitedToolChunk = outputLimitedToolEvents.find(chunk => chunk?.type === 'tool_calls');

        assertEqual(outputLimitedToolChunk?.integrity?.status, 'output_limited', 'Network stream parseable output-limit integrity');
        assertEqual(outputLimitedToolChunk?.toolCalls?.[0]?.argumentsValid, true, 'Network stream parseable output-limit arguments');

        const interruptedProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'Interrupted Streaming Provider',
            chatPath: '/chat/interrupted',
        });
        let interruptedText = '';
        let interruptedError = null;

        try {
            for await (const chunk of interruptedProvider.streamChat([createMessage('user', 'Interrupt this')], {
                timeoutSeconds: 5,
            })) {
                if (typeof chunk === 'string')
                    interruptedText += chunk;
            }
        } catch (error) {
            interruptedError = error;
        }

        assertEqual(interruptedText, 'partial', 'Interrupted stream preserves partial text');
        assertEqual(interruptedStreamRequestCount, 1, 'Interrupted stream is not replayed after output');

        if (!interruptedError?.userMessage?.includes('ended before completion'))
            throw new Error(`Interrupted stream error was not user-visible: ${interruptedError?.userMessage}`);

        const interruptedBeforeOutputProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'Interrupted Before Output Provider',
            chatPath: '/chat/interrupted-before-output',
        });
        const interruptedBeforeOutputEvents = await collectStreamChunks(interruptedBeforeOutputProvider);

        assertEqual(
            interruptedBeforeOutputRequestCount,
            2,
            'Interrupted stream before output retries once',
        );
        assertEqual(
            interruptedBeforeOutputEvents.filter((chunk) => chunk?.type === 'status').length,
            1,
            'Interrupted stream before output reconnect status',
        );
        assertEqual(
            resolvedText(interruptedBeforeOutputEvents),
            'Recovered before output',
            'Interrupted stream before output recovery text',
        );

        const reconciliationProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'Final Reconciliation Provider',
            chatPath: '/chat/final-reconciliation',
        });
        const reconciliationEvents = await collectStreamChunks(reconciliationProvider);
        const reconciliationReplacement = reconciliationEvents.find((chunk) => chunk?.replace === true);

        assertEqual(
            resolvedText(reconciliationEvents),
            'Answer\n\nSources:\n- [Documentation](https://example.com/docs)',
            'Authoritative final text replaces a mismatched stream',
        );
        assertEqual(reconciliationReplacement?.type, 'text', 'Authoritative text replacement chunk');

        const strictStreamingProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'Strict Streaming Provider',
            chatPath: '/chat/strict-streaming',
        });
        assertEqual(
            (await collectTextChunks(strictStreamingProvider)).join(''),
            'Strict stream accepted',
            'Strict OpenAI-compatible stream response',
        );
        assertEqual(strictStreamingRequestAccepted, true, 'Strict stream omitted unsupported options');

        const utf8BoundaryProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'UTF-8 Boundary Provider',
            chatPath: '/chat/utf8-boundary',
        });
        const utf8BoundaryText = (await collectTextChunks(utf8BoundaryProvider)).join('');

        assertEqual(utf8BoundaryText.endsWith('🙂tail'), true, 'Split UTF-8 stream character');
        assertEqual(utf8BoundaryText.includes('\uFFFD'), false, 'Split UTF-8 stream replacement character');

        const openAiResponsesProvider = new OpenAiResponsesProvider({
            ...config,
            name: 'OpenAI Responses Provider',
        });
        const openAiEvents = await collectStreamChunks(openAiResponsesProvider);
        const openAiChunks = textChunks(openAiEvents);

        assertEqual(openAiChunks.join(''), 'OpenAI stream', 'OpenAI Responses streamed text');
        assertEqual(openAiChunks.length, 2, 'OpenAI Responses network chunk count');
        assertEqual(
            openAiEvents.find((chunk) => chunk?.type === 'reasoning')?.text,
            'OpenAI thought',
            'OpenAI Responses streamed reasoning',
        );
        assertEqual(
            openAiEvents.find((chunk) => chunk?.type === 'usage')?.usage?.totalTokens,
            5,
            'OpenAI Responses stream usage',
        );

        const deepSeekResponsesProvider = new OpenAiResponsesProvider({
            ...config,
            id: 'deepseek',
            name: 'DeepSeek Responses Provider',
            baseUrl: `${serverBaseUrl}/deepseek`,
            defaultModelId: 'deepseek-v4-pro',
            supportsImageAttachments: false,
            supportsReasoningContentItems: true,
            nativeSearch: {
                api: 'openai-responses',
                tools: ['web_search'],
            },
        });
        const deepSeekEvents = await collectStreamChunks(deepSeekResponsesProvider, {
            model: {
                id: 'deepseek-v4-pro',
                thinking: {
                    api: 'openai-responses',
                    levels: ['low', 'high', 'max'],
                    defaultLevel: 'high',
                    alwaysOn: true,
                },
            },
            thinkingLevel: 'high',
            tools: [
                {
                    name: 'search',
                    label: 'Web Search',
                    description: 'Search the web.',
                    inputDescription: 'Search query.',
                },
                {
                    name: 'calc',
                    label: 'Calculator',
                    description: 'Evaluate a math expression.',
                    inputDescription: 'Expression.',
                },
            ],
        });
        const deepSeekChunks = textChunks(deepSeekEvents);

        assertEqual(sawDeepSeekResponsesRequest, true, 'DeepSeek Responses request shape');
        assertEqual(deepSeekChunks.join(''), 'DeepSeek stream', 'DeepSeek Responses streamed text');
        assertEqual(
            deepSeekEvents.find((chunk) => chunk?.type === 'reasoning')?.text,
            'DeepSeek thought',
            'DeepSeek Responses streamed reasoning',
        );
        assertEqual(
            deepSeekEvents.find((chunk) => chunk?.type === 'usage')?.usage?.reasoningTokens,
            3,
            'DeepSeek Responses reasoning usage',
        );

        const anthropicProvider = new AnthropicMessagesProvider({
            ...config,
            name: 'Anthropic Provider',
        });
        const anthropicEvents = await collectStreamChunks(anthropicProvider);
        const anthropicChunks = textChunks(anthropicEvents);
        const anthropicUsage = anthropicEvents.find((chunk) => chunk?.type === 'usage');
        const anthropicToolCalls = anthropicEvents.find((chunk) => chunk?.type === 'tool_calls');

        assertEqual(anthropicChunks.join(''), 'Anthropic\nstream', 'Anthropic streamed text blocks');
        assertEqual(anthropicChunks.length, 2, 'Anthropic network chunk count');
        assertEqual(anthropicUsage?.usage?.totalTokens, 5, 'Anthropic stream usage');
        assertEqual(
            anthropicEvents.find((chunk) => chunk?.type === 'reasoning')?.text,
            'Anthropic thought',
            'Anthropic streamed reasoning',
        );
        assertEqual(anthropicToolCalls?.toolCalls?.[0]?.name, 'calc', 'Anthropic stream tool name');
        assertEqual(
            anthropicToolCalls?.toolCalls?.[0]?.input,
            '{"expression":"2+2"}',
            'Anthropic fragmented tool input',
        );

        const geminiProvider = new GeminiGenerateContentProvider({
            ...config,
            name: 'Gemini Provider',
        });
        const geminiEvents = await collectStreamChunks(geminiProvider);
        const geminiChunks = textChunks(geminiEvents);

        assertEqual(geminiChunks.join(''), 'Gemini stream', 'Gemini streamed text');
        assertEqual(geminiChunks.length, 2, 'Gemini network chunk count');
        assertEqual(
            geminiEvents.find((chunk) => chunk?.type === 'reasoning')?.text,
            'Gemini thought',
            'Gemini streamed reasoning',
        );
        assertEqual(
            geminiEvents.find((chunk) => chunk?.type === 'usage')?.usage?.totalTokens,
            5,
            'Gemini stream usage',
        );

        const rateLimitedProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'Rate Limited Provider',
            chatPath: '/rate-limited',
        });
        let sawRateLimitError = false;

        try {
            for await (const _chunk of rateLimitedProvider.streamChat([createMessage('user', 'Hello')], { timeoutSeconds: 5 })) {
                // The provider should fail before yielding chunks.
            }
        } catch (error) {
            sawRateLimitError = true;

            if (!error.message.includes('(429)') || error.message.includes('enumeration Status'))
                throw new Error(`429 response was not surfaced cleanly: ${error.message}`);

            if (!error.userMessage?.includes('(429)') || !error.userMessage?.includes('Rate limit exceeded'))
                throw new Error(`429 response did not include user-visible provider details: ${error.userMessage}`);
        }

        if (!sawRateLimitError)
            throw new Error('429 response did not fail the provider request');

        assertEqual(rateLimitedRequestCount, 1, 'HTTP 429 errors are not retried');

        const requestTimeoutProvider = new OpenAiCompatibleChatProvider({
            ...config,
            name: 'Request Timeout Provider',
            chatPath: '/request-timeout',
        });
        const requestTimeoutStatuses = [];
        let requestTimeoutText = '';

        for await (const chunk of requestTimeoutProvider.streamChat([createMessage('user', 'Hello')], { timeoutSeconds: 5 })) {
            if (chunk?.type === 'status')
                requestTimeoutStatuses.push(chunk.text);
            else
                requestTimeoutText += chunk;
        }

        assertEqual(requestTimeoutRequestCount, 2, 'HTTP 408 retry request count');
        assertEqual(requestTimeoutStatuses.length, 1, 'HTTP 408 retry status count');
        assertEqual(requestTimeoutStatuses[0], 'Request timed out. Retrying 1/5\u2026', 'HTTP 408 retry status');
        assertEqual(requestTimeoutText, 'Recovered after HTTP 408', 'HTTP 408 recovered response');
    } finally {
        server.disconnect();
    }

    const disconnectedProvider = new OpenAiCompatibleChatProvider(localProviderConfig);
    let disconnectedRequestFailed = false;
    let reconnectStatusCount = 0;

    try {
        for await (const chunk of disconnectedProvider.streamChat([createMessage('user', 'Hello')], { timeoutSeconds: 1 })) {
            if (chunk?.type === 'status')
                reconnectStatusCount++;
        }
    } catch (error) {
        disconnectedRequestFailed = true;

        if (!isNetworkError(error))
            throw new Error(`Disconnected provider did not surface a network error: ${error.message}`);
    }

    assertEqual(disconnectedRequestFailed, true, 'Disconnected provider request failed');
    assertEqual(reconnectStatusCount, 5, 'Disconnected provider reconnect count');

    print('Cusco remote provider HTTP smoke passed');
}
