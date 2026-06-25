import GLib from 'gi://GLib?version=2.0';

import { ChatProvider } from './provider.js';
import { normalizeThinkingLevel } from './thinking.js';
import { normalizeTokenUsage } from './usage.js';

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

function estimateTokens(text) {
    const normalized = String(text ?? '').trim();

    if (!normalized)
        return 0;

    return Math.max(1, Math.ceil(normalized.length / 4));
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
        const thinkingLevel = options.thinkingLevel === undefined
            ? 'off'
            : normalizeThinkingLevel(options.thinkingLevel);

        if (thinkingLevel !== 'off') {
            const reasoningText = `Mock reasoning summary (${thinkingLevel}): identified the latest user prompt and selected a local canned response.`;
            yield {
                type: 'usage',
                usage: normalizeTokenUsage({
                    inputTokens: estimateTokens(latestUserMessage?.content ?? ''),
                    outputTokens: estimateTokens(response),
                    reasoningTokens: estimateTokens(reasoningText),
                    estimated: true,
                }),
            };
            yield {
                type: 'reasoning',
                text: reasoningText,
            };
        }

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
            'Next we can replace this provider with OpenAI, Anthropic, Gemini, DeepSeek, MiniMax, or a custom API without rewriting the chat surface.',
        ].join(' ');
    }
}
