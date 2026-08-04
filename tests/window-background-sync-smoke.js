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
    _activeChatCancellable: runningCancellable,
    _activeTurnConversationId: runningConversation.id,
    _conversations: { activeConversation: newConversation },
    _isConversationBusy: windowPrototype._isConversationBusy,
};

if (!runtimeHarness._isConversationBusy(runningConversation.id)
    || runtimeHarness._isConversationBusy(newConversation.id)
    || windowPrototype._pendingConversationId.call(runtimeHarness) !== newConversation.id) {
    throw new Error('Running and queued state was not scoped to its owning conversation');
}

const runningView = { fingerprint: 'stale-after-stream-start' };
const cacheHarness = {
    ...runtimeHarness,
    _conversationViewCache: new Map([[runningConversation.id, runningView]]),
    _conversationViewFingerprint: () => 'current-stream-fingerprint',
};

if (windowPrototype._getCachedConversationView.call(cacheHarness, runningConversation) !== runningView) {
    throw new Error('A live conversation discarded its Working row and elapsed timer view');
}

cacheHarness._activeChatCancellable = null;

if (windowPrototype._getCachedConversationView.call(cacheHarness, runningConversation) !== null)
    throw new Error('A completed conversation reused a genuinely stale cached view');

const busyUiStates = [];
const renderHarness = {
    ...runtimeHarness,
    _migrateWelcomeConversation() {},
    _migrateLegacyArtifacts() {},
    _artifactWorkspace: null,
    _syncArtifactWorkspaceButton() {},
    _artifactSplitView: null,
    _syncProviderControls() {},
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
    _isConversationBusy: windowPrototype._isConversationBusy,
};

windowPrototype._renderActiveConversation.call(renderHarness);

if (busyUiStates.at(-1) !== false)
    throw new Error('A new chat inherited disabled model and provider controls from a running chat');

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
