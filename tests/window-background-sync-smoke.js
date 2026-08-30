import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { CuscoWindow } from '../src/window.js';
import { createAgentWorkingRow } from '../src/chat/agentActivityPresenter.js';
import { AssistantStreamRunner } from '../src/chat/assistantStreamRunner.js';
import { MessagePresenter } from '../src/chat/messagePresenter.js';
import { AnimatedMessageActions } from '../src/chat/streamAnimation.js';
import { createStreamingAssistantView } from '../src/chat/streamingAssistantView.js';

const windowPrototype = CuscoWindow.prototype;

const runFooterConversation = {
    id: 'run-footer-handoff',
    agentModeEnabled: true,
    providerId: 'test-provider',
    modelId: 'test-model',
    thinkingLevel: 'medium',
};
const runFooterMessages = [];
const runFooterViewCalls = [];
const runFooterView = createStreamingAssistantView({
    conversation: runFooterConversation,
    options: { workingStartedAt: 123 },
    conversations: {
        appendMessage(_conversationId, message) {
            runFooterMessages.push(message);
            return message;
        },
        updateMessageContent(_conversationId, messageId, content) {
            const message = runFooterMessages.find((candidate) => candidate.id === messageId);
            message.content = content;
            return message;
        },
        updateMessageMetadata(_conversationId, messageId, metadata) {
            const message = runFooterMessages.find((candidate) => candidate.id === messageId);
            message.metadata = metadata;
            return message;
        },
    },
    isActiveConversationId: () => true,
    addMessage: () => ({
        start_working(startedAt) {
            runFooterViewCalls.push(['start', startedAt]);
        },
        set_loading() {
            runFooterViewCalls.push(['loading']);
        },
        set_label(text) {
            runFooterViewCalls.push(['label', text]);
        },
        set_run_duration(durationMilliseconds) {
            runFooterViewCalls.push(['duration', durationMilliseconds]);
        },
        finish_working() {
            runFooterViewCalls.push(['finish']);
        },
    }),
});

runFooterView.set_loading();
runFooterView.set_stream_text('Final answer', 'Final answer');
runFooterView.set_run_duration(1540.4);
runFooterView.finish_working();

if (runFooterViewCalls.map(([kind]) => kind).join(',') !== 'start,loading,label,duration,finish'
    || runFooterViewCalls[0][1] !== 123
    || runFooterViewCalls[3][1] !== 1540
    || runFooterMessages[0]?.metadata?.agentRunDurationMs !== 1540) {
    throw new Error('Completed Agent run duration did not settle the live footer before cleanup');
}

const actionMessages = [];
let revealedActionMessage = null;
let actionRevealCallbackCount = 0;
let resolveActionPresentation;
let actionPresentationSettled = false;
const actionPresentationTail = new Promise((resolve) => {
    resolveActionPresentation = resolve;
});
const actionStreamingView = createStreamingAssistantView({
    conversation: {
        id: 'stream-actions',
        agentModeEnabled: false,
        providerId: 'test-provider',
        modelId: 'test-model',
        thinkingLevel: 'off',
    },
    conversations: {
        appendMessage(_conversationId, message) {
            actionMessages.push(message);
            return message;
        },
        updateMessageContent(_conversationId, messageId, content) {
            const message = actionMessages.find((candidate) => candidate.id === messageId);
            message.content = content;
            return message;
        },
    },
    isActiveConversationId: () => true,
    addMessage: () => ({
        set_label() {},
        finish_stream(options = {}) {
            options.onContentRevealed?.();
            return actionPresentationTail;
        },
        show_actions(message) {
            revealedActionMessage = message;
        },
    }),
});

actionStreamingView.set_stream_text('Complete answer', 'Complete answer');
const actionPresentation = actionStreamingView.finish_stream({
    onContentRevealed() {
        actionRevealCallbackCount += 1;
    },
});
actionPresentation.then(() => {
    actionPresentationSettled = true;
});
await Promise.resolve();

if (revealedActionMessage?.content !== 'Complete answer'
    || actionRevealCallbackCount !== 1
    || actionPresentationSettled) {
    throw new Error('Streamed message actions waited for the visual animation tail to settle');
}

resolveActionPresentation();
await actionPresentation;

function createSyncHarness({ status, ensured, logsAppended = false, activeConversation = null }) {
    const calls = {
        refresh: 0,
        render: 0,
        select: 0,
    };
    const harness = {
        _conversationSelectionSerial: 0,
        _cronJobIndex: new Map(),
        _conversations: {
            activeConversation,
            getConversation(conversationId) {
                return conversationId === activeConversation?.id ? activeConversation : null;
            },
            selectConversation() {
                calls.select += 1;
            },
        },
        _cron: {
            async getStatus() {
                return status;
            },
            async updateJob(_jobId, updates) {
                return { ...status.jobs[0], ...updates };
            },
        },
        _ensureCronConversation() {
            return ensured;
        },
        _appendCronRunLogs() {
            return logsAppended;
        },
        _refreshConversationList() {
            calls.refresh += 1;
        },
        _isCronConversation() {
            return false;
        },
        _renderActiveConversation() {
            calls.render += 1;
        },
    };

    return { harness, calls };
}

