import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { CONTEXT_COMPACTION_SUMMARY_KIND } from '../src/chat/compaction.js';
import { ConversationManager } from '../src/chat/conversation.js';
import { createMessage } from '../src/providers/provider.js';
import { ConversationFileStore } from '../src/storage/conversationStore.js';

const transientPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-transient-conversation-${GLib.uuid_string_random()}`,
    'conversations.json',
]);
const transientStore = new ConversationFileStore({ path: transientPath });
const transientConversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: transientStore,
});
const transientChat = transientConversations.createConversation();
transientConversations.renameConversation(transientChat.id, 'Still transient');
transientConversations.appendMessage(
    transientChat.id,
    createMessage('system', 'A system-only message must not save the chat'),
);
transientConversations.appendMessage(transientChat.id, createMessage('user', '   '));

if (GLib.file_test(transientPath, GLib.FileTest.EXISTS))
    throw new Error('A transient chat wrote the conversation database before user input');

transientConversations.persist();

const emptyReload = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: transientStore,
});

if (emptyReload.conversations.length !== 0)
    throw new Error('An ordinary chat without non-empty user input was persisted');

transientConversations.appendMessage(
    transientChat.id,
    createMessage('user', '', {
        attachments: [{ kind: 'file', path: '/tmp/input.txt' }],
    }),
);

const materializedReload = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: transientStore,
});

if (materializedReload.activeConversation?.id !== transientChat.id
    || materializedReload.activeConversation.messages.at(-1)?.attachments.length !== 1) {
    throw new Error('The first non-empty user input did not persist its transient chat');
}

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
conversations.setWorkingDirectory(chat.id, '/tmp/cusco-working-directory');
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

if (reloadedChat.workingDirectory !== '/tmp/cusco-working-directory')
    throw new Error('Persisted working directory was not loaded');

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

const chatOnlyPage = reloaded.conversationPage('', { conversationType: 'chat', limit: 50 });
const automationOnlyPage = reloaded.conversationPage('', { conversationType: 'cron', limit: 50 });

if (chatOnlyPage.conversations.some((conversation) => conversation.conversationType === 'cron')
    || automationOnlyPage.conversations.length !== 1
    || automationOnlyPage.conversations[0].id !== cronChat.id
    || reloaded.conversationPosition(cronChat.id, { conversationType: 'cron' }) !== 0) {
    throw new Error('Conversation paging did not separate chats from automations');
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
selectionConversations.appendMessage(selectedChat.id, createMessage('user', 'Selected chat message'));
const otherChat = selectionConversations.createConversation({ title: 'Other chat' });
selectionConversations.appendMessage(otherChat.id, createMessage('user', 'Other chat message'));
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

let retryShouldFail = true;
const retryManager = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: {
        supportsLazyLoading: true,
        load: () => ({
            conversations: [{
                id: 'retry-chat',
                title: 'Retry chat',
                providerId: 'openai',
                modelId: 'gpt-5.5',
                messageCount: 1,
                archived: false,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            }],
            activeConversationId: 'retry-chat',
        }),
        loadConversation: () => {
            if (retryShouldFail)
                throw new Error('Temporary transcript read failure');

            return {
                messages: [{ role: 'assistant', content: 'Recovered transcript' }],
            };
        },
        saveConversation: () => {},
        saveIndex: () => {},
    },
});

if (retryManager.activeConversation.messages.length !== 0
    || !retryManager.conversationLoadError('retry-chat')) {
    throw new Error('Lazy transcript failure was not exposed for retry');
}

retryShouldFail = false;
const retriedConversation = retryManager.retryConversationLoad('retry-chat');

if (retriedConversation?.messages[0]?.content !== 'Recovered transcript'
    || retryManager.conversationLoadError('retry-chat')
    || !retryManager.isConversationHydrated('retry-chat')) {
    throw new Error('Lazy transcript retry did not restore the conversation');
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

async function checkDamagedPendingMarkers(mode) {
    const recoveryPath = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `cusco-pending-marker-${mode}-${GLib.uuid_string_random()}`,
        'conversations.json',
    ]);
    const seedStore = new ConversationFileStore({ path: recoveryPath });
    seedStore.save({ conversations: [], activeConversationId: null });
    const staleDatabase = seedStore.load();
    const damagedContents = ['', '{"version":1,', '{}', '{"conversationId":42}',
        '{"conversationId":"another-chat"}'];
    const expectedConversations = damagedContents.map((contents, index) => {
        const conversation = {
            id: `recover-${index}`,
            title: `Recovered marker ${index}`,
            messages: [createMessage('user', `Preserved transcript ${index}`)],
        };

        // The first record has an outdated index entry; the rest were saved
        // just before an interruption and have not reached the index yet.
        if (index === 0) {
            staleDatabase.conversations.push(seedStore.saveConversation({
                ...conversation,
                title: 'Outdated title',
            }));
            seedStore.saveIndex(staleDatabase);
        }

        seedStore.saveConversation(conversation);
        GLib.file_set_contents(seedStore._pendingMarkerPath(conversation.id), contents);
        return conversation;
    });
    const orphanPath = seedStore._pendingMarkerPath('missing-transcript');
    GLib.file_set_contents(orphanPath, '');
    const mismatchedPath = seedStore._pendingMarkerPath('mismatched-transcript');
    GLib.file_set_contents(mismatchedPath, '{');
    const mismatchedRecordPath = seedStore._conversationRecordPath('mismatched-transcript');
    const mismatchedRecord = JSON.stringify({ conversation: expectedConversations[0] });
    GLib.file_set_contents(mismatchedRecordPath, mismatchedRecord);
    const damagedRecordMarkerPath = seedStore._pendingMarkerPath('damaged-transcript');
    const damagedRecordPath = seedStore._conversationRecordPath('damaged-transcript');
    GLib.file_set_contents(damagedRecordMarkerPath, '{');
    GLib.file_set_contents(damagedRecordPath, '{');
    const temporaryPath = GLib.build_filenamev([
        seedStore.pendingIndexPath,
        `.${GLib.path_get_basename(orphanPath)}.interrupted.tmp`,
    ]);
    GLib.file_set_contents(temporaryPath, '{');

    // A fresh store must recover without relying on in-memory pending summaries.
    const recoveryStore = new ConversationFileStore({ path: recoveryPath });
    const markerErrors = [];
    const originalLogError = globalThis.logError;

    try {
        globalThis.logError = (error, message) => markerErrors.push({ error, message });

        if (mode === 'load')
            recoveryStore.load();
        else if (mode === 'sync')
            recoveryStore.saveIndex(staleDatabase);
        else
            await recoveryStore.saveIndexAsync(staleDatabase);

        const recovered = new ConversationFileStore({ path: recoveryPath }).load();

        if (recovered.conversations.length !== expectedConversations.length)
            throw new Error(`${mode}: Damaged markers lost unindexed conversations`);

        for (const expected of expectedConversations) {
            const summary = recovered.conversations.find((item) => item.id === expected.id);

            if (summary?.title !== expected.title
                || recoveryStore.loadConversation(expected.id).messages[0]?.content
                    !== expected.messages[0].content) {
                throw new Error(`${mode}: Damaged marker recovery lost conversation data`);
            }
        }

        const recoveryErrorCount = markerErrors.length;

        for (let attempt = 0; attempt < 3; attempt++) {
            recoveryStore.saveIndex(recovered);
            await recoveryStore.saveIndexAsync(recovered);

            if (recoveryStore.hasPendingIndexUpdates())
                throw new Error(`${mode}: Damaged markers remained pending after recovery`);
        }

        if (recoveryErrorCount !== damagedContents.length + 3
            || markerErrors.length !== recoveryErrorCount) {
            throw new Error(`${mode}: Damaged markers or temporary files caused repeated errors`);
        }

        const quarantine = Gio.File.new_for_path(`${recoveryStore.pendingIndexPath}.corrupt`);
        const quarantined = quarantine.enumerate_children(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME, Gio.FileQueryInfoFlags.NONE, null,
        );
        const quarantinedContents = new Map();

        try {
            let info;

            while ((info = quarantined.next_file(null)) !== null) {
                const [, bytes] = quarantine.get_child(info.get_name()).load_contents(null);
                quarantinedContents.set(info.get_name().split('.json.')[0],
                    new TextDecoder().decode(bytes));
            }
        } finally {
            quarantined.close(null);
        }

        if (quarantinedContents.size !== 3)
            throw new Error(`${mode}: Recovery quarantined the wrong number of markers`);

        for (const [markerPath, contents] of [
            [orphanPath, ''], [mismatchedPath, '{'], [damagedRecordMarkerPath, '{'],
        ]) {
            const digest = GLib.path_get_basename(markerPath).replace('.json', '');

            if (GLib.file_test(markerPath, GLib.FileTest.EXISTS)
                || quarantinedContents.get(digest) !== contents) {
                throw new Error(`${mode}: An unrecoverable marker was not preserved in quarantine`);
            }
        }

        const [, temporaryBytes] = GLib.file_get_contents(temporaryPath);
        const [, mismatchedBytes] = GLib.file_get_contents(mismatchedRecordPath);
        const [, damagedRecordBytes] = GLib.file_get_contents(damagedRecordPath);

        if (new TextDecoder().decode(temporaryBytes) !== '{'
            || new TextDecoder().decode(mismatchedBytes) !== mismatchedRecord
            || new TextDecoder().decode(damagedRecordBytes) !== '{') {
            throw new Error(`${mode}: Marker recovery changed a temporary file or transcript`);
        }
    } finally {
        globalThis.logError = originalLogError;
    }
}

for (const mode of ['load', 'sync', 'async'])
    await checkDamagedPendingMarkers(mode);

const cancelledStore = new ConversationFileStore({ path: GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-cancelled-conversation-${GLib.uuid_string_random()}`,
    'conversations.json',
]) });
const cancelledConversation = {
    id: 'cancelled-chat',
    title: 'Committed title',
    messages: [createMessage('user', 'Committed transcript')],
};
cancelledStore.save({ conversations: [cancelledConversation], activeConversationId: 'cancelled-chat' });
const cancellable = new Gio.Cancellable();
cancellable.cancel();

