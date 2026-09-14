import GLib from 'gi://GLib?version=2.0';

import { CuscoWindow } from '../src/window.js';
import { AssistantStreamRunner } from '../src/chat/assistantStreamRunner.js';
import { TurnCoordinator } from '../src/chat/turnCoordinator.js';

const noop = () => {};
const IDLE_WAIT_MS = 11000;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function delay(milliseconds) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function createHarness(id, stream, active = false) {
    const conversation = { id, messages: [], agentModeEnabled: false };
    const sent = [];
    const withdrawn = [];
    const application = {
        send_notification: (notificationId) => sent.push(notificationId),
        withdraw_notification: (notificationId) => withdrawn.push(notificationId),
    };
    const window = {
        is_active: active,
        get_application: () => application,
        _appSettings: { responseTimeoutSeconds: 300 },
        _conversations: { activeConversation: conversation, getConversation: () => conversation },
        _providerConfigs: {
            createProvider: () => ({ streamChat: () => stream(harness) }),
            resolve: () => ({}),
        },
        _activeTurnEntryForCancellable: (cancellable) => turns.entryForCancellable(cancellable),
    };
    for (const name of [
        '_startLongResponseNotification', '_stopLongResponseNotification',
        '_shouldSendLongResponseNotification', '_collectProviderResponse',
    ]) {
        window[name] = (...args) => CuscoWindow.prototype[name].call(window, ...args);
    }
    const turns = new TurnCoordinator({
        computerUse: { finishTurn: noop },
        conversations: window._conversations,
        finishPrecedingAssistant: noop,
        refreshConversationList: noop,
        renderActiveConversation: noop,
        schedulePendingConversationSend: noop,
        setComposerBusy: noop,
        stopLongResponseNotification: window._stopLongResponseNotification,
    });
    const cancellable = turns.begin(id);
    const runtime = turns.turns.get(id);
    const harness = {
        window, turns, cancellable, runtime, conversation, sent, withdrawn,
        collect: (onChunk = null) => window._collectProviderResponse(
            'test-provider', 'test-model', [], cancellable, onChunk,
        ),
        assertClean() {
            assert(runtime.longResponseTimeoutId === 0, `${id}: left an inactivity timer running`);
            assert(!runtime.longResponseNotificationSent, `${id}: left a notification visible`);
            assert(sent.length === withdrawn.length, `${id}: did not withdraw every notification`);
        },
    };
    return harness;
}

async function healthyStream(type) {
    const harness = createHarness(`healthy-${type}`, async function* () {
        for (let i = 0; i < 40; i++) {
            yield { type, text: 'progress' };
            await delay(300);
        }
    });
    await harness.collect();
    assert(harness.sent.length === 0, `${type}: warned while provider updates were arriving`);
    harness.assertClean();
}

async function stalledStream(active, initialOutput = true) {
    const harness = createHarness(`stalled-${active}-${initialOutput}`, async function* ({ sent }) {
        if (initialOutput)
            yield 'Initial response';
        await delay(IDLE_WAIT_MS);
        assert(sent.length === (active ? 0 : 1), 'Idle warning did not respect window focus');
        yield 'Resumed response';
        // Keep the request open to verify withdrawal happens on activity, before completion.
        await delay(100);
        assert(harness.withdrawn.length === sent.length, 'Resumed output did not withdraw the warning');
        assert(harness.runtime.longResponseTimeoutId !== 0, 'Resumed output did not rearm inactivity tracking');
    }, active);
    await harness.collect();
    harness.assertClean();
}

async function cancelledStream() {
    const harness = createHarness('cancelled', async function* () {
        await delay(IDLE_WAIT_MS);
        yield 'Late output after cancellation';
    });
    const request = harness.collect();
    harness.turns.stop(harness.conversation.id);
    harness.assertClean();
    await request;
    assert(harness.sent.length === 0, 'Cancelled request sent a warning');
    harness.assertClean();
}

async function failedStream() {
    const failure = new Error('Provider failed');
    const harness = createHarness('failed', async function* () {
        yield 'Partial response';
        throw failure;
    });
    let caught = null;
    try {
        await harness.collect();
    } catch (error) {
        caught = error;
    }
    assert(caught === failure, 'Notification handling changed the provider error');
    harness.assertClean();
}

async function finishedTurn() {
    const harness = createHarness('finished', async function* () {});
    harness.window._startLongResponseNotification(harness.cancellable);
    harness.turns.finish(harness.cancellable);
    harness.assertClean();
    await delay(IDLE_WAIT_MS);
    assert(harness.sent.length === 0, 'Finished turn sent a stale warning');
}

async function nonProviderWait(phase) {
    const harness = createHarness(phase, async function* () { yield 'Response'; });
    harness.conversation.agentModeEnabled = phase === 'tool';
    const view = {
        set_loading: noop, set_status: noop, set_stream_text: noop,
        set_label: noop, set_artifacts: noop, persist: noop, finish_working: noop,
    };
    const waitOutsideProvider = async () => {
        assert(harness.runtime.longResponseTimeoutId === 0, `${phase}: armed a provider timer`);
        await delay(IDLE_WAIT_MS);
        assert(harness.sent.length === 0, `${phase}: sent a provider inactivity warning`);
    };
    const runner = new AssistantStreamRunner({
        appSettings: harness.window._appSettings,
        conversations: harness.window._conversations,
        hooks: { dispatch: async () => ({ shouldContinue: false }) },
        mcp: { refreshTools: async () => {} },
        tools: {},
        applyHookResult: noop,
        buildProviderMessages: () => [],
        collectProviderResponseWithFallback: (_conversation, _messages, _cancellable, onChunk) => (
            harness.collect(onChunk)
        ),
        createStreamingAssistantView: () => view,
        ensureTurnSessionHooks: async () => {
            if (phase === 'setup')
                await waitOutsideProvider();
            return true;
        },
        injectMemoryContext: noop,
        injectSkillContext: () => [],
        isActiveConversationId: () => false,
        materializeAssistantArtifacts: () => [],
        maybeAutoCompactConversation: async () => false,
        refreshConversationList: noop,
        runAgentModeResponse: async () => {
            await harness.collect();
            await waitOutsideProvider();
            return await harness.collect();
        },
        scheduleUsageDisplayUpdate: noop,
        scrollToBottom: noop,
        turnHookContext: () => ({}),
    });
    await runner._streamAssistantResponse(harness.conversation.id, {
        cancellable: harness.cancellable,
    });
    harness.assertClean();
}

// Exercise the real 10-second GLib timers in parallel; no notifications reach the desktop.
await Promise.all([
    healthyStream('text'),
    healthyStream('reasoning'),
    healthyStream('status'),
    stalledStream(false),
    stalledStream(false, false),
    stalledStream(true),
    cancelledStream(),
    failedStream(),
    finishedTurn(),
    nonProviderWait('setup'),
    nonProviderWait('tool'),
]);

print('Cusco long-response notification smoke passed');
