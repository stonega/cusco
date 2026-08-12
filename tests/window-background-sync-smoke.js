import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { CuscoWindow } from '../src/window.js';

const windowPrototype = CuscoWindow.prototype;

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

function createSendHarness({ sessionHookGate = null, promptAllowed = true } = {}) {
    const calls = [];
    const appendedMessages = [];
    const conversation = {
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
        async _streamAssistantResponse() {
            calls.push('provider-request');
            return {};
        },
        _finishActiveTurn() {
            calls.push('finish-turn');
        },
        _sendQueuedUserMessages: () => Promise.resolve(false),
        _handleQueuedUserMessageError() {},
    };

    return { harness, calls, appendedMessages };
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
const concurrentTurnHarness = {
    _activeTurnsByConversation: new Map(),
    _conversations: { activeConversation: newConversation },
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
    || !concurrentTurnHarness._isConversationBusy(newConversation.id)) {
    throw new Error('A running response prevented a new chat from sending immediately');
}

let resolveSessionHook;
const sessionHookGate = new Promise((resolve) => {
    resolveSessionHook = resolve;
});
const immediateSend = createSendHarness({ sessionHookGate });
const immediateSendPromise = windowPrototype._sendMessage.call(
    immediateSend.harness,
    'Show this immediately',
);

if (immediateSend.calls.join(',')
    !== 'begin-with-deferred-sidebar,show-provisional') {
    throw new Error('Sending did work before presenting a provisional user row');
}

await waitForLowPriorityMainLoopTurn();

if (!immediateSend.calls.includes('session-hooks')
    || immediateSend.calls.includes('persist-message')) {
    throw new Error('The provisional row did not remain visible during pre-send hooks');
}

resolveSessionHook();
await immediateSendPromise;

const provisionalIndex = immediateSend.calls.indexOf('show-provisional');
const persistIndex = immediateSend.calls.indexOf('persist-message');
const replacementIndex = immediateSend.calls.indexOf('show-committed');

if (provisionalIndex < 0
    || persistIndex <= provisionalIndex
    || replacementIndex <= persistIndex
    || immediateSend.appendedMessages.length !== 1) {
    throw new Error('An approved prompt was not promoted from provisional to durable UI state');
}

const blockedSend = createSendHarness({ promptAllowed: false });
await windowPrototype._sendMessage.call(blockedSend.harness, 'Block this prompt');

if (!blockedSend.calls.includes('remove-provisional')
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
