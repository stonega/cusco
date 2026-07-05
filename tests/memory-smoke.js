import GLib from 'gi://GLib?version=2.0';

import { ConversationManager } from '../src/chat/conversation.js';
import { MemoryManager } from '../src/memory/memory.js';
import { createMessage } from '../src/providers/provider.js';
import { MemoryFileStore } from '../src/storage/memoryStore.js';

const path = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-memory-store-${GLib.uuid_string_random()}`,
    'memories.json',
]);
const memories = new MemoryManager({
    store: new MemoryFileStore({ path }),
});
const conversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
});
const conversation = conversations.createConversation();
const userMessage = createMessage('user', 'Remember that I prefer concise answers.');
const proposal = memories.createProposalFromMessage(userMessage, conversation);

if (!proposal || !proposal.content.includes('prefer concise answers'))
    throw new Error(`Memory proposal was not created: ${proposal?.content}`);

const memory = memories.addMemory(proposal);

if (memories.memories.length !== 1)
    throw new Error('Approved memory was not stored');

memories.updateMemory(memory.id, {
    pinned: true,
    enabled: true,
    content: 'The user prefers concise answers.',
});

const contextMemories = memories.getMemoriesForConversation(conversation, {
    latestText: 'Please answer quickly.',
});

if (contextMemories[0].id !== memory.id)
    throw new Error('Pinned memory was not selected for chat context');

const auditEntries = memories.recordMemoryUse([memory.id], {
    conversationId: conversation.id,
    messageId: userMessage.id,
});

if (auditEntries.length !== 1 || memories.getAuditLog(memory.id).length !== 1)
    throw new Error('Memory audit entry was not recorded');

conversations.setMemoryEnabled(conversation.id, false);

if (memories.getMemoriesForConversation(conversation).length !== 0)
    throw new Error('Disabled per-chat memory still returned context memories');

const exported = memories.exportData();
const imported = new MemoryManager();
const result = imported.importData(exported);

if (result.importedMemories !== 1 || imported.searchMemories('concise').length !== 1)
    throw new Error('Memory import/export did not round-trip data');

imported.deleteMemory(imported.memories[0].id);

if (imported.memories.length !== 0)
    throw new Error('Memory was not deleted');

print('Cusco memory smoke passed');
