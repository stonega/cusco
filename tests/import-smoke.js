import {
    APP_AUTHOR,
    APP_ID,
    APP_NAME,
    APP_VERSION,
} from '../src/appInfo.js';
import GLib from 'gi://GLib';
import { APP_ID as APPLICATION_APP_ID, CuscoApplication } from '../src/application.js';
import { ArtifactManager } from '../src/artifacts/manager.js';
import { createDefaultArtifactRendererRegistry } from '../src/artifacts/renderers/registry.js';
import { createArtifactWorkspace } from '../src/artifacts/views/workspace.js';
import { artifactContentSecurityPolicy } from '../src/artifacts/web/runtime.js';
import { buildAgentModeSystemPrompt, parseAgentToolCall } from '../src/chat/agentMode.js';
import { extractArtifactsFromMarkdown } from '../src/chat/artifacts.js';
import { buildCompactionPrompt, getContextUsageState } from '../src/chat/compaction.js';
import { ConversationManager } from '../src/chat/conversation.js';
import { markdownToPangoMarkup, parseMarkdownBlocks } from '../src/chat/markdown.js';
import { createMessageContent } from '../src/chat/messageView.js';
import { estimateConversationUsage } from '../src/chat/usage.js';
import { createCronCreateTool, CronJobManager } from '../src/cron/manager.js';
import { ComputerUseService } from '../src/computerUse/service.js';
import { createComputerUseTools } from '../src/computerUse/tools.js';
import {
    canonicalHookToolName,
    discoverHookSources,
    workspaceHooksPath,
} from '../src/hooks/config.js';
import { HookAuditStore } from '../src/hooks/auditStore.js';
import { createTurnHookContext, HookManager } from '../src/hooks/manager.js';
import { reduceHookRuns } from '../src/hooks/protocol.js';
import { runHookCommand } from '../src/hooks/runner.js';
import { HookTrustStore } from '../src/hooks/trustStore.js';
import { ImageDocument } from '../src/imageEditor/document.js';
import {
    exportDocumentPng,
    loadImageSource,
    renderDocumentToSurface,
} from '../src/imageEditor/renderer.js';
import { presentImageViewer } from '../src/imageEditor/window.js';
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
import { createArchivedChatsWindow, presentArchivedChatsWindow } from '../src/settings/archivedChats.js';
import { createComputerUseSettingsGroup } from '../src/settings/computerUseSettings.js';
import { createHooksSettingsPage } from '../src/settings/hooksSettings.js';
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
import { ArtifactFileStore } from '../src/storage/artifactStore.js';
import { ConversationFileStore } from '../src/storage/conversationStore.js';
import { MemoryFileStore } from '../src/storage/memoryStore.js';
import { WorkspaceFileStore } from '../src/storage/workspaceStore.js';
import { createToolPermissionDecision } from '../src/tools/permissions.js';
import { ToolManager, calculateExpression, parseToolRequest } from '../src/tools/tools.js';
import { exportConversation } from '../src/workspace/exports.js';
import { extractPromptVariables, renderPromptTemplate } from '../src/workspace/promptVariables.js';
import { WorkspaceManager } from '../src/workspace/workspace.js';
import {
    buildShimmerMarkup,
    clipboardFormatsContainImage,
    composerHintPresentation,
    conversationListPageTarget,
    CuscoWindow,
    formatConversationUpdatedAt,
    formatRunningTime,
    messageRunDurationLabel,
    normalizeConversationMessageStartIndex,
    replacePendingAttachment,
    shouldAutoSendQueuedMessages,
    shouldSendLongResponseNotification,
} from '../src/window.js';

if (APP_ID !== 'io.github.stonega.Cusco')
    throw new Error(`Unexpected application id: ${APP_ID}`);

if (APPLICATION_APP_ID !== APP_ID)
    throw new Error(`Unexpected application module id: ${APPLICATION_APP_ID}`);

if (APP_NAME !== 'Cusco' || APP_VERSION.length === 0 || APP_AUTHOR.length === 0)
    throw new Error('App info metadata did not import correctly');

const pngClipboardFormats = {
    contain_gtype: () => false,
    contain_mime_type: (mimeType) => mimeType === 'image/png',
};
const textClipboardFormats = {
    contain_gtype: () => false,
    contain_mime_type: () => false,
};

if (!clipboardFormatsContainImage(pngClipboardFormats)
    || clipboardFormatsContainImage(textClipboardFormats)
    || clipboardFormatsContainImage(null)) {
    throw new Error('Clipboard image formats were not detected safely');
}

