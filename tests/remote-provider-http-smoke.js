import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import {
    discoverOpenAiCompatibleModels,
    OpenAiCompatibleChatProvider,
} from '../src/providers/remoteProvider.js';
import { createMessage } from '../src/providers/provider.js';

function assertEqual(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

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

const server = new Soup.Server();
let sawNativeTools = false;

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

server.add_handler('/v1/rate-limited', (_server, message) => {
    setJsonErrorResponse(message, 429, {
        error: {
            message: 'Rate limit exceeded',
        },
    });
});

let listening = false;

try {
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    listening = true;
} catch (error) {
    print(`Cusco remote provider HTTP smoke skipped: ${error.message}`);
}

if (listening) {
    try {
        const baseUrl = `${server.get_uris()[0].to_string().replace(/\/$/, '')}/v1`;
        const config = {
            id: 'local-openai-compatible',
            name: 'Local OpenAI Compatible',
            baseUrl,
            apiKey: 'test-key',
            defaultModelId: 'local-model',
        };

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
    } finally {
        server.disconnect();
    }

    print('Cusco remote provider HTTP smoke passed');
}