function createSendHarness({
    sessionHookGate = null,
    promptAllowed = true,
    presentationFinished = null,
} = {}) {
    const calls = [];
    const appendedMessages = [];
    const finishOptions = [];
    const conversation = {
        agentModeEnabled: true,
        id: 'send-chat',
        providerId: 'test-provider',
        modelId: 'test-model',
        messages: [],
    };
    const cancellable = new Gio.Cancellable();
    const harness = {
        _conversations: {
            activeConversation: conversation,
            appendMessage(conversationId, message) {
                calls.push('persist-message');
                appendedMessages.push({ conversationId, message });
                conversation.messages.push(message);
            },
        },
        _pendingAttachments: [],
        _composerDraftsByConversation: new Map(),
        _ensureConversationProviderAvailable: () => true,
        _beginActiveTurn(_conversationId, _cancellable, options) {
            calls.push(options?.refreshConversationList === false
                ? 'begin-with-deferred-sidebar'
                : 'begin-with-sidebar');
            return cancellable;
        },
        _formatUserMessageContent: (text) => text,
        _addMessage(_content, _role, message, options) {
            if (message?.id || options?.preserveLastAssistantMessageView !== true)
                throw new Error('The immediate user row was not provisional');

            calls.push('show-provisional');
            return {
                remove() {
                    calls.push('remove-provisional');
                },
                promote_user_message(nextMessage) {
                    if (!nextMessage?.id)
                        throw new Error('The provisional user row was promoted without a durable message');
                    calls.push('promote-provisional');
                },
            };
        },
        _createStreamingAssistantView() {
            calls.push('show-assistant-placeholder');
            return {
                remove() {
                    calls.push('remove-assistant-placeholder');
                },
                set_status(status) {
                    calls.push(`assistant-status:${status}`);
                },
            };
        },
        _isActiveConversationId: (conversationId) => conversationId === conversation.id,
        _syncEmptyConversationState() {},
        _scrollToBottom() {},
        _getComposerText: () => '',
        _updateAttachmentLabel() {},
        _applyComposerDraft() {
            calls.push('restore-draft');
        },
        focusComposer() {},
        _refreshConversationList() {
            calls.push('refresh-sidebar');
        },
        async _ensureTurnSessionHooks() {
            calls.push('session-hooks');
            if (sessionHookGate)
                await sessionHookGate;
            return true;
        },
        async _runUserPromptHooks() {
            calls.push('prompt-hooks');
            return promptAllowed;
        },
        _createAttachmentsForComposerReferences: () => [],
        _addMessageIfActiveConversation() {
            calls.push('show-committed');
        },
        _promptMemoryProposal() {},
        async _runRequestedTool() {
            calls.push('requested-tool');
            return null;
        },
        _drainPendingUserMessages() {},
        async _streamAssistantResponse(_conversationId, options = {}) {
            if (!options.assistantView || !Number.isFinite(options.responseStartedAt))
                throw new Error('The prepared assistant view was not handed to the stream runner');
            calls.push('provider-request');
            options.onPresentationSettling?.(presentationFinished);
            return { presentationFinished };
        },
        _finishActiveTurn(_cancellable, options = {}) {
            calls.push('finish-turn');
            finishOptions.push(options);
        },
        _sendQueuedUserMessages: () => Promise.resolve(false),
        _handleQueuedUserMessageError() {},
    };

    return { harness, calls, appendedMessages, finishOptions };
}

