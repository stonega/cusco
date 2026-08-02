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

if (Gtk.init_check()) {
    const widgetHarness = {
        _isCronConversation() {
            return false;
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
    const menuButton = row.get_last_child();
    const container = new Gtk.Box();

    container.append(row);

    if (!menuButton.get_popover())
        throw new Error('Conversation row did not create its action popover');

    windowPrototype._clearConversationListRow.call(widgetHarness, container);

    if (container.get_first_child())
        throw new Error('Conversation list row cleanup left the row attached');

    if (menuButton.get_popover())
        throw new Error('Conversation list row cleanup retained its action popover');
}

print('Cusco window background sync smoke passed');
