import GLib from 'gi://GLib?version=2.0';

import { CONTEXT_COMPACTION_SUMMARY_KIND } from '../src/chat/compaction.js';
import { ConversationManager } from '../src/chat/conversation.js';
import { createMessage } from '../src/providers/provider.js';
import { ConversationFileStore } from '../src/storage/conversationStore.js';

const path = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-conversation-store-${GLib.uuid_string_random()}`,
    'conversations.json',
]);
const store = new ConversationFileStore({ path });
const conversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    thinkingLevel: 'auto',
    store,
});
const chat = conversations.createConversation();

conversations.appendMessage(chat.id, createMessage('user', 'Persist this chat'));
const assistantMessage = createMessage('assistant', 'Stored answer', {
    artifacts: [{
        id: 'artifact-1',
        kind: 'svg',
        title: 'Stored SVG',
        mimeType: 'image/svg+xml',
        path: '/tmp/stored.svg',
        sourceBlockIndex: 0,
        sourceLanguage: 'svg',
        generatedBy: 'assistant',
    }, {
        artifactId: 'managed-artifact-1',
        revisionId: 'managed-revision-1',
        kind: 'html',
        title: 'Managed site',
        mimeType: 'text/html',
        format: 'html',
        preferredPresentation: 'panel',
        sourceBlockIndex: -1,
    }],
    reasoning: {
        content: 'Stored reasoning summary',
        providerId: 'openai',
        modelId: 'gpt-5.5',
        thinkingLevel: 'high',
    },
    usage: {
        inputTokens: 10,
        outputTokens: 8,
        reasoningTokens: 4,
        totalTokens: 18,
        providerId: 'openai',
        modelId: 'gpt-5.5',
        thinkingLevel: 'high',
    },
});
conversations.appendMessage(chat.id, assistantMessage);
conversations.updateMessageMetadata(chat.id, assistantMessage.id, {
    agentRunDurationMs: 65000,
});
conversations.appendMessage(chat.id, createMessage('system', 'Calculator result', {
    toolCall: {
        name: 'calc',
        label: 'Calculator',
        input: '1+1',
        output: '2',
        status: 'running',
        artifacts: [{
            kind: 'html',
            path: '/tmp/tool.html',
            sourceBlockIndex: 0,
            sourceLanguage: 'html',
        }],
    },
}));
conversations.updateMessageToolCall(chat.id, chat.messages[2].id, {
    name: 'calc',
    label: 'Calculator',
    input: '1+1',
    output: '2',
    status: 'completed',
    artifacts: [{
        kind: 'html',
        path: '/tmp/tool.html',
        sourceBlockIndex: 0,
        sourceLanguage: 'html',
    }],
}, 'Calculator result\n\n1+1 = 2');
conversations.appendMessage(chat.id, createMessage('assistant', '', {
    reasoning: {
        content: 'Agent reasoning segment',
        providerId: 'openai',
        modelId: 'gpt-5.5',
        thinkingLevel: 'high',
        agentMode: true,
    },
}));
conversations.renameConversation(chat.id, 'Persistent chat');
conversations.setMemoryEnabled(chat.id, false);
conversations.setAgentModeEnabled(chat.id, true);
conversations.setThinkingLevel(chat.id, 'high');
conversations.setSkillIds(chat.id, ['review']);

const reloaded = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store,
});
const reloadedChat = reloaded.activeConversation;

if (reloadedChat.title !== 'Persistent chat')
    throw new Error(`Persisted chat title was not loaded: ${reloadedChat.title}`);

if (reloadedChat.messages[0].content !== 'Persist this chat')
    throw new Error('Persisted message was not loaded');

if (reloadedChat.messages[2].toolCall?.name !== 'calc')
    throw new Error('Persisted tool call metadata was not loaded');

if (reloadedChat.messages[2].toolCall?.status !== 'completed')
    throw new Error('Persisted tool call update was not loaded');

if (reloadedChat.messages[1].reasoning?.content !== 'Stored reasoning summary')
    throw new Error('Persisted reasoning metadata was not loaded');

if (reloadedChat.messages[1].artifacts[0]?.kind !== 'svg')
    throw new Error('Persisted message artifact metadata was not loaded');

if (reloadedChat.messages[1].artifacts[1]?.artifactId !== 'managed-artifact-1'
    || reloadedChat.messages[1].artifacts[1]?.revisionId !== 'managed-revision-1') {
    throw new Error('Managed artifact reference was not persisted');
}

if (reloadedChat.messages[2].toolCall?.artifacts?.[0]?.kind !== 'html')
    throw new Error('Persisted tool call artifact metadata was not loaded');

if (reloadedChat.messages[3].reasoning?.agentMode !== true)
    throw new Error('Persisted Agent Mode reasoning marker was not loaded');

if (reloadedChat.messages[1].usage?.reasoningTokens !== 4)
    throw new Error('Persisted usage metadata was not loaded');

if (reloadedChat.messages[1].metadata?.agentRunDurationMs !== 65000)
    throw new Error('Persisted Agent run duration metadata was not loaded');

if (reloadedChat.thinkingLevel !== 'high')
    throw new Error(`Persisted thinking level was not loaded: ${reloadedChat.thinkingLevel}`);

if (reloadedChat.memoryEnabled !== false)
    throw new Error('Persisted memory-enabled flag was not loaded');

if (reloadedChat.agentModeEnabled !== true)
    throw new Error('Persisted Agent Mode flag was not loaded');

if (reloadedChat.skillIds[0] !== 'review')
    throw new Error('Persisted skill selection was not loaded');

reloaded.archiveConversation(reloadedChat.id);

if (reloaded.conversations.length !== 0 || reloaded.archivedConversations.length !== 1)
    throw new Error('Archive state was not applied');

reloaded.archiveConversation(reloadedChat.id, false);

if (reloaded.searchConversations('persist').length !== 1)
    throw new Error('Conversation search did not find message content');

reloaded.replaceMessages(reloadedChat.id, [
    createMessage('system', 'Context compacted automatically.\n\nSummary', {
        metadata: {
            kind: CONTEXT_COMPACTION_SUMMARY_KIND,
            summary: 'Summary',
            tokensBefore: 120,
            tokensAfter: 30,
            messagesCompacted: 4,
        },
    }),
    createMessage('user', 'Recent request'),
]);

const reloadedCompacted = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store,
}).activeConversation;

if (reloadedCompacted.messages.length !== 2)
    throw new Error('Compacted transcript replacement was not persisted');

if (reloadedCompacted.messages[0].metadata?.kind !== CONTEXT_COMPACTION_SUMMARY_KIND
    || reloadedCompacted.messages[0].metadata?.tokensBefore !== 120) {
    throw new Error('Compaction summary metadata was not persisted');
}

const cronChat = reloaded.createConversation({
    title: 'Daily sync',
    conversationType: 'cron',
    cronJobId: 'job-123',
    messages: [
        createMessage('system', 'Cron run complete', {
            cronRun: {
                jobId: 'job-123',
                runId: 'run-1',
                exitStatus: 0,
            },
        }),
    ],
});

reloaded.setCronMetadata(cronChat.id, {
    conversationType: 'cron',
    cronJobId: 'job-456',
});

const reloadedCron = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store,
}).getConversation(cronChat.id);

if (reloadedCron.conversationType !== 'cron'
    || reloadedCron.cronJobId !== 'job-456'
    || reloadedCron.messages[0].cronRun?.runId !== 'run-1') {
    throw new Error('Cron conversation metadata was not persisted');
}

reloaded.deleteConversation(cronChat.id);
reloaded.deleteConversation(reloadedChat.id);

if (reloaded.allConversations.length !== 0)
    throw new Error('Conversation was not deleted');

const selectionDatabasePath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-conversation-selection-${GLib.uuid_string_random()}`,
    'conversations.json',
]);
const selectionFileStore = new ConversationFileStore({ path: selectionDatabasePath });
const selectionConversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: selectionFileStore,
});
const selectedChat = selectionConversations.createConversation({ title: 'Selected chat' });
selectionConversations.createConversation({ title: 'Other chat' });
const [, databaseBeforeSelection] = GLib.file_get_contents(selectionDatabasePath);
selectionConversations.selectConversation(selectedChat.id);
const [, databaseAfterSelection] = GLib.file_get_contents(selectionDatabasePath);