if (conversationListPageTarget(0, 50) !== 0
    || conversationListPageTarget(125, 50) !== 50
    || conversationListPageTarget(125, 100) !== 100
    || conversationListPageTarget(125, 50, 101) !== 125) {
    throw new Error('Conversation sidebar page boundaries were not bounded correctly');
}

const [, mesonBuildBytes] = GLib.file_get_contents('meson.build');
const mesonBuild = new TextDecoder().decode(mesonBuildBytes);
const versionMatch = /version:\s*'([^']+)'/.exec(mesonBuild);
if (!versionMatch)
    throw new Error('Could not read project version from meson.build');

if (APP_VERSION !== versionMatch[1])
    throw new Error(`App info version ${APP_VERSION} does not match Meson version ${versionMatch[1]}`);

if (typeof CuscoApplication !== 'function')
    throw new Error('CuscoApplication did not import as a class');

const fakeWindow = {
    is_active: true,
};

if (shouldSendLongResponseNotification(fakeWindow))
    throw new Error('Active windows should not send long-response notifications');

fakeWindow.is_active = false;

if (!shouldSendLongResponseNotification(fakeWindow))
    throw new Error('Inactive windows should send long-response notifications');

const computerUseHint = composerHintPresentation(false, true, true);
if (!computerUseHint.markup?.includes('foreground="#42e6f5"')
    || !computerUseHint.markup.includes('Esc to quit')) {
    throw new Error('Active computer use did not expose the cyan Escape hint');
}

const normalBusyHint = composerHintPresentation(true, true, false);
if (normalBusyHint.label !== 'Enter queues · Esc to stop' || normalBusyHint.markup)
    throw new Error('Normal busy composer hint changed unexpectedly');

if (!shouldAutoSendQueuedMessages()
    || !shouldAutoSendQueuedMessages({
        cancelled: true,
        stoppedBeforeAssistantText: true,
    })
    || shouldAutoSendQueuedMessages({
        cancelled: true,
        stoppedBeforeAssistantText: false,
    })) {
    throw new Error('Queued-message continuation changed unexpectedly');
}

const firstAttachment = { path: '/tmp/first.png' };
const editedAttachmentSource = { path: '/tmp/source.png' };
const lastAttachment = { path: '/tmp/last.png' };
const replacementAttachment = { path: '/tmp/source-edited.png' };
const pendingAttachments = [firstAttachment, editedAttachmentSource, lastAttachment];

if (!replacePendingAttachment(
    pendingAttachments,
    editedAttachmentSource,
    replacementAttachment,
) || pendingAttachments.length !== 3
    || pendingAttachments[0] !== firstAttachment
    || pendingAttachments[1] !== replacementAttachment
    || pendingAttachments[2] !== lastAttachment) {
    throw new Error('Editing a composer image did not replace its exact attachment slot');
}

if (replacePendingAttachment(
    pendingAttachments,
    { path: replacementAttachment.path },
    editedAttachmentSource,
)) {
    throw new Error('Attachment replacement matched a different object by path');
}

let attachmentRefreshes = 0;
let attachmentToast = '';
const composerAttachment = { kind: 'image', path: '/tmp/original.png' };
const siblingAttachment = { kind: 'file', path: '/tmp/notes.txt' };
const editedComposerAttachment = {
    kind: 'image',
    path: 'data/icons/hicolor/64x64/apps/io.github.stonega.Cusco.png',
};
const fakeComposerWindow = {
    _pendingAttachments: [composerAttachment, siblingAttachment],
    _imageAttachCapability: () => ({ allowed: true, reason: '' }),
    _createAttachmentFromPath: () => editedComposerAttachment,
    _updateAttachmentLabel: () => attachmentRefreshes++,
    _showToast: (message) => {
        attachmentToast = message;
    },
    present() {},
    focusComposer() {},
};
const didReplaceComposerAttachment = CuscoWindow.prototype._attachEditedImageToComposer.call(
    fakeComposerWindow,
    editedComposerAttachment.path,
    composerAttachment,
);

if (!didReplaceComposerAttachment
    || fakeComposerWindow._pendingAttachments.length !== 2
    || fakeComposerWindow._pendingAttachments[0] !== editedComposerAttachment
    || fakeComposerWindow._pendingAttachments[1] !== siblingAttachment
    || attachmentRefreshes !== 1
    || attachmentToast !== 'Attachment replaced with the edited image.') {
    throw new Error('The image editor callback did not replace its composer attachment');
}

