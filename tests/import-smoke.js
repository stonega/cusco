import {
    APP_AUTHOR,
    APP_ID,
    APP_NAME,
    APP_VERSION,
} from '../src/appInfo.js';
import { APP_ID as APPLICATION_APP_ID, CuscoApplication } from '../src/application.js';
import { buildAgentModeSystemPrompt, parseAgentToolCall } from '../src/chat/agentMode.js';
import { ConversationManager } from '../src/chat/conversation.js';
import { markdownToPangoMarkup, parseMarkdownBlocks } from '../src/chat/markdown.js';
import { createMessageContent } from '../src/chat/messageView.js';
import { estimateConversationUsage } from '../src/chat/usage.js';
import { createCronCreateTool, CronJobManager } from '../src/cron/manager.js';
import { MemoryManager } from '../src/memory/memory.js';
import { defaultMcpConfigFilePath, parseMcpConfigFile } from '../src/mcp/config.js';
import { parseWwwAuthenticate, SecretServiceMcpTokenStore } from '../src/mcp/auth.js';
import { McpClient } from '../src/mcp/client.js';
import { McpManager } from '../src/mcp/manager.js';
import { ProviderConfigStore } from '../src/providers/config.js';
import { createImageGenerationTool, generateImageForProvider } from '../src/providers/imageGeneration.js';
import { createProviderIcon, getProviderGIcon } from '../src/providers/icons.js';
import {
    AnthropicMessagesProvider,
    GeminiGenerateContentProvider,
    OpenAiCompatibleChatProvider,
    OpenAiResponsesProvider,
} from '../src/providers/remoteProvider.js';
import { MemoryApiKeyStore, SecretServiceApiKeyStore } from '../src/secrets/apiKeyStore.js';
import { ConversationSearchIndex, installSearchProvider } from '../src/searchProvider.js';
import { createAppInfoSettingsPage } from '../src/settings/appInfoSettings.js';
import { AppSettingsStore, createApplicationSettingsPage } from '../src/settings/appSettings.js';
import { createMemorySettingsPage } from '../src/settings/memorySettings.js';
import { createMcpSettingsPage } from '../src/settings/mcpSettings.js';
import { createProviderSettingsPage, presentProviderSettingsDialog } from '../src/settings/providerSettings.js';
import { createSkillsSettingsPage, createWorkspaceSettingsPage } from '../src/settings/workspaceSettings.js';
import {
    buildSkillContext,
    discoverInstalledSkills,
    getAlwaysAvailableSkills,
    loadSkillFromPath,
} from '../src/skills/skills.js';
import { ConversationFileStore } from '../src/storage/conversationStore.js';
import { MemoryFileStore } from '../src/storage/memoryStore.js';
import { WorkspaceFileStore } from '../src/storage/workspaceStore.js';
import { createToolPermissionDecision } from '../src/tools/permissions.js';
import { ToolManager, calculateExpression, parseToolRequest } from '../src/tools/tools.js';
import { exportConversation } from '../src/workspace/exports.js';
import { extractPromptVariables, renderPromptTemplate } from '../src/workspace/promptVariables.js';
import { WorkspaceManager } from '../src/workspace/workspace.js';

if (APP_ID !== 'io.github.stonega.Cusco')
    throw new Error(`Unexpected application id: ${APP_ID}`);

if (APPLICATION_APP_ID !== APP_ID)
    throw new Error(`Unexpected application module id: ${APPLICATION_APP_ID}`);

if (APP_NAME !== 'Cusco' || APP_VERSION.length === 0 || APP_AUTHOR.length === 0)
    throw new Error('App info metadata did not import correctly');

if (typeof CuscoApplication !== 'function')
    throw new Error('CuscoApplication did not import as a class');

if (typeof ProviderConfigStore !== 'function')
    throw new Error('ProviderConfigStore did not import as a class');

if (typeof createImageGenerationTool !== 'function' || typeof generateImageForProvider !== 'function')
    throw new Error('Image generation helpers did not import as functions');

if (typeof getProviderGIcon !== 'function' || typeof createProviderIcon !== 'function')
    throw new Error('Provider icon helpers did not import as functions');

