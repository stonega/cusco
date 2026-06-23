import GLib from 'gi://GLib?version=2.0';

import { ChatProvider } from './provider.js';

const STREAM_DELAY_MS = 35;

function isCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

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

    async *streamChat(messages, options = {}) {
        const latestUserMessage = messages.findLast((message) => message.role === 'user');
        const response = this._buildResponse(latestUserMessage?.content ?? '', options);

        for (const chunk of streamChunks(response)) {
            if (isCancelled(options.cancellable))
                return;

            await delay(STREAM_DELAY_MS);

            if (isCancelled(options.cancellable))
                return;

            yield chunk;
        }
    }

    _buildResponse(prompt, options) {
        if (!prompt)
            return 'Cusco is ready. Ask a question to test the streaming chat flow.';

        const modelName = options.model?.name ?? 'Mock Model';

        return [
            `I received: "${prompt}".`,
            `This response is coming from ${modelName}, streamed one chunk at a time.`,
            'Next we can replace this provider with OpenAI, Anthropic, Gemini, DeepSeek, or a custom API without rewriting the chat surface.',
        ].join(' ');
    }
}
