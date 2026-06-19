import GLib from 'gi://GLib?version=2.0';

import { ConversationManager } from '../src/chat/conversation.js';
import { createMessage } from '../src/providers/provider.js';
import { ConversationSearchIndex } from '../src/searchProvider.js';
import { ConversationFileStore } from '../src/storage/conversationStore.js';

const path = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-search-provider-${GLib.uuid_string_random()}`,
    'conversations.json',
]);
const store = new ConversationFileStore({ path });
const conversations = new ConversationManager({
    providerId: 'mock',
    modelId: 'mock-balanced',
    store,
});
const conversation = conversations.createConversation({ title: 'Searchable chat' });
conversations.appendMessage(conversation.id, createMessage('user', 'Find this shell search result'));

const index = new ConversationSearchIndex(store);
const results = index.search(['shell', 'search']);

if (results[0] !== conversation.id)
    throw new Error('Shell search index did not return the matching conversation');

const metas = index.metas(results, ['shell', 'search']);

if (metas[0].name !== 'Searchable chat' || !metas[0].description.includes('shell search'))
    throw new Error('Shell search metadata was not generated');

print('Cusco search provider smoke passed');