if (typeof ConversationManager !== 'function')
    throw new Error('ConversationManager did not import as a class');

if (typeof buildAgentModeSystemPrompt !== 'function' || typeof parseAgentToolCall !== 'function')
    throw new Error('Agent Mode helpers did not import');

if (typeof CronJobManager !== 'function' || typeof createCronCreateTool !== 'function')
    throw new Error('Cron manager helpers did not import');

if (typeof parseMarkdownBlocks !== 'function' || typeof markdownToPangoMarkup !== 'function')
    throw new Error('Markdown helpers did not import as functions');

if (typeof createMessageContent !== 'function')
    throw new Error('Message view helper did not import as a function');

if (typeof estimateConversationUsage !== 'function')
    throw new Error('Usage helper did not import as a function');

if (typeof ConversationFileStore !== 'function')
    throw new Error('ConversationFileStore did not import as a class');

if (typeof AppSettingsStore !== 'function')
    throw new Error('AppSettingsStore did not import as a class');

if (typeof MemoryManager !== 'function')
    throw new Error('MemoryManager did not import as a class');

if (typeof McpClient !== 'function'
    || typeof McpManager !== 'function'
    || typeof parseWwwAuthenticate !== 'function'
    || typeof SecretServiceMcpTokenStore !== 'function'
    || typeof parseMcpConfigFile !== 'function'
    || typeof defaultMcpConfigFilePath !== 'function')
    throw new Error('MCP helpers did not import');

if (typeof MemoryFileStore !== 'function')
    throw new Error('MemoryFileStore did not import as a class');

if (typeof ToolManager !== 'function' || typeof calculateExpression !== 'function' || typeof parseToolRequest !== 'function')
    throw new Error('Tool helpers did not import');

if (typeof createToolPermissionDecision !== 'function')
    throw new Error('Tool permission helpers did not import');

if (typeof buildSkillContext !== 'function'
    || typeof discoverInstalledSkills !== 'function'
    || typeof getAlwaysAvailableSkills !== 'function'
    || typeof loadSkillFromPath !== 'function')
    throw new Error('Skill helpers did not import');

if (typeof ConversationSearchIndex !== 'function' || typeof installSearchProvider !== 'function')
    throw new Error('Search provider helpers did not import');

if (typeof createApplicationSettingsPage !== 'function')
    throw new Error('createApplicationSettingsPage did not import as a function');

if (typeof createAppInfoSettingsPage !== 'function')
    throw new Error('createAppInfoSettingsPage did not import as a function');

if (typeof createMemorySettingsPage !== 'function')
    throw new Error('createMemorySettingsPage did not import as a function');

if (typeof createMcpSettingsPage !== 'function')
    throw new Error('createMcpSettingsPage did not import as a function');

if (typeof createWorkspaceSettingsPage !== 'function')
    throw new Error('createWorkspaceSettingsPage did not import as a function');

if (typeof createSkillsSettingsPage !== 'function')
    throw new Error('createSkillsSettingsPage did not import as a function');

if (typeof WorkspaceManager !== 'function' || typeof WorkspaceFileStore !== 'function' || typeof exportConversation !== 'function')
    throw new Error('Workspace helpers did not import');

if (typeof extractPromptVariables !== 'function' || typeof renderPromptTemplate !== 'function')
    throw new Error('Prompt variable helpers did not import');

if (typeof SecretServiceApiKeyStore !== 'function' || typeof MemoryApiKeyStore !== 'function')
    throw new Error('API key stores did not import as classes');

if (typeof presentProviderSettingsDialog !== 'function')
    throw new Error('presentProviderSettingsDialog did not import as a function');

if (typeof createProviderSettingsPage !== 'function')
    throw new Error('createProviderSettingsPage did not import as a function');

if (typeof OpenAiResponsesProvider !== 'function'
    || typeof OpenAiCompatibleChatProvider !== 'function'
    || typeof AnthropicMessagesProvider !== 'function'
    || typeof GeminiGenerateContentProvider !== 'function')
    throw new Error('Remote provider classes did not import');

print('Cusco import smoke passed');
