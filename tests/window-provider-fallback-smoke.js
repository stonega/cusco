import GLib from 'gi://GLib';

import { CuscoWindow } from '../src/window.js';
import { createOutputCapacityError } from '../src/providers/outputLimits.js';

function assertEqual(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function delay(milliseconds) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function createFallbackWindow(collectProviderResponse) {
    const calls = [];
    const updates = [];
    const window = {
        _collectProviderResponse: async (...args) => {
            calls.push(args[0]);
            return collectProviderResponse(...args);
        },
        _getProviderFallback() {
            return {
                provider: { id: 'fallback-provider' },
                model: { id: 'fallback-model' },
            };
        },
        _conversations: {
            updateProviderConfig(_conversationId, selection) {
                updates.push(selection);
            },
        },
        _isActiveConversationId() {
            return false;
        },
        _refreshConversationList() {},
    };

    return { window, calls, updates };
}

const conversation = {
    id: 'conversation-1',
    providerId: 'primary-provider',
    modelId: 'primary-model',
};
const primaryError = new Error('Primary stream disconnected');
const visibleChunks = [];
const interrupted = createFallbackWindow(async (providerId, _modelId, _messages, _cancellable, onChunk) => {
    if (providerId === 'primary-provider') {
        onChunk('partial', 'partial', { type: 'text', text: 'partial' });
        throw primaryError;
    }

    throw new Error('Fallback must not run after visible output');
});
let interruptedError = null;

try {
    await CuscoWindow.prototype._collectProviderResponseWithFallback.call(
        interrupted.window,
        conversation,
        [],
        null,
        (text) => visibleChunks.push(text),
    );
} catch (error) {
    interruptedError = error;
}

assertEqual(interruptedError, primaryError, 'Interrupted primary error');
assertEqual(interrupted.calls.join(','), 'primary-provider', 'No fallback after visible output');
assertEqual(interrupted.updates.length, 0, 'Provider selection stays unchanged after partial output');
assertEqual(visibleChunks.join(','), 'partial', 'Partial output is delivered once');

const preOutput = createFallbackWindow(async (providerId, _modelId, _messages, _cancellable, onChunk) => {
    if (providerId === 'primary-provider') {
        onChunk('', 'Connecting', { type: 'status', status: 'Connecting' });
        throw primaryError;
    }

    onChunk('fallback response', 'fallback response', { type: 'text', text: 'fallback response' });
    return 'fallback response';
});
const fallbackChunks = [];
const fallbackResponse = await CuscoWindow.prototype._collectProviderResponseWithFallback.call(
    preOutput.window,
    conversation,
    [],
    null,
    (text, _chunk, state) => {
        if (state.type === 'text')
            fallbackChunks.push(text);
    },
);

assertEqual(fallbackResponse, 'fallback response', 'Fallback response before visible output');
assertEqual(preOutput.calls.join(','), 'primary-provider,fallback-provider', 'Fallback request count');
assertEqual(preOutput.updates.length, 1, 'Fallback provider selection update');
assertEqual(fallbackChunks.join(','), 'fallback response', 'Fallback output delivery');

const capacityError = createOutputCapacityError('No response capacity remains.');
const capacityFailure = createFallbackWindow(async () => {
    throw capacityError;
});
let surfacedCapacityError = null;

try {
    await CuscoWindow.prototype._collectProviderResponseWithFallback.call(
        capacityFailure.window,
        conversation,
        [],
        null,
    );
} catch (error) {
    surfacedCapacityError = error;
}

assertEqual(surfacedCapacityError, capacityError, 'Capacity error is surfaced unchanged');
assertEqual(capacityFailure.calls.join(','), 'primary-provider', 'Capacity error bypasses provider fallback');
assertEqual(capacityFailure.updates.length, 0, 'Capacity error does not change provider selection');

const replacementStates = [];
const replacementWindow = {
    _providerConfigs: {
        createProvider() {
            return {
                async *streamChat() {
                    yield 'Draft ';
                    yield { type: 'reasoning', text: 'Initial reasoning' };
                    yield { type: 'reasoning', text: 'Corrected reasoning', replace: true };
                    yield { type: 'text', text: 'Final answer', replace: true };
                },
            };
        },
        resolve() {
            return {};
        },
    },
    _appSettings: {
        responseTimeoutSeconds: 5,
        thinkingLevel: 'off',
    },
    _conversations: { activeConversation: null },
    _resolveThinkingLevelForSelection() {
        return 'off';
    },
};
const replacementResponse = await CuscoWindow.prototype._collectProviderResponse.call(
    replacementWindow,
    'replacement-provider',
    'replacement-model',
    [],
    null,
    (_text, _chunk, state) => replacementStates.push(state),
    { returnState: true },
);

assertEqual(replacementResponse.text, 'Final answer', 'Authoritative text replacement collection');
assertEqual(
    replacementResponse.reasoning,
    'Corrected reasoning',
    'Authoritative reasoning replacement collection',
);
assertEqual(
    replacementStates.at(-1).text,
    'Final answer',
    'Authoritative replacement callback state',
);

const streamedChunkCount = 1000;
const batchedSnapshots = [];
const batchingWindow = {
    ...replacementWindow,
    _providerConfigs: {
        ...replacementWindow._providerConfigs,
        createProvider() {
            return {
                async *streamChat() {
                    for (let index = 0; index < streamedChunkCount; index++)
                        yield 'x';
                },
            };
        },
    },
};
const batchedResponse = await CuscoWindow.prototype._collectProviderResponse.call(
    batchingWindow,
    'batching-provider',
    'batching-model',
    [],
    null,
    (text, _chunk, state) => {
        if (state.type === 'text')
            batchedSnapshots.push(text);
    },
);

assertEqual(batchedResponse.length, streamedChunkCount, 'Batched stream final response length');
assertEqual(
    batchedSnapshots.at(-1),
    batchedResponse,
    'Batched stream final callback snapshot',
);

if (batchedSnapshots.length >= streamedChunkCount)
    throw new Error('Stream collector materialized the full response for every provider chunk');

let secondChunkVisibleDuringPause = false;
let latestPausedSnapshot = '';
const pausedWindow = {
    ...replacementWindow,
    _providerConfigs: {
        ...replacementWindow._providerConfigs,
        createProvider() {
            return {
                async *streamChat() {
                    yield 'a';
                    yield 'b';
                    await delay(80);
                    secondChunkVisibleDuringPause = latestPausedSnapshot === 'ab';
                    yield 'c';
                },
            };
        },
    },
};

await CuscoWindow.prototype._collectProviderResponse.call(
    pausedWindow,
    'paused-provider',
    'paused-model',
    [],
    null,
    (text, _chunk, state) => {
        if (state.type === 'text')
            latestPausedSnapshot = text;
    },
);

assertEqual(
    secondChunkVisibleDuringPause,
    true,
    'Queued content flushes while the provider stream is paused',
);

print('Cusco window provider fallback smoke passed');