for (const operation of [
    () => cancelledStore.saveConversationAsync({ ...cancelledConversation, title: 'Cancelled title' },
        { cancellable }),
    () => cancelledStore.saveIndexAsync({ conversations: [], activeConversationId: null },
        { cancellable }),
    () => cancelledStore.saveActiveConversationIdAsync(null, { cancellable }),
]) {
    let cancelled = false;

    try {
        await operation();
    } catch (error) {
        cancelled = error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
    }

    if (!cancelled)
        throw new Error('An asynchronous write did not report cancellation');
}

if (GLib.file_test(cancelledStore._pendingMarkerPath(cancelledConversation.id), GLib.FileTest.EXISTS)
    || cancelledStore.load().activeConversationId !== cancelledConversation.id
    || cancelledStore.loadConversation(cancelledConversation.id).title !== cancelledConversation.title) {
    throw new Error('Cancelled asynchronous writes changed committed data or left a pending marker');
}

const asyncDatabasePath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-async-conversation-${GLib.uuid_string_random()}`,
    'conversations.json',
]);
const asyncStore = new ConversationFileStore({ path: asyncDatabasePath });
const asyncConversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: asyncStore,
});
const asyncChat = asyncConversations.createConversation();

asyncConversations.appendMessage(
    asyncChat.id,
    createMessage('user', 'Persist without blocking the send frame'),
    { persist: false },
);
const asyncPersistence = asyncConversations.persistConversationAsync(asyncChat.id);

if (GLib.file_test(asyncDatabasePath, GLib.FileTest.EXISTS))
    throw new Error('Asynchronous conversation persistence ran before yielding to the main loop');

if (!await asyncPersistence)
    throw new Error('Asynchronous conversation persistence reported a write failure');

const asyncReload = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: asyncStore,
});

if (asyncReload.activeConversation?.messages[0]?.content
    !== 'Persist without blocking the send frame') {
    throw new Error('Asynchronous conversation persistence did not save the transcript');
}

asyncConversations.appendMessage(
    asyncChat.id,
    createMessage('assistant', 'This write will be followed by deletion'),
    { persist: 'async' },
);
asyncConversations.deleteConversation(asyncChat.id);
await asyncConversations.persistAsync();

if (new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
    store: asyncStore,
}).allConversations.length !== 0) {
    throw new Error('An ordered asynchronous write resurrected a deleted conversation');
}

print('Cusco conversation store smoke passed');