function waitForLowPriorityMainLoopTurn() {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_LOW, 0, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

const emptyStatus = { available: true, error: '', jobs: [] };
let test = createSyncHarness({
    status: emptyStatus,
    ensured: { conversation: null, changed: false },
});

await windowPrototype._syncCronJobsWithConversations.call(test.harness, { refreshUi: true });

if (test.calls.refresh !== 0)
    throw new Error('An unchanged empty cron poll rebuilt the conversation list');

const job = { id: 'job-1', conversationId: 'conversation-1' };
const conversation = {
    id: 'conversation-1',
    conversationType: 'cron',
    cronJobId: 'job-1',
};
const populatedStatus = { available: true, error: '', jobs: [job] };

test = createSyncHarness({
    status: populatedStatus,
    ensured: { conversation, changed: false },
    activeConversation: conversation,
});
await windowPrototype._syncCronJobsWithConversations.call(test.harness, { refreshUi: true });

if (test.calls.refresh !== 0)
    throw new Error('An unchanged cron job poll rebuilt the conversation list');

if (test.calls.select !== 0)
    throw new Error('An unchanged cron job poll rewrote the active conversation selection');

test = createSyncHarness({
    status: populatedStatus,
    ensured: { conversation, changed: false },
    logsAppended: true,
    activeConversation: conversation,
});
await windowPrototype._syncCronJobsWithConversations.call(test.harness, { refreshUi: true });

if (test.calls.refresh !== 1)
    throw new Error('A newly appended cron log did not refresh the conversation list');

if (test.calls.select !== 1)
    throw new Error('A cron log update did not restore the active conversation selection');

test = createSyncHarness({
    status: populatedStatus,
    ensured: { conversation, changed: true },
});
await windowPrototype._syncCronJobsWithConversations.call(test.harness, { refreshUi: true });

if (test.calls.refresh !== 1)
    throw new Error('A newly linked cron conversation did not refresh the conversation list');

const runningCancellable = {};
const runningConversation = { id: 'running-chat' };
const newConversation = { id: 'new-chat' };
const runtimeHarness = {
    _activeTurnsByConversation: new Map([[
        runningConversation.id,
        {
            cancellable: runningCancellable,
            turnId: 'running-turn',
            hookContexts: [],
        },
    ]]),
    _conversations: { activeConversation: newConversation },
    _isConversationBusy: windowPrototype._isConversationBusy,
};

if (!runtimeHarness._isConversationBusy(runningConversation.id)
    || runtimeHarness._isConversationBusy(newConversation.id)
    || windowPrototype._pendingConversationId.call(runtimeHarness) !== newConversation.id) {
    throw new Error('Running and queued state was not scoped to its owning conversation');
}

const firstTurnCancellable = {};
const secondTurnCancellable = {};
let precedingPresentationFlushes = 0;
const concurrentTurnHarness = {
    _activeTurnsByConversation: new Map(),
    _conversations: { activeConversation: newConversation },
    _lastAssistantMessageView: {
        finish_stream(options) {
            if (options?.flush)
                precedingPresentationFlushes += 1;
        },
    },
    _setComposerBusy() {},
    _refreshConversationList() {},
    _isConversationBusy: windowPrototype._isConversationBusy,
};

if (windowPrototype._beginActiveTurn.call(
    concurrentTurnHarness,
    runningConversation.id,
    firstTurnCancellable,
) !== firstTurnCancellable
    || windowPrototype._beginActiveTurn.call(
        concurrentTurnHarness,
        newConversation.id,
        secondTurnCancellable,
    ) !== secondTurnCancellable
    || !concurrentTurnHarness._isConversationBusy(runningConversation.id)
    || !concurrentTurnHarness._isConversationBusy(newConversation.id)
    || precedingPresentationFlushes !== 1) {
    throw new Error('A running response prevented a new chat from sending immediately');
}

let deferredFinishResolved = false;
let deferredFinishRenders = 0;
const deferredFinishCancellable = {};
const deferredFinishHarness = {
    _activeTurnsByConversation: new Map([[
        runningConversation.id,
        {
            cancellable: deferredFinishCancellable,
            resolveFinished() {
                deferredFinishResolved = true;
            },
        },
    ]]),
    _computerUse: { finishTurn() {} },
    _conversations: { activeConversation: runningConversation },
    _conversationStack: {},
    _activeTurnEntryForCancellable: windowPrototype._activeTurnEntryForCancellable,
    _isActiveConversationId: windowPrototype._isActiveConversationId,
    _isConversationBusy: windowPrototype._isConversationBusy,
    _setComposerBusy() {},
    _refreshConversationList() {},
    _renderActiveConversation() {
        deferredFinishRenders += 1;
    },
    _schedulePendingConversationSend() {},
};

windowPrototype._finishActiveTurn.call(
    deferredFinishHarness,
    deferredFinishCancellable,
    { deferActiveConversationRender: true },
);

if (deferredFinishHarness._activeTurnsByConversation.size !== 0
    || !deferredFinishResolved
    || deferredFinishRenders !== 0) {
    throw new Error('Visual tail pacing blocked turn cleanup or triggered an early transcript rebuild');
}

let borrowedTurnBusy = true;
let settledPresentation = null;
let settledPresentationRenders = 0;
let settledPresentationOptions = null;
const settledConversation = { id: 'settled-presentation', agentModeEnabled: false };
const settledAssistantView = {
    set_loading() {},
    set_stream_text() {},
    set_artifacts() {},
    persist() {},
    finish_stream: () => Promise.resolve(),
    finish_working() {},
};
const settledRunner = new AssistantStreamRunner({
    appSettings: {},
    conversations: { getConversation: () => settledConversation },
    hooks: { dispatch: async () => ({ shouldContinue: false }) },
    mcp: {},
    tools: {},
    appendHookNotice() {},
    applyHookResult() {},
    beginActiveTurn() {},
    buildProviderMessages: () => [],
    collectProviderResponseWithFallback: async () => 'Settled response',
    createStreamingAssistantView: () => settledAssistantView,
    ensureTurnSessionHooks: async () => true,
    finishActiveTurn() {},
    handleQueuedUserMessageError() {},
    injectMemoryContext() {},
    injectSkillContext: () => [],
    isActiveConversationId: () => true,
    isConversationBusy: () => borrowedTurnBusy,
    materializeAssistantArtifacts: () => [],
    maybeAutoCompactConversation: async () => null,
    refreshConversationList() {},
    renderActiveConversation(options) {
        settledPresentationRenders += 1;
        settledPresentationOptions = options;
    },
    runAgentModeResponse() {},
    scheduleUsageDisplayUpdate() {},
    scrollToBottom() {},
    sendQueuedUserMessages: async () => false,
    setFollowLatestMessage() {},
    startLongResponseNotification() {},
    stopLongResponseNotification() {},
    turnHookContext: () => ({}),
    updateUsageDisplay() {},
});
const settledResult = await settledRunner._streamAssistantResponse(settledConversation.id, {
    cancellable: new Gio.Cancellable(),
    onPresentationSettling: (promise) => {
        settledPresentation = promise;
    },
});

borrowedTurnBusy = false;
await waitForLowPriorityMainLoopTurn();

if (!settledPresentation
    || settledResult.presentationFinished !== settledPresentation
    || settledPresentationRenders !== 1
    || settledPresentationOptions?.finalizeCurrentView !== true
    || settledPresentationOptions?.incremental !== true
    || settledPresentationOptions?.forceRebuild) {
    throw new Error('A settled presentation did not finalize its live transcript view in place');
}

let resolveMcpRefresh;
let resolveConnectorRefresh;
const mcpRefreshGate = new Promise((resolve) => {
    resolveMcpRefresh = resolve;
});
const connectorRefreshGate = new Promise((resolve) => {
    resolveConnectorRefresh = resolve;
});
const agentPreflightCalls = [];
const agentPreflightConversation = {
    id: 'agent-preflight',
    agentModeEnabled: true,
    messages: [],
};
const agentPreflightView = {
    finish_stream: () => null,
    finish_working() {},
    persist() {},
    set_artifacts() {},
    set_run_duration() {},
    set_status(status) {
        agentPreflightCalls.push(`status:${status}`);
    },
    set_stream_text() {},
};
const agentPreflightRunner = new AssistantStreamRunner({
    appSettings: { responseTimeoutSeconds: 30 },
    connectors: {
        async refreshTools() {
            agentPreflightCalls.push('connector-refresh-start');
            await connectorRefreshGate;
        },
    },
    conversations: { getConversation: () => agentPreflightConversation },
    hooks: { dispatch: async () => ({ shouldContinue: false }) },
    mcp: {
        async refreshTools() {
            agentPreflightCalls.push('mcp-refresh-start');
            await mcpRefreshGate;
        },
    },
    tools: {},
    appendHookNotice() {},
    applyHookResult() {},
    beginActiveTurn() {},
    buildProviderMessages: () => [],
    collectProviderResponseWithFallback: async () => '',
    createStreamingAssistantView() {
        agentPreflightCalls.push('create-assistant-view');
        return agentPreflightView;
    },
    ensureTurnSessionHooks: async () => {
        agentPreflightCalls.push('session-hooks');
        return true;
    },
    finishActiveTurn() {},
    handleQueuedUserMessageError() {},
    injectMemoryContext() {},
    injectSkillContext: () => [],
    isActiveConversationId: () => true,
    isConversationBusy: () => true,
    materializeAssistantArtifacts: () => [],
    maybeAutoCompactConversation: async () => null,
    refreshConversationList() {},
    renderActiveConversation() {},
    runAgentModeResponse: async () => 'Agent response',
    scheduleUsageDisplayUpdate() {},
    scrollToBottom() {},
    sendQueuedUserMessages: async () => false,
    setFollowLatestMessage() {},
    startLongResponseNotification() {},
    stopLongResponseNotification() {},
    turnHookContext: () => ({}),
    updateUsageDisplay() {},
});
const agentPreflightPromise = agentPreflightRunner._streamAssistantResponse(
    agentPreflightConversation.id,
    { cancellable: new Gio.Cancellable() },
);

if (agentPreflightCalls[0] !== 'create-assistant-view'
    || agentPreflightCalls[1] !== 'status:Waiting for agent response...'
    || agentPreflightCalls.indexOf('status:Waiting for agent response...')
        > agentPreflightCalls.indexOf('session-hooks')) {
    throw new Error('Agent activity was not visible before response preflight work');
}

await waitForLowPriorityMainLoopTurn();

if (!agentPreflightCalls.includes('mcp-refresh-start')
    || !agentPreflightCalls.includes('connector-refresh-start')) {
    throw new Error('Agent tool sources were refreshed sequentially instead of concurrently');
}

resolveMcpRefresh();
resolveConnectorRefresh();
await agentPreflightPromise;

let resolveSessionHook;
const sessionHookGate = new Promise((resolve) => {
    resolveSessionHook = resolve;
});
const immediateSend = createSendHarness({ sessionHookGate });
const immediateSendPromise = windowPrototype._sendMessage.call(
    immediateSend.harness,
    'Show this immediately',
);

if (immediateSend.calls[0] !== 'show-provisional'
    || !immediateSend.calls.includes('show-assistant-placeholder')
    || !immediateSend.calls.includes('assistant-status:Waiting for agent response...')
    || immediateSend.calls.includes('session-hooks')
    || immediateSend.calls.includes('persist-message')) {
    throw new Error('Sending did not stage the user row and Agent activity before deferred work');
}

await waitForLowPriorityMainLoopTurn();

if (!immediateSend.calls.includes('session-hooks')
    || !immediateSend.calls.includes('show-provisional')
    || immediateSend.calls.includes('persist-message')) {
    throw new Error('The provisional row did not remain visible during pre-send hooks');
}

resolveSessionHook();
await immediateSendPromise;

const provisionalIndex = immediateSend.calls.indexOf('show-provisional');
const persistIndex = immediateSend.calls.indexOf('persist-message');
const promotionIndex = immediateSend.calls.indexOf('promote-provisional');

if (provisionalIndex < 0
    || persistIndex <= provisionalIndex
    || promotionIndex <= persistIndex
    || immediateSend.calls.includes('remove-provisional')
    || immediateSend.calls.includes('show-committed')
    || immediateSend.appendedMessages.length !== 1) {
    throw new Error('An approved prompt did not promote its optimistic row in place');
}

const presentationTail = new Promise(() => {});
const pacedSend = createSendHarness({ presentationFinished: presentationTail });
await windowPrototype._sendMessage.call(pacedSend.harness, 'Keep revealing this response');

if (pacedSend.finishOptions.at(-1)?.deferActiveConversationRender !== true) {
    throw new Error('A live presentation tail did not defer the transcript rebuild');
}

const blockedSend = createSendHarness({ promptAllowed: false });
await windowPrototype._sendMessage.call(blockedSend.harness, 'Block this prompt');

if (!blockedSend.calls.includes('remove-provisional')
    || !blockedSend.calls.includes('remove-assistant-placeholder')
    || !blockedSend.calls.includes('restore-draft')
    || blockedSend.calls.includes('persist-message')
    || blockedSend.appendedMessages.length !== 0) {
    throw new Error('A blocked prompt did not roll back its provisional user row and draft');
}

const scheduledConversationIds = [];
const pendingScheduleHarness = {
    _pendingConversationSendSourceId: 0,
    _pendingUserMessagesByConversation: new Map([
        ['queued-chat-1', [{}]],
        ['queued-chat-2', [{}]],
    ]),
    _conversations: {
        getConversation(conversationId) {
            return { id: conversationId };
        },
    },
    _isConversationBusy() {
        return false;
    },
    _sendQueuedUserMessages(conversationId) {
        scheduledConversationIds.push(conversationId);
        return Promise.resolve(true);
    },
    _handleQueuedUserMessageError() {},
};
windowPrototype._schedulePendingConversationSend.call(pendingScheduleHarness);
await new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_LOW, 0, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

if (scheduledConversationIds.join(',') !== 'queued-chat-1,queued-chat-2')
    throw new Error('Ready queued chats were not resumed independently');

const runningView = { fingerprint: 'stale-after-stream-start' };
const cacheHarness = {
    ...runtimeHarness,
    _conversationViewCache: new Map([[runningConversation.id, runningView]]),
    _conversationViewFingerprint: () => 'current-stream-fingerprint',
};

if (windowPrototype._getCachedConversationView.call(cacheHarness, runningConversation) !== runningView) {
    throw new Error('A live conversation discarded its Working row and elapsed timer view');
}

cacheHarness._activeTurnsByConversation.clear();

if (windowPrototype._getCachedConversationView.call(cacheHarness, runningConversation) !== null)
    throw new Error('A completed conversation reused a genuinely stale cached view');

const preferenceUpdates = [];
const activePreferenceView = {
    set_stream_preferences(preferences) {
        preferenceUpdates.push(['active', preferences]);
    },
};
const cachedPreferenceView = {
    set_stream_preferences(preferences) {
        preferenceUpdates.push(['cached', preferences]);
    },
};
const preferenceHarness = {
    _lastAssistantMessageView: activePreferenceView,
    _conversationViewCache: new Map([[
        'cached-chat',
        { lastAssistantMessageView: cachedPreferenceView },
    ]]),
    _streamPresentationPreferences: () => ({
        streamAnimationStyle: () => 'none',
        motionEnabled: () => false,
    }),
};

windowPrototype._refreshStreamPresentationPreferences.call(preferenceHarness);

if (preferenceUpdates.length !== 2
    || preferenceUpdates.some(([, preferences]) => preferences.motionEnabled() !== false)) {
    throw new Error('Motion preferences were not propagated to active and cached streams');
}

const busyUiStates = [];
const followLatestStates = [];
const renderHarness = {
    ...runtimeHarness,
    _renderedConversationId: 'previous-chat',
    _migrateWelcomeConversation() {},
    _migrateLegacyArtifacts() {},
    _artifactWorkspace: null,
    _syncArtifactWorkspaceButton() {},
    _artifactSplitView: null,
    _syncProviderControls() {},
    _syncAgentQuestionComposerMode() {},
    _setComposerBusy(isBusy) {
        busyUiStates.push(isBusy);
    },
    _getCachedConversationView: () => ({ conversationId: newConversation.id }),
    _cancelScheduledConversationRender() {},
    _captureCurrentConversationView() {},
    _renderPendingUserMessages() {},
    _syncEmptyConversationState() {},
    _touchConversationView() {},
    _activateConversationView() {},
    _updateUsageDisplay() {},
    _scrollToBottom() {},
    _setFollowLatestMessage(enabled) {
        followLatestStates.push(enabled);
    },
    _isConversationBusy: windowPrototype._isConversationBusy,
};

windowPrototype._renderActiveConversation.call(renderHarness);

if (busyUiStates.at(-1) !== false)
    throw new Error('A new chat inherited disabled model and provider controls from a running chat');

if (followLatestStates.at(-1) !== false)
    throw new Error('Switching chats retained another response\'s auto-follow state');

let composerText = 'draft for chat A';
const composerSelectionHarness = {
    _composerDraftsByConversation: new Map([['chat-b', {
        text: 'draft for chat B',
        references: [],
        attachments: [],
    }]]),
    _activeQuestionSessionsByConversation: new Map(),
    _pendingAttachments: [{ name: 'a.txt', path: '/tmp/a.txt' }],
    _composerReferences: [{ kind: 'file', value: '/tmp/a.txt' }],
    _conversations: {
        activeConversation: { id: 'chat-a' },
        selectConversation(conversationId) {
            this.activeConversation = { id: conversationId };
            return this.activeConversation;
        },
    },
    _getComposerText: () => composerText,
    _getComposerReferences() {
        return this._composerReferences;
    },
    _setComposerText(text) {
        composerText = text;
    },
    _updateAttachmentLabel() {},
    _setFollowLatestMessage() {},
    _setQuestionComposerMode() {},
    _activeQuestionSessionForConversation: windowPrototype._activeQuestionSessionForConversation,
    _deactivateAgentQuestionSessionUi: windowPrototype._deactivateAgentQuestionSessionUi,
    _composerDraftSnapshot: windowPrototype._composerDraftSnapshot,
    _captureComposerDraft: windowPrototype._captureComposerDraft,
    _prepareComposerForConversationChange: windowPrototype._prepareComposerForConversationChange,
    _applyComposerDraft: windowPrototype._applyComposerDraft,
};
windowPrototype._selectConversation.call(composerSelectionHarness, 'chat-b');

if (composerText !== 'draft for chat B'
    || composerSelectionHarness._composerDraftsByConversation.get('chat-a')?.text !== 'draft for chat A'
    || composerSelectionHarness._composerDraftsByConversation.get('chat-a')?.attachments?.length !== 1) {
    throw new Error('Conversation switching did not preserve independent composer drafts and attachments');
}

let resolveDeletedTurn;
let deletedConversation = false;
const deletionCancellable = new Gio.Cancellable();
const deletionHarness = {
    _conversationsPendingDeletion: new Set(),
    _pendingUserMessagesByConversation: new Map([['delete-chat', [{}]]]),
    _activeTurnsByConversation: new Map([['delete-chat', {
        cancellable: deletionCancellable,
        finished: new Promise((resolve) => {
            resolveDeletedTurn = resolve;
        }),
    }]]),
    _composerDraftsByConversation: new Map([['delete-chat', {}]]),
    _pendingArtifactPresentationsByConversation: new Map([['delete-chat', {}]]),
    _conversations: {
        activeConversation: { id: 'other-chat' },
        conversations: [{ id: 'other-chat' }],
        getConversation(conversationId) {
            return conversationId === 'delete-chat' && !deletedConversation
                ? { id: conversationId }
                : null;
        },
        deleteConversation() {
            deletedConversation = true;
        },
    },
    _finishAgentQuestions() {},
    _isActiveConversationId: windowPrototype._isActiveConversationId,
    _refreshConversationList() {},
    _renderActiveConversation() {},
};
const deletion = windowPrototype._deleteConversationAfterStopping.call(
    deletionHarness,
    'delete-chat',
);
await Promise.resolve();

if (!deletionCancellable.is_cancelled() || deletedConversation)
    throw new Error('Deleting a busy background chat did not wait for its turn cleanup');

resolveDeletedTurn();
await deletion;

if (!deletedConversation
    || deletionHarness._composerDraftsByConversation.has('delete-chat')
    || deletionHarness._pendingArtifactPresentationsByConversation.has('delete-chat')) {
    throw new Error('Deleting a stopped background chat left conversation-owned state behind');
}

const computerOwnerCancellable = new Gio.Cancellable();
const selectedChatCancellable = new Gio.Cancellable();
const computerStopHarness = {
    _activeTurnsByConversation: new Map([
        ['computer-chat', { cancellable: computerOwnerCancellable }],
        ['selected-chat', { cancellable: selectedChatCancellable }],
    ]),
    _computerUse: {
        activeTurnCancellable: computerOwnerCancellable,
        stop() {
            computerOwnerCancellable.cancel();
            return true;
        },
    },
    _activeTurnEntryForCancellable: windowPrototype._activeTurnEntryForCancellable,
    present() {},
    focusComposer() {},
    _showToast() {},
};
windowPrototype._stopComputerUseAndReturn.call(computerStopHarness);

if (!computerOwnerCancellable.is_cancelled() || selectedChatCancellable.is_cancelled())
    throw new Error('Emergency computer stop cancelled the selected unrelated chat');

if (Gtk.init_check()) {
    const liveWorkingRow = createAgentWorkingRow({
        startedAt: GLib.get_monotonic_time(),
        reducedMotionEnabled: true,
    });
    const liveWorkingLabel = liveWorkingRow.get_first_child();
    const liveElapsedLabel = liveWorkingLabel?.get_next_sibling();

    if (liveWorkingLabel?.get_text() !== 'Working…'
        || !liveWorkingRow.complete?.('Worked for 1m 05s')
        || liveWorkingLabel.get_text() !== 'Worked for 1m 05s'
        || liveElapsedLabel?.get_visible()) {
        throw new Error('The live Working footer did not complete in place');
    }

    liveWorkingRow.stop();

    if (liveWorkingLabel.get_text() !== 'Worked for 1m 05s')
        throw new Error('Stopping the completed Agent footer restored its live label');

    const completedWorkingRow = createAgentWorkingRow({
        completedLabel: 'Worked for 1m 05s',
        reducedMotionEnabled: true,
    });

    if (completedWorkingRow.get_first_child()?.get_text() !== liveWorkingLabel.get_text()
        || completedWorkingRow.get_first_child()?.get_next_sibling()?.get_visible()) {
        throw new Error('Canonical Agent duration did not use the same stable footer presentation');
    }

    completedWorkingRow.stop();

    const renderedMessages = new Gtk.Box();
    const presenterState = {
        _animatedWelcomeMessageIds: new Set(),
        _conversationLoadingView: null,
        _conversationStack: null,
        _emptyConversationFadeTimeoutId: 0,
        _emptyConversationPicture: null,
        _emptyConversationState: null,
        _emptyConversationThemeHandlerId: 0,
        _lastAssistantMessageView: null,
        _pendingAssistantActivityEntries: [],
        _userMessageReferenceContents: new Set(),
        _welcomeStreamSourceIds: new Set(),
    };
    let presenterStreamStyle = 'none';
    let presenterMotionEnabled = false;
    const messagePresenter = new MessagePresenter({
        appSettings: {
            codeTheme: 'Adwaita',
            reducedMotionEnabled: true,
        },
        artifacts: null,
        artifactRenderers: null,
        conversations: {},
        getParentWindow: () => null,
        getState: (name) => presenterState[name],
        setState: (name, value) => {
            presenterState[name] = value;
        },
        appendMessageWidget: (widget) => renderedMessages.append(widget),
        clearBox: (box) => {
            while (box.get_first_child())
                box.remove(box.get_first_child());
        },
        composerReferenceStyles: () => ({}),
        confirmOpenArtifactLink() {},
        createAttachmentPreviewCard: () => null,
        editMessage() {},
        exportArtifact() {},
        openArtifactWorkspace() {},
        openImageViewer() {},
        regenerateFromMessage() {},
        retryFromMessage() {},
        branchFromMessage() {},
        scrollToBottom() {},
        showToast() {},
        streamPresentationPreferences: () => ({
            motionEnabled: () => presenterMotionEnabled,
            streamAnimationStyle: () => presenterStreamStyle,
        }),
    });
    const emptyConversationState = messagePresenter._createEmptyConversationState();

    if (emptyConversationState.get_transition_duration() !== 200)
        throw new Error('The empty conversation artwork did not use a 200 ms transition');

    const completedMessageView = messagePresenter._addMessage(
        'Final answer',
        'assistant',
        {
            id: 'completed-run-footer',
            role: 'assistant',
            content: 'Final answer',
            metadata: { agentRunDurationMs: 65000 },
        },
    );
    const completedMessageWrapper = renderedMessages.get_first_child();
    const completedMessageBubble = completedMessageWrapper?.get_first_child();
    const completedMessageFooter = completedMessageBubble?.get_last_child();
    const completedMessageActions = completedMessageWrapper?.get_last_child();
    let actionDurationLabelFound = false;

    for (let child = completedMessageActions?.get_first_child(); child; child = child.get_next_sibling()) {
        if (child.has_css_class('cusco-message-run-duration'))
            actionDurationLabelFound = true;
    }

    if (completedMessageFooter?.get_parent() !== completedMessageBubble
        || !completedMessageFooter.has_css_class('cusco-agent-working')
        || completedMessageFooter.get_first_child()?.get_text() !== 'Worked for 1m 05s'
        || completedMessageFooter.get_first_child()?.get_next_sibling()?.get_visible()
        || actionDurationLabelFound) {
        throw new Error('Canonical Agent duration was not kept in the streaming footer position');
    }

    completedMessageView.remove();

    presenterStreamStyle = 'slideUp';
    presenterMotionEnabled = true;
    const inPlaceFinalizedView = messagePresenter._addMessage('', 'assistant');

    inPlaceFinalizedView.set_label('A **complete** streamed answer');
    inPlaceFinalizedView.set_stream_preferences({
        streamAnimationStyle: () => 'none',
        motionEnabled: () => false,
    });
    const inPlaceWrapper = renderedMessages.get_first_child();
    let inPlaceBubble = inPlaceWrapper?.get_first_child();

    while (inPlaceBubble && !inPlaceBubble.has_css_class('cusco-message-bubble'))
        inPlaceBubble = inPlaceBubble.get_next_sibling();

    const inPlaceBodyContent = inPlaceBubble?.get_first_child();
    const inPlaceMarkdownWidget = inPlaceBodyContent?.get_first_child();

    await inPlaceFinalizedView.finish_stream({ flush: true });

    if (!inPlaceMarkdownWidget
        || inPlaceBodyContent.get_first_child() !== inPlaceMarkdownWidget
        || inPlaceMarkdownWidget.get_selectable?.() !== true) {
        throw new Error('A complete streamed message rebuilt its Markdown widgets while finalizing');
    }

    inPlaceFinalizedView.remove();

    presenterStreamStyle = 'slideUp';
    presenterMotionEnabled = true;
    const streamingActionView = messagePresenter._addMessage('', 'assistant');

    streamingActionView.set_label('Completed streamed answer');
    streamingActionView.show_actions({
        id: 'streamed-action-motion',
        role: 'assistant',
        content: 'Completed streamed answer',
    });
    const streamingActionWrapper = renderedMessages.get_first_child();
    const streamingActions = streamingActionWrapper?.get_last_child();

    if (!(streamingActions instanceof AnimatedMessageActions)
        || streamingActions._animationStyle !== 'slideUp'
        || !streamingActions._entranceActive) {
        throw new Error('Live assistant actions did not inherit the selected stream motion');
    }

    streamingActionView.set_stream_preferences({
        streamAnimationStyle: () => 'blurIn',
        motionEnabled: () => false,
    });

    if (streamingActions._animationStyle !== 'blurIn'
        || streamingActions._entranceActive) {
        throw new Error('Reduced motion did not settle the live assistant actions immediately');
    }

    streamingActionView.remove();

    let busyConversationId = '';
    const widgetHarness = {
        _isCronConversation() {
            return false;
        },
        _isConversationBusy(conversationId) {
            return conversationId === busyConversationId;
        },
        _renameConversation() {},
        _archiveConversation() {},
        _exportConversation() {},
        _confirmDeleteConversation() {},
        _composerReferenceStyles() {
            return {};
        },
        _removePendingUserMessage() {},
        _createConversationMenuItem(...args) {
            return windowPrototype._createConversationMenuItem.call(this, ...args);
        },
        _createConversationMenuButton(...args) {
            return windowPrototype._createConversationMenuButton.call(this, ...args);
        },
        _clearBox(...args) {
            return windowPrototype._clearBox.call(this, ...args);
        },
    };
    const queuedCard = windowPrototype._createPendingUserMessageCard.call(widgetHarness, {
        id: 'queued-message',
        conversationId: 'conversation-1',
        content: 'First queued line\nSecond queued line',
        references: [],
    });
    const queuedLabel = queuedCard.get_first_child()?.get_next_sibling?.();

    if (queuedLabel?.get_lines() !== 1 || !queuedLabel.get_single_line_mode())
        throw new Error('Queued message previews were not limited to one UI line');

    const row = windowPrototype._createConversationRow.call(widgetHarness, {
        id: 'conversation-1',
        title: 'Conversation',
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
        conversationType: 'chat',
        cronJobId: '',
    });
    const actionsOverlay = row.get_last_child();
    const menuButton = actionsOverlay.get_child();
    const container = new Gtk.Box();

    container.append(row);

    if (!menuButton.get_popover())
        throw new Error('Conversation row did not create its action popover');

    windowPrototype._clearConversationListRow.call(widgetHarness, container);

    if (container.get_first_child())
        throw new Error('Conversation list row cleanup left the row attached');

    if (menuButton.get_popover())
        throw new Error('Conversation list row cleanup retained its action popover');

    busyConversationId = 'working-conversation';
    const workingRow = windowPrototype._createConversationRow.call(widgetHarness, {
        id: busyConversationId,
        title: 'Working conversation',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
        conversationType: 'chat',
        cronJobId: '',
    });
    const workingActionsOverlay = workingRow.get_last_child();
    const workingMenuButton = workingActionsOverlay.get_child();
    const activeDot = workingActionsOverlay.get_last_child();

    if (activeDot === workingMenuButton
        || !activeDot.has_css_class('cusco-conversation-active-dot')
        || !activeDot.get_visible()
        || workingMenuButton.get_opacity() !== 0) {
        throw new Error('Working chat did not show an active dot in the hidden menu position');
    }

    workingMenuButton._setConversationMenuVisible(true);

    if (activeDot.get_visible() || workingMenuButton.get_opacity() !== 1)
        throw new Error('Hovering a working chat did not replace its active dot with the menu button');

    workingMenuButton._setConversationMenuVisible(false);

    if (!activeDot.get_visible() || workingMenuButton.get_opacity() !== 0)
        throw new Error('Leaving a working chat did not restore its active dot');

    const workingContainer = new Gtk.Box();
    workingContainer.append(workingRow);
    windowPrototype._clearConversationListRow.call(widgetHarness, workingContainer);
}

print('Cusco window background sync smoke passed');
