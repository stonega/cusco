import { ConversationManager } from '../src/chat/conversation.js';
import { ProviderConfigStore } from '../src/providers/config.js';
import { createMessage } from '../src/providers/provider.js';
import { MemoryApiKeyStore } from '../src/secrets/apiKeyStore.js';

const providers = new ProviderConfigStore(undefined, {
    settings: null,
    apiKeyStore: new MemoryApiKeyStore({ zai: 'zai-key' }),
    envLookup: () => '',
});
providers.setProviderEnabled('zai', true);
const defaultProvider = providers.getDefaultProvider();
const defaultModel = providers.getDefaultModel(defaultProvider.id);
const conversations = new ConversationManager({
    providerId: defaultProvider.id,
    modelId: defaultModel.id,
});

const firstChat = conversations.createConversation();
conversations.appendMessage(firstChat.id, createMessage('user', 'Plan provider config and chat management'));

if (firstChat.title !== 'Plan provider config and chat management')
    throw new Error(`Conversation title was not derived from first message: ${firstChat.title}`);

const secondChat = conversations.createConversation({ title: 'Second chat' });
conversations.selectConversation(firstChat.id);

if (conversations.activeConversation.id !== firstChat.id)
    throw new Error('Conversation selection did not update the active chat');

let fullSaveCount = 0;
let selectionSaveCount = 0;
let usedNormalizedSave = false;
const selectionStore = {
    load: () => ({ conversations: [], activeConversationId: null }),
    save: (_database, options = {}) => {
        fullSaveCount += 1;
        usedNormalizedSave = options.normalized === true;
    },
    saveActiveConversationId: () => {
        selectionSaveCount += 1;
    },
};
const persistedSelectionConversations = new ConversationManager({
    providerId: defaultProvider.id,
    modelId: defaultModel.id,
    store: selectionStore,
});
const persistedFirstChat = persistedSelectionConversations.createConversation({ title: 'Persisted first chat' });
const persistedSecondChat = persistedSelectionConversations.createConversation({ title: 'Persisted second chat' });

fullSaveCount = 0;
persistedSelectionConversations.selectConversation(persistedFirstChat.id);

if (fullSaveCount !== 0 || selectionSaveCount !== 1)
    throw new Error('Conversation selection rewrote the full conversation database');

persistedSelectionConversations.selectConversation(persistedFirstChat.id);

if (selectionSaveCount !== 1)
    throw new Error('Selecting the active conversation persisted redundant state');

let failedStoreSaveCount = 0;
const failedStore = {
    load: () => {
        throw new Error('Unreadable fixture');
    },
    save: () => failedStoreSaveCount++,
    saveActiveConversationId: () => failedStoreSaveCount++,
};
const originalLogError = globalThis.logError;
let failedStoreConversations;

try {
    globalThis.logError = () => {};
    failedStoreConversations = new ConversationManager({
        providerId: defaultProvider.id,
        modelId: defaultModel.id,
        store: failedStore,
    });
} finally {
    globalThis.logError = originalLogError;
}

failedStoreConversations.createConversation({ title: 'In-memory recovery chat' });

if (!failedStoreConversations.storageError || failedStoreSaveCount !== 0)
    throw new Error('A failed database load allowed existing chat data to be overwritten');

persistedSelectionConversations.appendMessage(
    persistedSecondChat.id,
    createMessage('assistant', 'Deferred streaming update'),
    { persist: false },
);

if (fullSaveCount !== 0)
    throw new Error('Deferred conversation mutation persisted synchronously');

persistedSelectionConversations.persist();

if (fullSaveCount !== 1 || !usedNormalizedSave)
    throw new Error('Explicit conversation persistence did not use the normalized fast path');

conversations.updateProviderConfig(firstChat.id, {
    providerId: defaultProvider.id,
    modelId: 'glm-5-turbo',
});

if (firstChat.modelId !== 'glm-5-turbo')
    throw new Error(`Conversation model was not updated: ${firstChat.modelId}`);

conversations.setMemoryEnabled(firstChat.id, false);

if (firstChat.memoryEnabled !== false)
    throw new Error('Conversation memory flag was not updated');

conversations.setAgentModeEnabled(firstChat.id, true);

if (firstChat.agentModeEnabled !== true)
    throw new Error('Conversation Agent Mode flag was not updated');

conversations.setSkillIds(firstChat.id, ['review', 'writing']);

if (firstChat.skillIds.length !== 2 || firstChat.skillIds[0] !== 'review')
    throw new Error('Conversation skill selection was not updated');