const [, queuedIconBytes] = GLib.file_get_contents('data/resources/queued-symbolic.svg');
const queuedIcon = new TextDecoder().decode(queuedIconBytes);
if (!queuedIcon.includes('fill="currentColor"') || queuedIcon.includes('fill="#000000"'))
    throw new Error('Queued-message icon is not theme-aware');

if (formatRunningTime(0) !== '0s'
    || formatRunningTime(65) !== '1m 05s'
    || formatRunningTime(3725) !== '1h 02m 05s') {
    throw new Error('Agent running time formatting changed unexpectedly');
}

if (messageRunDurationLabel({ metadata: { agentRunDurationMs: 880000 } }) !== 'Worked for 14m 40s'
    || messageRunDurationLabel({ metadata: { agentRunDurationMs: 65000 } }) !== 'Worked for 1m 05s'
    || messageRunDurationLabel({ metadata: {} }) !== '') {
    throw new Error('Completed Agent run duration presentation changed unexpectedly');
}

const shimmerMarkup = buildShimmerMarkup('Working <now>', 4);
if (!shimmerMarkup.includes('alpha="100%"')
    || !shimmerMarkup.includes('&lt;')
    || shimmerMarkup.includes('<now>')) {
    throw new Error('Activity shimmer markup was not safe or did not contain a highlight');
}

const timestampNow = '2026-07-17T12:00:00+08:00';

if (formatConversationUpdatedAt('2026-07-17T11:58:00+08:00', timestampNow) !== '2 mins ago')
    throw new Error('A chat updated minutes ago did not use a relative subtitle');

if (formatConversationUpdatedAt('2026-07-17T10:00:00+08:00', timestampNow) !== '2 hours ago')
    throw new Error('A chat updated hours ago did not use a relative subtitle');

const olderChatTimestamp = formatConversationUpdatedAt('2026-07-16T23:59:00+08:00', timestampNow);
if (!olderChatTimestamp || olderChatTimestamp.includes('ago'))
    throw new Error('A chat updated before today did not use a calendar date subtitle');

const continuationMessages = Array.from({ length: 20 }, () => ({
    role: 'system',
    toolCall: { agentMode: true },
}));
continuationMessages[13] = { role: 'assistant', content: 'Agent response' };

if (normalizeConversationMessageStartIndex(continuationMessages, 15) !== 13)
    throw new Error('Transcript paging split a nearby Agent Mode message group');

if (normalizeConversationMessageStartIndex(
    Array.from({ length: 20 }, () => ({ toolCall: { agentMode: true } })),
    15,
    2,
) !== 13) {
    throw new Error('Transcript paging exceeded its bounded context window');
}

if (typeof ProviderConfigStore !== 'function')
    throw new Error('ProviderConfigStore did not import as a class');

if (typeof createImageGenerationTool !== 'function' || typeof generateImageForProvider !== 'function')
    throw new Error('Image generation helpers did not import as functions');

if (typeof getProviderGIcon !== 'function' || typeof createProviderIcon !== 'function')
    throw new Error('Provider icon helpers did not import as functions');

if (typeof ConversationManager !== 'function')
    throw new Error('ConversationManager did not import as a class');

if (typeof ImageDocument !== 'function'
    || typeof loadImageSource !== 'function'
    || typeof renderDocumentToSurface !== 'function'
    || typeof exportDocumentPng !== 'function'
    || typeof presentImageViewer !== 'function') {
    throw new Error('Image viewer/editor modules did not import');
}

if (typeof buildAgentModeSystemPrompt !== 'function' || typeof parseAgentToolCall !== 'function')
    throw new Error('Agent Mode helpers did not import');

if (typeof buildCompactionPrompt !== 'function' || typeof getContextUsageState !== 'function')
    throw new Error('Compaction helpers did not import');

if (typeof extractArtifactsFromMarkdown !== 'function')
    throw new Error('Artifact helpers did not import');

if (typeof ArtifactManager !== 'function'
    || typeof ArtifactFileStore !== 'function'
    || typeof createDefaultArtifactRendererRegistry !== 'function'
    || typeof createArtifactWorkspace !== 'function'
    || typeof artifactContentSecurityPolicy !== 'function') {
    throw new Error('Full artifact support modules did not import');
}

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

if (typeof createArchivedChatsWindow !== 'function' || typeof presentArchivedChatsWindow !== 'function')
    throw new Error('Archived chats window helpers did not import as functions');

if (typeof createComputerUseSettingsGroup !== 'function'
    || typeof ComputerUseService !== 'function'
    || typeof createComputerUseTools !== 'function')
    throw new Error('Computer-use modules did not import');

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
