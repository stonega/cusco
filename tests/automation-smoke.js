import Gtk from 'gi://Gtk?version=4.0';

import { ConversationManager } from '../src/chat/conversation.js';
import {
    ConversationSidebar,
    conversationListSplices,
} from '../src/chat/conversationSidebar.js';
import { CuscoWindow } from '../src/window.js';

const windowPrototype = CuscoWindow.prototype;
const job = {
    id: 'automation-1',
    title: 'Daily briefing',
    schedule: '0 9 * * *',
    prompt: 'Summarize today’s priorities.',
    enabled: true,
};
const conversation = {
    id: 'automation-conversation-1',
    conversationType: 'cron',
    cronJobId: job.id,
};

const insertedConversationSplices = conversationListSplices(
    ['chat-1', 'chat-2'],
    ['chat-new', 'chat-1', 'chat-2'],
);
const changedConversationSplices = conversationListSplices(
    ['chat-1', 'chat-2'],
    ['chat-1', 'chat-2'],
    new Set(['chat-2']),
);

if (insertedConversationSplices.length !== 1
    || insertedConversationSplices[0].position !== 0
    || insertedConversationSplices[0].removedCount !== 0
    || insertedConversationSplices[0].additions.join(',') !== 'chat-new'
    || changedConversationSplices.length !== 1
    || changedConversationSplices[0].position !== 1
    || changedConversationSplices[0].removedCount !== 1
    || changedConversationSplices[0].additions[0] !== 'chat-2') {
    throw new Error('Conversation sidebar refreshes did not produce minimal list-model splices');
}

function createHarness({ busy = false } = {}) {
    const calls = [];
    const harness = {
        _cronConversationSync: {
            async sync() {
                calls.push('sync');
                return { available: true, error: '', jobs: [job] };
            },
            ensureConversation(candidate) {
                calls.push(['ensure', candidate.id]);
                return { conversation, changed: false };
            },
        },
        _enqueuePendingUserMessage(prompt, references, conversationId) {
            calls.push(['queue', prompt, references.length, conversationId]);
            return { id: 'pending-1' };
        },
        _isConversationBusy() {
            return busy;
        },
        _schedulePendingConversationSend() {
            calls.push('schedule');
        },
        async _sendQueuedUserMessages(conversationId) {
            calls.push(['send', conversationId]);
            return true;
        },
    };

    return { calls, harness };
}

let test = createHarness();
let result = await windowPrototype._executeAutomation.call(test.harness, job.id);

if (result.queued
    || test.calls.find((call) => call[0] === 'queue')?.[1] !== job.prompt
    || !test.calls.some((call) => call[0] === 'send')) {
    throw new Error('Automation did not send its prompt through the conversation turn pipeline');
}

test = createHarness({ busy: true });
result = await windowPrototype._executeAutomation.call(test.harness, job.id, {
    waitForQueued: false,
});

if (!result.queued
    || !test.calls.includes('schedule')
    || test.calls.some((call) => call[0] === 'send')) {
    throw new Error('Busy automation conversations did not queue the scheduled prompt');
}

const pausedHarness = createHarness().harness;
pausedHarness._cronConversationSync.sync = async () => ({
    available: true,
    error: '',
    jobs: [{ ...job, enabled: false }],
});
let pausedRejected = false;

try {
    await windowPrototype._executeAutomation.call(pausedHarness, job.id);
} catch (error) {
    pausedRejected = error.userMessage?.includes('paused') ?? false;
}

if (!pausedRejected)
    throw new Error('Scheduled invocation accepted a paused automation');

if (Gtk.init_check()) {
    const conversations = new ConversationManager({
        providerId: 'test-provider',
        modelId: 'test-model',
    });
    const chat = conversations.createConversation({ title: 'Chat row' });
    const automation = conversations.createConversation({
        title: 'Automation row',
        conversationType: 'cron',
        cronJobId: job.id,
    });
    conversations.selectConversation(chat.id);
    const sidebar = new ConversationSidebar({
        conversations,
        getAutomationJob: () => job,
    });

    sidebar.refresh();

    if (sidebar.mode !== 'chats'
        || sidebar.chatsButton.get_label() !== 'Chat'
        || sidebar.automationsButton.get_label() !== 'Automations'
        || sidebar.listModel.get_n_items() !== 1
        || sidebar.listModel.get_string(0) !== chat.id) {
        throw new Error('Chat sidebar mode did not contain only chat conversations');
    }

    sidebar.setMode('automations', { selectConversation: false });

    if (sidebar.title.get_label() !== 'Automations'
        || sidebar.search.get_placeholder_text() !== 'Search automations'
        || sidebar.listModel.get_n_items() !== 1
        || sidebar.listModel.get_string(0) !== automation.id) {
        throw new Error('Automation sidebar mode did not contain only scheduled tasks');
    }

    sidebar.dispose();
}

print('Cusco automation smoke passed');