if (new TextDecoder().decode(databaseAfterSelection) !== new TextDecoder().decode(databaseBeforeSelection))
    throw new Error('Selecting a conversation rewrote the transcript database');

const reloadedSelection = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: selectionFileStore,
});

if (reloadedSelection.activeConversation?.id !== selectedChat.id)
    throw new Error('Lightweight active conversation state was not restored');

const migrationDatabasePath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-conversation-migration-${GLib.uuid_string_random()}`,
    'conversations.json',
]);
const migrationDirectory = GLib.path_get_dirname(migrationDatabasePath);
const migrationFirstId = 'legacy-first';
const migrationSecondId = 'legacy-second';
GLib.mkdir_with_parents(migrationDirectory, 0o700);
GLib.file_set_contents(migrationDatabasePath, `${JSON.stringify({
    version: 1,
    activeConversationId: migrationFirstId,
    conversations: [{
        id: migrationFirstId,
        title: 'Legacy first',
        providerId: 'openai',
        modelId: 'gpt-5.5',
        messages: [{
            id: 'legacy-message-first',
            role: 'user',
            content: 'Unique migration needle',
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
    }, {
        id: migrationSecondId,
        title: 'Legacy second',
        providerId: 'openai',
        modelId: 'gpt-5.5',
        messages: [{
            id: 'legacy-message-second',
            role: 'assistant',
            content: 'Unrelated transcript',
        }],
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
    }],
})}\n`);

const migrationStore = new ConversationFileStore({ path: migrationDatabasePath });
const migratedDatabase = migrationStore.load();
const [, migratedIndexBytes] = GLib.file_get_contents(migrationDatabasePath);
const migratedIndex = JSON.parse(new TextDecoder().decode(migratedIndexBytes));

if (migratedIndex.version !== 2
    || migratedIndex.conversations.length !== 2
    || Object.hasOwn(migratedIndex.conversations[0], 'messages')) {
    throw new Error('Legacy conversation database did not migrate to a summary-only index');
}

if (Object.hasOwn(migratedDatabase.conversations[0], 'messages')
    || migrationStore.loadConversation(migrationFirstId).messages[0].content !== 'Unique migration needle') {
    throw new Error('Migrated transcripts were not split into per-conversation records');
}

let transcriptLoadCount = 0;
const loadMigratedConversation = migrationStore.loadConversation.bind(migrationStore);
migrationStore.loadConversation = (conversationId) => {
    transcriptLoadCount += 1;
    return loadMigratedConversation(conversationId);
};
const lazyConversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: migrationStore,
});

if (transcriptLoadCount !== 0
    || lazyConversations.activeConversation?.id !== migrationFirstId
    || lazyConversations.conversations.map((conversation) => conversation.title).length !== 2
    || lazyConversations.isConversationHydrated(migrationFirstId)) {
    throw new Error('Conversation summaries hydrated transcripts during startup/list access');
}

const lazySearchResults = lazyConversations.searchConversations('migration needle');

if (lazySearchResults[0]?.id !== migrationFirstId
    || transcriptLoadCount !== 1
    || lazyConversations.isConversationHydrated(migrationFirstId)) {
    throw new Error('Indexed transcript search hydrated unrelated in-memory conversations');
}

if (lazyConversations.getConversation(migrationFirstId).messages[0].content !== 'Unique migration needle'
    || transcriptLoadCount !== 2
    || !lazyConversations.isConversationHydrated(migrationFirstId)) {
    throw new Error('Selecting transcript data did not hydrate exactly one conversation');
}

const savedConversationIds = [];
const saveMigratedConversation = migrationStore.saveConversation.bind(migrationStore);
migrationStore.saveConversation = (conversation, options) => {
    savedConversationIds.push(conversation.id);
    return saveMigratedConversation(conversation, options);
};
lazyConversations.renameConversation(migrationSecondId, 'Renamed without hydration');

if (savedConversationIds.join(',') !== migrationSecondId
    || lazyConversations.isConversationHydrated(migrationSecondId)
    || migrationStore.loadConversation(migrationSecondId).messages[0].content !== 'Unrelated transcript') {
    throw new Error('Metadata persistence rewrote or hydrated unrelated transcripts');
}

const [, lazyIndexBytes] = GLib.file_get_contents(migrationDatabasePath);
const lazyIndex = JSON.parse(new TextDecoder().decode(lazyIndexBytes));

if (lazyIndex.conversations.some((conversation) => Object.hasOwn(conversation, 'messages')))
    throw new Error('Conversation index retained eager transcript payloads');

const interruptedConversation = migrationStore.loadConversation(migrationFirstId);
interruptedConversation.title = 'Recovered interrupted update';
migrationStore.saveConversation(interruptedConversation);

const recoveredStore = new ConversationFileStore({ path: migrationDatabasePath });
const recoveredDatabase = recoveredStore.load();
const recoveredSummary = recoveredDatabase.conversations.find((conversation) => (
    conversation.id === migrationFirstId
));

if (recoveredSummary?.title !== 'Recovered interrupted update'
    || recoveredStore.hasPendingIndexUpdates()) {
    throw new Error('Interrupted transcript/index persistence did not reconcile on startup');
}

const pendingDeleteConversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: recoveredStore,
});
const pendingDeleteRecord = recoveredStore.loadConversation(migrationSecondId);
pendingDeleteRecord.title = 'Pending update that will be deleted';
recoveredStore.saveConversation(pendingDeleteRecord);
pendingDeleteConversations.deleteConversation(migrationSecondId);

const afterPendingDelete = new ConversationFileStore({ path: migrationDatabasePath }).load();

if (afterPendingDelete.conversations.some((conversation) => conversation.id === migrationSecondId)
    || recoveredStore.hasPendingIndexUpdates()) {
    throw new Error('Deleting a conversation resurrected a pending index update');
}

print('Cusco conversation store smoke passed');
