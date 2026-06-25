import Gio from 'gi://Gio?version=2.0';

import { createMessage } from '../src/providers/provider.js';
import { MockProvider } from '../src/providers/mockProvider.js';

const provider = new MockProvider();
let streamedText = '';

for await (const chunk of provider.streamChat([createMessage('user', 'hello')]))
    streamedText += chunk;

if (!streamedText.includes('hello'))
    throw new Error(`Mock provider did not include prompt in response: ${streamedText}`);

let reasoningChunk = null;
let usageChunk = null;

for await (const chunk of provider.streamChat([createMessage('user', 'think')], { thinkingLevel: 'high' })) {
    if (typeof chunk === 'object' && chunk.type === 'usage')
        usageChunk = chunk;

    if (typeof chunk === 'object' && chunk.type === 'reasoning') {
        reasoningChunk = chunk;
        break;
    }
}

if (usageChunk?.usage?.reasoningTokens <= 0)
    throw new Error('Mock provider did not emit reasoning token usage');

if (!reasoningChunk?.text.includes('high'))
    throw new Error('Mock provider did not emit a reasoning chunk for explicit thinking');

const cancellable = new Gio.Cancellable();
let cancelledChunks = 0;

for await (const _chunk of provider.streamChat([createMessage('user', 'cancel me')], { cancellable })) {
    cancelledChunks++;
    cancellable.cancel();
}

if (cancelledChunks !== 1)
    throw new Error(`Mock provider did not stop after cancellation: ${cancelledChunks} chunks`);

print('Cusco mock provider smoke passed');
