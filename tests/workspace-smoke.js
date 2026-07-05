import GLib from 'gi://GLib?version=2.0';

import { ConversationManager } from '../src/chat/conversation.js';
import { createMessage } from '../src/providers/provider.js';
import { ToolManager } from '../src/tools/tools.js';
import { conversationToMarkdown, conversationToPdf, exportConversation } from '../src/workspace/exports.js';
import { WorkspaceManager } from '../src/workspace/workspace.js';
import { WorkspaceFileStore } from '../src/storage/workspaceStore.js';

const path = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-workspace-${GLib.uuid_string_random()}`,
    'workspace.json',
]);
const workspace = new WorkspaceManager({
    store: new WorkspaceFileStore({ path }),
});
const prompt = workspace.createPrompt({
    title: 'Explain',
    content: 'Explain this clearly.',
    tags: ['writing'],
});
const profile = workspace.createProfile({
    name: 'Careful reviewer',
    systemPrompt: 'Review for correctness.',
});
const folder = workspace.createFolder({ name: 'Research' });
const pluginTool = workspace.registerPluginTool({
    name: 'echo',
    command: 'echo',
    enabled: true,
});
const mcpServer = workspace.addMcpServer({
    name: 'local-mcp',
    command: 'node',
    args: ['server.js'],
});

workspace.setCache('models:openai', ['gpt-5.5'], { ttlSeconds: 60 });

if (workspace.searchPrompts('clearly')[0].id !== prompt.id)
    throw new Error('Prompt library search failed');

if (!profile.id || !folder.id || !pluginTool.id || !mcpServer.id)
    throw new Error('Workspace records were not created');

if (workspace.getCache('models:openai')[0] !== 'gpt-5.5')
    throw new Error('Offline cache lookup failed');

const reloaded = new WorkspaceManager({
    store: new WorkspaceFileStore({ path }),
});

if (reloaded.prompts.length !== 1 || reloaded.pluginTools.length !== 1 || reloaded.mcpServers.length !== 1)
    throw new Error('Workspace data was not persisted');

const conversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
});
const conversation = conversations.createConversation({
    title: 'Exportable',
    folderId: folder.id,
    tags: ['research'],
    profileId: profile.id,
});
conversations.appendMessage(conversation.id, createMessage('user', 'Export this'));
conversations.updateWorkspaceMetadata(conversation.id, {
    folderId: folder.id,
    tags: 'research, export',
    profileId: profile.id,
});

if (!conversationToMarkdown(conversation).includes('# Exportable'))
    throw new Error('Markdown export failed');

if (!exportConversation(conversation, 'json').includes('"title": "Exportable"'))
    throw new Error('JSON export failed');

if (!conversationToPdf(conversation).startsWith('%PDF-1.4'))
    throw new Error('PDF export failed');

const tools = new ToolManager();
tools.registerTool({
    name: 'echo',
    label: 'Echo',
    requiresPermission: false,
    run: async (input) => input,
});
const result = await tools.runRequest(tools.parseRequest('/echo hello plugin'));

if (result.output !== 'hello plugin')
    throw new Error('Plugin tool extension did not run');

print('Cusco workspace smoke passed');