if (conversations.conversations.length !== 2 || secondChat.title !== 'Second chat')
    throw new Error('Conversation list did not preserve created chats');

const firstMessageId = firstChat.messages[0].id;
conversations.updateMessageContent(firstChat.id, firstMessageId, 'Plan provider config, chat management, and persistence');

if (!firstChat.messages[0].content.includes('persistence'))
    throw new Error('Message content was not edited');

conversations.appendMessage(firstChat.id, createMessage('assistant', 'Working on it'));
conversations.truncateAfterMessage(firstChat.id, firstMessageId);

if (firstChat.messages.length !== 1)
    throw new Error('Conversation was not truncated after message');

const branch = conversations.branchFromMessage(firstChat.id, firstMessageId);

if (branch.messages.length !== 1 || branch.id === firstChat.id || branch.skillIds[1] !== 'writing' || !branch.agentModeEnabled)
    throw new Error('Conversation branch was not created from message');

conversations.archiveConversation(branch.id);

if (conversations.archivedConversations.length !== 1
    || conversations.conversations.some((conversation) => conversation.id === branch.id)) {
    throw new Error('Conversation was not archived');
}

conversations.archiveConversation(branch.id, false);

if (conversations.archivedConversations.length !== 0
    || !conversations.conversations.some((conversation) => conversation.id === branch.id)) {
    throw new Error('Conversation was not unarchived');
}

conversations.archiveConversation(branch.id);

conversations.deleteConversation(branch.id);

if (conversations.archivedConversations.length !== 0)
    throw new Error('Archived conversation was not deleted');

const archiveFallbackConversations = new ConversationManager({
    providerId: defaultProvider.id,
    modelId: defaultModel.id,
});
const visibleFallbackChat = archiveFallbackConversations.createConversation({ title: 'Visible chat' });
const archivedFallbackChat = archiveFallbackConversations.createConversation({ title: 'Archived chat' });
archiveFallbackConversations.archiveConversation(archivedFallbackChat.id);
archiveFallbackConversations.selectConversation(visibleFallbackChat.id);
archiveFallbackConversations.deleteConversation(visibleFallbackChat.id);

if (archiveFallbackConversations.activeConversation !== null)
    throw new Error('Deleting the last visible chat selected an archived chat');

const pagedConversations = new ConversationManager({
    providerId: defaultProvider.id,
    modelId: defaultModel.id,
});
let oldestPagedConversation = null;

for (let index = 0; index < 125; index += 1) {
    const conversation = pagedConversations.createConversation({ title: `Paged chat ${index}` });
    oldestPagedConversation ??= conversation;
}

const firstConversationPage = pagedConversations.conversationPage('', { limit: 50 });
const lastConversationPage = pagedConversations.conversationPage('', { offset: 100, limit: 50 });

if (firstConversationPage.conversations.length !== 50
    || !firstConversationPage.hasMore
    || lastConversationPage.conversations.length !== 25
    || lastConversationPage.hasMore
    || pagedConversations.conversationPosition(oldestPagedConversation.id) !== 124) {
    throw new Error('Conversation manager did not return bounded lazy sidebar pages');
}

const providerIds = providers.listProviders().map((provider) => provider.id);
const expectedProviderIds = ['openai', 'anthropic', 'gemini', 'kimi', 'deepseek', 'grok', 'zai'];

for (const providerId of expectedProviderIds) {
    if (!providerIds.includes(providerId))
        throw new Error(`Missing provider config: ${providerId}`);
}

const zaiProvider = providers.getProvider('zai');

if (zaiProvider.defaultModelId !== 'glm-5.2'
    || zaiProvider.models.map((model) => model.id).join(',') !== 'glm-5.2,glm-5-turbo')
    throw new Error('Z.ai GLM models were not configured');

const grokProvider = providers.getProvider('grok');

if (grokProvider.baseUrl !== 'https://api.x.ai/v1'
    || grokProvider.defaultModelId !== 'grok-4.5'
    || grokProvider.defaultImageModelId !== 'grok-imagine-image-quality'
    || grokProvider.models.map((model) => model.id).join(',') !== 'grok-4.5,grok-4.3'
    || grokProvider.imageModels.map((model) => model.id).join(',') !== 'grok-imagine-image-quality,grok-imagine-image')
    throw new Error('Grok models were not configured');

providers.setDefaultModel(defaultProvider.id, 'glm-5-turbo');

if (providers.getDefaultModel(defaultProvider.id).id !== 'glm-5-turbo')
    throw new Error('Provider default model was not updated');

print('Cusco chat management smoke passed');
