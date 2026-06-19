import GLib from 'gi://GLib?version=2.0';

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
    providerId: 'mock',
    modelId: 'mock-balanced',
    store,
});
const chat = conversations.createConversation();

conversations.appendMessage(chat.id, createMessage('user', 'Persist this chat'));
conversations.appendMessage(chat.id, createMessage('system', 'Calculator result', {
    toolCall: {
        name: 'calc',
        label: 'Calculator',
        input: '1+1',
        output: '2',
    },
}));
conversations.renameConversation(chat.id, 'Persistent chat');
conversations.setMemoryEnabled(chat.id, false);
conversations.setSkillIds(chat.id, ['review']);

const reloaded = new ConversationManager({
    providerId: 'mock',
    modelId: 'mock-balanced',
    store,
});
const reloadedChat = reloaded.activeConversation;

if (reloadedChat.title !== 'Persistent chat')
    throw new Error(`Persisted chat title was not loaded: ${reloadedChat.title}`);

if (reloadedChat.messages[0].content !== 'Persist this chat')
    throw new Error('Persisted message was not loaded');

if (reloadedChat.messages[1].toolCall?.name !== 'calc')
    throw new Error('Persisted tool call metadata was not loaded');

if (reloadedChat.memoryEnabled !== false)
    throw new Error('Persisted memory-enabled flag was not loaded');

if (reloadedChat.skillIds[0] !== 'review')
    throw new Error('Persisted skill selection was not loaded');

reloaded.archiveConversation(reloadedChat.id);

if (reloaded.conversations.length !== 0 || reloaded.archivedConversations.length !== 1)
    throw new Error('Archive state was not applied');

reloaded.archiveConversation(reloadedChat.id, false);

if (reloaded.searchConversations('persist').length !== 1)
    throw new Error('Conversation search did not find message content');

reloaded.deleteConversation(reloadedChat.id);

if (reloaded.allConversations.length !== 0)
    throw new Error('Conversation was not deleted');

print('Cusco conversation store smoke passed');
