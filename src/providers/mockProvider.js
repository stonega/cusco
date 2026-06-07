import GLib from 'gi://GLib?version=2.0';

import { ChatProvider } from './provider.js';

const STREAM_DELAY_MS = 35;

function delay(milliseconds) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function streamChunks(text) {
    return text.match(/\S+\s*/g) ?? [text];
}

export class MockProvider extends ChatProvider {
    constructor() {
        super({
            id: 'mock',
            name: 'Mock Provider',
        });
    }

    async *streamChat(messages, _options = {}) {
        const latestUserMessage = messages.findLast((message) => message.role === 'user');
        const response = this._buildResponse(latestUserMessage?.content ?? '');

        for (const chunk of streamChunks(response)) {
            await delay(STREAM_DELAY_MS);
            yield chunk;
        }
    }

    _buildResponse(prompt) {
        if (!prompt)
            return 'Cusco is ready. Ask a question to test the streaming chat flow.';

        return [
            `I received: "${prompt}".`,
            'This response is coming from the local mock provider, streamed one chunk at a time.',
            'Next we can replace this provider with OpenAI, Anthropic, Gemini, DeepSeek, or a custom API without rewriting the chat surface.',
        ].join(' ');
    }
}
