import { ConversationManager } from '../src/chat/conversation.js';
import { ProviderConfigStore } from '../src/providers/config.js';
import { createMessage } from '../src/providers/provider.js';

const providers = new ProviderConfigStore(undefined, { settings: null });
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

conversations.updateProviderConfig(firstChat.id, {
    providerId: defaultProvider.id,
    modelId: 'mock-fast',
});

if (firstChat.modelId !== 'mock-fast')
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

if (conversations.archivedConversations.length !== 1)
    throw new Error('Conversation was not archived');

conversations.deleteConversation(branch.id);

if (conversations.archivedConversations.length !== 0)
    throw new Error('Archived conversation was not deleted');

providers.setDefaultModel(defaultProvider.id, 'mock-fast');

if (providers.getDefaultModel(defaultProvider.id).id !== 'mock-fast')
    throw new Error('Provider default model was not updated');

const providerIds = providers.listProviders().map((provider) => provider.id);
const expectedProviderIds = ['openai', 'anthropic', 'gemini', 'kimi', 'deepseek', 'zai'];

for (const providerId of expectedProviderIds) {
    if (!providerIds.includes(providerId))
        throw new Error(`Missing provider config: ${providerId}`);
}

const zaiProvider = providers.getProvider('zai');

if (zaiProvider.defaultModelId !== 'glm-5.2' || !zaiProvider.models.some((model) => model.id === 'glm-4.5-flash'))
    throw new Error('Z.ai GLM models were not configured');

print('Cusco chat management smoke passed');
