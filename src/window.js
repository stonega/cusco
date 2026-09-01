import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { ArtifactManager } from './artifacts/manager.js';
import { createDefaultArtifactRendererRegistry } from './artifacts/renderers/registry.js';
import { createArtifactWorkspace } from './artifacts/views/workspace.js';
import { AgentRuntime } from './chat/agentRuntime.js';
import {
    extractArtifactsFromMarkdown,
    imageArtifactForToolCall,
} from './chat/artifacts.js';
import { AssistantStreamRunner } from './chat/assistantStreamRunner.js';
import { ConversationContextBuilder } from './chat/contextBuilder.js';
import { ComposerUsageController } from './chat/composerUsage.js';
import { ConversationManager } from './chat/conversation.js';
import { ConversationActions } from './chat/conversationActions.js';
import { ConversationSidebar } from './chat/conversationSidebar.js';
import { MessagePresenter } from './chat/messagePresenter.js';
import { MessageActions } from './chat/messageActions.js';
import { PendingMessagesController } from './chat/pendingMessages.js';
import { PluginsPage } from './chat/pluginsPage.js';
import {
    estimateConversationUsage,
} from './chat/usage.js';
import { formatUsageNumberMarkup, UsagePage } from './chat/usagePage.js';
import { TurnCoordinator } from './chat/turnCoordinator.js';
import { TurnSubmission } from './chat/turnSubmission.js';
import { TranscriptRenderer } from './chat/transcriptRenderer.js';
import { TranscriptScrollController } from './chat/scrollController.js';
import {
    buildShimmerMarkup,
    clipboardFormatsContainImage,
    clipboardFormatsContainText,
    composerHintPresentation,
    conversationListPageTarget,
    defaultConversationOptions,
    formatConversationUpdatedAt,
    formatRunningTime,
    messageRunDurationLabel,
    normalizeConversationMessageStartIndex,
    replacePendingAttachment,
    shouldAutoSendQueuedMessages,
    shouldSendLongResponseNotification,
    shouldSendSudoPasswordNotification,
} from './chat/presentation.js';
import {
    collectProviderResponse,
    collectProviderResponseWithFallback,
} from './chat/providerStream.js';
import { createStreamingAssistantView } from './chat/streamingAssistantView.js';
import {
    createWelcomeMessage,
    isLegacyWelcomeConversation,
    isWelcomeMessage,
    WELCOME_CONVERSATION_TITLE,
    WELCOME_MESSAGE_CONTENT,
} from './chat/welcome.js';
import { AgentQuestionSessions } from './composer/agentQuestions.js';
import { ComposerAttachments } from './composer/attachmentsController.js';
import { ChatSurfaceBuilder } from './composer/chatSurface.js';
import {
    COMPOSER_REFERENCE_STYLES,
    composerReferenceRanges,
    normalizeComposerReferences,
} from './composer/presentation.js';
import { ComposerSuggestions } from './composer/suggestions.js';
import { ComposerInputController } from './composer/inputController.js';
import { GmailGoaConnector } from './connectors/gmailGoa.js';
import { MailGoaConnector } from './connectors/mailGoa.js';
import { ComposerMenus } from './composer/menus.js';
import { presentAutomationDialog } from './cron/dialog.js';
import { createAutomationCreateTool, CronJobManager } from './cron/manager.js';
import { CronConversationSync } from './cron/conversationSync.js';
import { ComputerUseService } from './computerUse/service.js';
import { createComputerUseTools } from './computerUse/tools.js';
import { HookCoordinator } from './hooks/coordinator.js';
import { HookManager } from './hooks/manager.js';
import { MemoryManager } from './memory/memory.js';
import { McpManager } from './mcp/manager.js';
import { ProviderConfigStore } from './providers/config.js';
import { ChatSelectionController } from './providers/chatSelection.js';
import { createImageGenerationTool } from './providers/imageGeneration.js';
import { ModelPicker } from './providers/modelPicker.js';
import { createMessage } from './providers/provider.js';
import { AppSettingsStore } from './settings/appSettings.js';
import { CuscoPluginClient } from './plugins/client.js';
import { presentArchivedChatsWindow } from './settings/archivedChats.js';
import { presentProviderSettingsDialog } from './settings/providerSettings.js';
import { ConversationFileStore } from './storage/conversationStore.js';
import { MemoryFileStore } from './storage/memoryStore.js';
import { WorkspaceFileStore } from './storage/workspaceStore.js';
import { createAskUserTool } from './tools/askUser.js';
import { createMcpManagementTools } from './tools/mcpManagement.js';
import { createArtifactTools } from './tools/artifacts.js';
import { ToolManager } from './tools/tools.js';
import { RequestedToolRunner } from './tools/requestedToolRunner.js';
import { WorkspaceManager } from './workspace/workspace.js';

export {
    buildShimmerMarkup,
    clipboardFormatsContainImage,
    clipboardFormatsContainText,
    composerHintPresentation,
    conversationListPageTarget,
    defaultConversationOptions,
    formatConversationUpdatedAt,
    formatRunningTime,
    formatUsageNumberMarkup,
    messageRunDurationLabel,
    ModelPicker,
    normalizeConversationMessageStartIndex,
    replacePendingAttachment,
    shouldAutoSendQueuedMessages,
    shouldSendLongResponseNotification,
    shouldSendSudoPasswordNotification,
};

const LONG_RESPONSE_NOTIFICATION_DELAY_MS = 10000;
const STREAMING_USAGE_UPDATE_INTERVAL_MS = 100;

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isCancellableCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

function automationError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
}

function getProviderErrorMessage(error) {
    if (error?.userMessage)
        return error.userMessage;

    if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
        return 'The provider request was cancelled.';

    if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
        return 'The provider did not respond before the request timed out.';

    return 'The active provider failed while streaming.';
}

function getMessageReasoningContent(message) {
    if (typeof message?.reasoning === 'string')
        return message.reasoning.trim();

    return String(message?.reasoning?.content ?? '').trim();
}

function isAgentReasoningMessage(message) {
    return Boolean(message?.reasoning?.agentMode && getMessageReasoningContent(message));
}

function createComposerInputController(window) {
    return new ComposerInputController({
        getBuffer: () => window._composerBuffer,
        getText: () => window._getComposerText(),
        setText: (text, options) => window._setComposerText(text, options),
        getReferences: () => window._getComposerReferences(),
        setReferences: (references) => {
            window._composerReferences = references;
        },
        deleteReferenceAtCursor: (keyval) => window._deleteComposerReferenceAtCursor(keyval),
        getActiveConversation: () => window._conversations.activeConversation,
        getPendingMessages: (conversationId) => window._getPendingUserMessages(conversationId),
        isQuestionActive: (conversationId) => Boolean(
            window._activeQuestionSessionForConversation(conversationId),
        ),
    });
}

function createAgentQuestionSessions(window) {
    return new AgentQuestionSessions({
        getActiveConversationId: () => window._conversations.activeConversation?.id ?? null,
        captureDraft: () => window._composerDraftSnapshot(),
        onActivate: () => {
            window._pendingAttachments = [];
            window._setQuestionComposerMode(true);
            window._setComposerText('');
            window._showActiveAgentQuestion();
        },
        onDeactivate: (session, { restoreDraft }) => {
            window._setQuestionComposerMode(false);
            if (!restoreDraft)
                return;
            window._applyComposerDraft(session.draft);
            window._composerDraftsByConversation.set(
                session.conversationId,
                window._composerDraftSnapshot(),
            );
            session.draft = null;
        },
        onShowQuestion: () => window._showActiveAgentQuestion(),
        onSetComposerText: (text) => window._setComposerText(text),
        onFocusComposer: () => window.focusComposer(),
        sessions: window._activeQuestionSessionsByConversation ?? new Map(),
    });
}

function createAgentRuntime(window) {
    const call = (name) => (...args) => window[name](...args);
    const runtime = new AgentRuntime({
        appSettings: window._appSettings,
        conversations: window._conversations,
        tools: window._tools,
        activeTurnHookContexts: call('_activeTurnHookContexts'),
        addMessageIfActiveConversation: call('_addMessageIfActiveConversation'),
        appendRunningToolMessage: call('_appendRunningToolMessage'),
        appendToolOutputChunk: call('_appendToolOutputChunk'),
        authorizeToolRequestWithHooks: call('_authorizeToolRequestWithHooks'),
        collectProviderResponseWithFallback: call('_collectProviderResponseWithFallback'),
        completeRunningToolFailure: call('_completeRunningToolFailure'),
        completeRunningToolMessage: call('_completeRunningToolMessage'),
        confirmToolPermission: call('_confirmToolPermission'),
        createStreamingAssistantView: call('_createStreamingAssistantView'),
        drainPendingUserMessagesForRuntime: call('_drainPendingUserMessagesForRuntime'),
        isActiveConversationId: call('_isActiveConversationId'),
        isConversationBusy: call('_isConversationBusy'),
        promptSudoPassword: call('_promptSudoPassword'),
        runPostToolUseHooks: call('_runPostToolUseHooks'),
        scheduleUsageDisplayUpdate: call('_scheduleUsageDisplayUpdate'),
        scrollToBottom: call('_scrollToBottom'),
        setComposerBusy: call('_setComposerBusy'),
        setToolHookProviderOverride: call('_setToolHookProviderOverride'),
        updateUsageDisplay: call('_updateUsageDisplay'),
    });

    // Prototype smoke harnesses can replace individual runtime seams without
    // changing the production window, whose methods live on its prototype.
    for (const name of [
        '_appendOrUpdateAgentReasoningSegment',
        '_updateAgentModeAssistantView',
        '_parseAgentToolCallForRuntime',
        '_createAgentToolRequest',
        '_runAgentToolRequest',
        '_appendProviderSearchResults',
        '_appendAgentToolCancellation',
        '_appendAgentToolFailure',
    ]) {
        if (Object.hasOwn(window, name) && typeof window[name] === 'function')
            runtime[name] = window[name].bind(window);
    }

    return runtime;
}

function createConversationContextBuilder(window) {
    const call = (name) => (...args) => window[name](...args);

    return new ConversationContextBuilder({
        artifacts: window._artifacts,
        conversations: window._conversations,
        hooks: window._hooks,
        memories: window._memories,
        providerConfigs: window._providerConfigs,
        sessionHookContexts: window._sessionHookContexts,
        tools: window._tools,
        workspace: window._workspace,
        activeTurnHookContexts: call('_activeTurnHookContexts'),
        appendHookNotice: call('_appendHookNotice'),
        applyHookResult: call('_applyHookResult'),
        collectProviderResponse: call('_collectProviderResponse'),
        getContextWindowTokens: call('_getContextWindowTokens'),
        isActiveConversationId: call('_isActiveConversationId'),
        refreshConversationList: call('_refreshConversationList'),
        renderActiveConversation: call('_renderActiveConversation'),
        showToast: call('_showToast'),
        turnHookContext: call('_turnHookContext'),
    });
}

function createTurnCoordinator(window) {
    const call = (name) => (...args) => window[name](...args);

    return new TurnCoordinator({
        computerUse: window._computerUse,
        conversations: window._conversations,
        pendingDeletion: window._conversationsPendingDeletion,
        turns: window._activeTurnsByConversation ?? new Map(),
        finishPrecedingAssistant: (conversationId) => {
            const precedingAssistantView = window._conversations.activeConversation?.id
                === conversationId
                ? window._lastAssistantMessageView
                : window._conversationViewCache?.get(conversationId)?.lastAssistantMessageView;
            precedingAssistantView?.finish_stream?.({ flush: true });
        },
        refreshConversationList: call('_refreshConversationList'),
        renderActiveConversation: call('_renderActiveConversation'),
        schedulePendingConversationSend: call('_schedulePendingConversationSend'),
        setComposerBusy: call('_setComposerBusy'),
        stopLongResponseNotification: call('_stopLongResponseNotification'),
    });
}

function createCronConversationSync(window) {
    const sync = new CronConversationSync({
        cron: window._cron,
        conversations: window._conversations,
        getSelectionSerial: () => window._conversationSelectionSerial,
        createDefaultConversation: () => window._createConversationWithDefaults(),
        refreshConversationList: () => window._refreshConversationList(),
        renderActiveConversation: () => window._renderActiveConversation(),
    });

    // Keep the window method seams usable by focused prototype smoke tests.
    if (Object.hasOwn(window, '_ensureCronConversation'))
        sync.ensureConversation = window._ensureCronConversation.bind(window);
    if (Object.hasOwn(window, '_appendCronRunLogs'))
        sync.appendRunLogs = window._appendCronRunLogs.bind(window);

    return sync;
}

function createTranscriptRenderer(window) {
    const renderer = new TranscriptRenderer({
        appSettings: window._appSettings,
        conversations: window._conversations,
        viewCache: window._conversationViewCache ?? new Map(),
        messageStartIndexes: window._conversationMessageStartIndexes ?? new Map(),
        renderedConversationId: window._renderedConversationId ?? null,
        getConversationStack: () => window._conversationStack,
        getCurrentViewState: () => ({
            messages: window._messages,
            bottomSpacer: window._messageBottomSpacer,
            lastAssistantMessageView: window._lastAssistantMessageView,
            pendingAssistantActivityEntries: window._pendingAssistantActivityEntries,
            referenceContents: window._userMessageReferenceContents,
        }),
        setCurrentViewState: (state) => {
            window._messages = state.messages;
            window._messageBottomSpacer = state.bottomSpacer;
            window._lastAssistantMessageView = state.lastAssistantMessageView;
            window._pendingAssistantActivityEntries = state.pendingAssistantActivityEntries;
            window._userMessageReferenceContents = state.referenceContents;
        },
        takeInitialConversationView: () => {
            const entry = window._initialConversationView;
            window._initialConversationView = null;
            return entry;
        },
        prepareConversation: (conversation) => {
            window._migrateWelcomeConversation(conversation);
            window._migrateLegacyArtifacts(conversation);
            window._artifactWorkspace?.setConversation(conversation?.id ?? '');
            window._syncArtifactWorkspaceButton();

            if (window._artifactSplitView?.get_show_sidebar()) {
                const activeReference = window._artifactWorkspace?.getActiveReference?.();
                const activeArtifact = activeReference
                    ? window._artifacts.resolveReference(activeReference)?.artifact
                    : null;

                if (activeArtifact?.originConversationId
                    && activeArtifact.originConversationId !== conversation?.id) {
                    window._closeArtifactWorkspace();
                }
            }

            const pendingArtifactReference = conversation?.id
                ? window._pendingArtifactPresentationsByConversation?.get(conversation.id)
                : null;

            if (pendingArtifactReference) {
                window._pendingArtifactPresentationsByConversation.delete(conversation.id);
                window._openArtifactWorkspace(pendingArtifactReference);
            }

            window._syncProviderControls(conversation);
            window._syncAgentQuestionComposerMode();
        },
        renderPendingUserMessages: (conversation) => window._renderPendingUserMessages(conversation),
        syncEmptyConversationState: (conversation) => (
            window._syncEmptyConversationState(conversation)
        ),
        showConversationLoadingState: () => window._showConversationLoadingState(),
        isActiveConversationId: (conversationId) => window._isActiveConversationId(conversationId),
        isConversationBusy: (conversationId) => window._isConversationBusy(conversationId),
        setComposerBusy: (busy) => window._setComposerBusy(busy),
        setFollowLatestMessage: (enabled) => window._setFollowLatestMessage(enabled),
        addMessage: (...args) => window._addMessage(...args),
        updateUsageDisplay: (conversation) => window._updateUsageDisplay(conversation),
        scrollToBottom: (options) => window._scrollToBottom(options),
        onStateChanged: (state) => {
            window._isBatchRenderingConversation = state.isBatchRendering;
            window._renderedConversationId = state.renderedConversationId;
            window._conversationRenderSourceId = state.renderSourceId;
        },
    });

    for (const [windowMethod, rendererMethod] of [
        ['_conversationViewFingerprint', 'conversationViewFingerprint'],
        ['_normalizeConversationMessageStartIndex', 'normalizeMessageStartIndex'],
        ['_createLoadEarlierMessagesRow', 'createLoadEarlierMessagesRow'],
        ['_getCachedConversationView', 'getCachedConversationView'],
        ['_captureCurrentConversationView', 'captureCurrentConversationView'],
        ['_activateConversationView', 'activateConversationView'],
        ['_touchConversationView', 'touchConversationView'],
        ['_removeConversationView', 'removeConversationView'],
        ['_trimConversationViewCache', 'trimConversationViewCache'],
        ['_cancelScheduledConversationRender', 'cancelScheduledConversationRender'],
        ['_scheduleActiveConversationRender', 'scheduleActiveConversationRender'],
        ['_finishConversationViewRender', 'finishConversationViewRender'],
        ['_renderConversationMessagesIncrementally', 'renderConversationMessagesIncrementally'],
    ]) {
        if (Object.hasOwn(window, windowMethod) && typeof window[windowMethod] === 'function')
            renderer[rendererMethod] = window[windowMethod].bind(window);
    }

    return renderer;
}

function createTranscriptScrollController(window) {
    return new TranscriptScrollController({
        appSettings: window._appSettings,
        getScroller: () => window._scroller,
        getScrollButton: () => window._scrollToBottomButton,
        isBatchRendering: () => Boolean(window._isBatchRenderingConversation),
    });
}

function createMessagePresenter(window) {
    const call = (name) => (...args) => window[name](...args);
    const presenter = new MessagePresenter({
        appSettings: window._appSettings,
        artifacts: window._artifacts,
        artifactRenderers: window._artifactRenderers,
        conversations: window._conversations,
        getParentWindow: () => window,
        getState: (name) => window[name],
        setState: (name, value) => {
            window[name] = value;
        },
        appendMessageWidget: call('_appendMessageWidget'),
        clearBox: call('_clearBox'),
        composerReferenceStyles: call('_composerReferenceStyles'),
        confirmOpenArtifactLink: call('_confirmOpenArtifactLink'),
        createAttachmentPreviewCard: call('_createAttachmentPreviewCard'),
        editMessage: call('_editMessage'),
        exportArtifact: call('_exportArtifact'),
        openArtifactWorkspace: call('_openArtifactWorkspace'),
        openImageViewer: call('_openImageViewer'),
        regenerateFromMessage: call('_regenerateFromMessage'),
        retryFromMessage: call('_retryFromMessage'),
        branchFromMessage: call('_branchFromMessage'),
        scrollToBottom: call('_scrollToBottom'),
        showToast: call('_showToast'),
        streamPresentationPreferences: call('_streamPresentationPreferences'),
    });

    for (const name of [
        '_messageContentOptions',
        '_createEmptyConversationState',
        '_syncEmptyConversationState',
        '_showConversationLoadingState',
        '_showEmptyConversationState',
        '_hideEmptyConversationState',
        '_updateEmptyConversationImage',
        '_createKnotIcon',
        '_createTextShimmerController',
        '_createAgentWorkingRow',
        '_createKnotStatusRow',
        '_createThinkingLabelWidget',
        '_createReasoningExpander',
        '_createAgentReasoningSegment',
        '_createBashOutputPreview',
        '_createToolArtifactPreviews',
        '_createToolResultExpander',
        '_createMessageImageAttachmentPreviews',
        '_createMessageImageAttachmentPreview',
        '_shouldAnimateWelcomeMessage',
        '_startWelcomeMessageStream',
        '_addToolMessage',
        '_createMessageActions',
        '_createMessageActionButton',
    ]) {
        if (Object.hasOwn(window, name) && typeof window[name] === 'function')
            presenter[name] = window[name].bind(window);
    }

    return presenter;
}

function createHookCoordinator(window) {
    return new HookCoordinator({
        appSettings: window._appSettings,
        conversations: window._conversations,
        hooks: window._hooks,
        sessionHookContexts: window._sessionHookContexts,
        tools: window._tools,
        turns: window._activeTurnsByConversation,
        activeTurnHookContexts: (conversationId) => window._activeTurnHookContexts(conversationId),
        addMessageIfActiveConversation: (conversationId, message) => (
            window._addMessageIfActiveConversation(conversationId, message)
        ),
        showToast: (message) => window._showToast(message),
    });
}

function createRequestedToolRunner(window) {
    const call = (name) => (...args) => window[name](...args);

    return new RequestedToolRunner({
        appSettings: window._appSettings,
        conversations: window._conversations,
        providerConfigs: window._providerConfigs,
        tools: window._tools,
        getParentWindow: () => window,
        addMessageIfActiveConversation: call('_addMessageIfActiveConversation'),
        appendToolCancellation: call('_appendToolCancellation'),
        authorizeToolRequestWithHooks: call('_authorizeToolRequestWithHooks'),
        manageArtifactList: call('_manageArtifactList'),
        runPostToolUseHooks: call('_runPostToolUseHooks'),
        scrollToBottom: call('_scrollToBottom'),
        setToolHookProviderOverride: call('_setToolHookProviderOverride'),
        syncArtifactWorkspaceButton: call('_syncArtifactWorkspaceButton'),
        updateUsageDisplay: call('_updateUsageDisplay'),
    });
}

export function createAssistantStreamRunner(window) {
    const call = (name) => (...args) => window[name](...args);

    return new AssistantStreamRunner({
        appSettings: window._appSettings,
        conversations: window._conversations,
        connectors: window._pluginConnectors,
        hooks: window._hooks,
        mcp: window._mcp,
        tools: window._tools,
        appendHookNotice: call('_appendHookNotice'),
        applyHookResult: call('_applyHookResult'),
        beginActiveTurn: call('_beginActiveTurn'),
        buildProviderMessages: call('_buildProviderMessages'),
        collectProviderResponseWithFallback: call('_collectProviderResponseWithFallback'),
        createStreamingAssistantView: call('_createStreamingAssistantView'),
        ensureTurnSessionHooks: call('_ensureTurnSessionHooks'),
        finishActiveTurn: call('_finishActiveTurn'),
        handleQueuedUserMessageError: call('_handleQueuedUserMessageError'),
        injectMemoryContext: call('_injectMemoryContext'),
        injectSkillContext: call('_injectSkillContext'),
        isActiveConversationId: call('_isActiveConversationId'),
        isConversationBusy: call('_isConversationBusy'),
        materializeAssistantArtifacts: call('_materializeAssistantArtifacts'),
        maybeAutoCompactConversation: call('_maybeAutoCompactConversation'),
        refreshConversationList: call('_refreshConversationList'),
        renderActiveConversation: call('_renderActiveConversation'),
        runAgentModeResponse: call('_runAgentModeResponse'),
        scheduleUsageDisplayUpdate: call('_scheduleUsageDisplayUpdate'),
        scrollToBottom: call('_scrollToBottom'),
        sendQueuedUserMessages: call('_sendQueuedUserMessages'),
        setFollowLatestMessage: call('_setFollowLatestMessage'),
        startLongResponseNotification: call('_startLongResponseNotification'),
        stopLongResponseNotification: call('_stopLongResponseNotification'),
        turnHookContext: call('_turnHookContext'),
        updateUsageDisplay: call('_updateUsageDisplay'),
    });
}

function createTurnSubmission(window) {
    const call = (name) => (...args) => window[name](...args);
    const submission = new TurnSubmission({
        conversations: window._conversations,
        conversationsPendingDeletion: window._conversationsPendingDeletion,
        composerDraftsByConversation: window._composerDraftsByConversation,
        pendingUserMessagesByConversation: window._pendingUserMessagesByConversation,
        turns: window._activeTurnsByConversation,
        getPendingConversationSendSourceId: () => window._pendingConversationSendSourceId,
        setPendingConversationSendSourceId: (sourceId) => {
            window._pendingConversationSendSourceId = sourceId;
        },
        getPendingAttachments: () => window._pendingAttachments,
        addMessage: call('_addMessage'),
        addMessageIfActiveConversation: call('_addMessageIfActiveConversation'),
        appendStoppedMessage: call('_appendStoppedMessage'),
        appendSystemError: call('_appendSystemError'),
        applyComposerDraft: call('_applyComposerDraft'),
        beginActiveTurn: call('_beginActiveTurn'),
        createAttachmentsForComposerReferences: call('_createAttachmentsForComposerReferences'),
        createConversationWithDefaults: call('_createConversationWithDefaults'),
        createStreamingAssistantView: call('_createStreamingAssistantView'),
        ensureConversationProviderAvailable: call('_ensureConversationProviderAvailable'),
        ensureTurnSessionHooks: call('_ensureTurnSessionHooks'),
        finishActiveTurn: call('_finishActiveTurn'),
        focusComposer: () => window.focusComposer(),
        formatUserMessageContent: call('_formatUserMessageContent'),
        getComposerText: call('_getComposerText'),
        getPendingUserMessages: call('_getPendingUserMessages'),
        isActiveConversationId: call('_isActiveConversationId'),
        isConversationBusy: call('_isConversationBusy'),
        promptMemoryProposal: call('_promptMemoryProposal'),
        refreshConversationList: call('_refreshConversationList'),
        renderPendingUserMessages: call('_renderPendingUserMessages'),
        runRequestedTool: call('_runRequestedTool'),
        runUserPromptHooks: call('_runUserPromptHooks'),
        scrollToBottom: call('_scrollToBottom'),
        streamAssistantResponse: call('_streamAssistantResponse'),
        syncEmptyConversationState: call('_syncEmptyConversationState'),
        updateAttachmentLabel: call('_updateAttachmentLabel'),
        updateUsageDisplay: call('_updateUsageDisplay'),
    });

    for (const name of [
        '_drainPendingUserMessages',
        '_preparePendingUserMessageHooks',
        '_sendQueuedUserMessages',
        '_handleQueuedUserMessageError',
    ]) {
        if (Object.hasOwn(window, name) && typeof window[name] === 'function')
            submission[name] = window[name].bind(window);
    }

    return submission;
}

function createMessageActions(window) {
    const call = (name) => (...args) => window[name](...args);

    return new MessageActions({
        conversations: window._conversations,
        getParentWindow: () => window,
        getProviderErrorMessage,
        appendSystemError: call('_appendSystemError'),
        isConversationBusy: call('_isConversationBusy'),
        refreshConversationList: call('_refreshConversationList'),
        renderActiveConversation: call('_renderActiveConversation'),
        streamAssistantResponse: call('_streamAssistantResponse'),
    });
}

function createPendingMessagesController(window) {
    const call = (name) => (...args) => window[name](...args);
    const controller = new PendingMessagesController({
        conversations: window._conversations,
        pendingUserMessagesByConversation: window._pendingUserMessagesByConversation,
        turns: window._activeTurnsByConversation,
        getState: (name) => window[name],
        setState: (name, value) => {
            window[name] = value;
        },
        clearBox: call('_clearBox'),
        composerReferenceStyles: call('_composerReferenceStyles'),
        focusComposer: () => window.focusComposer(),
        isConversationBusy: call('_isConversationBusy'),
        runUserPromptHooks: call('_runUserPromptHooks'),
        syncComposerHint: call('_syncComposerHint'),
    });

    for (const name of [
        '_getPendingUserMessages',
        '_enqueuePendingUserMessage',
        '_removePendingUserMessage',
        '_createPendingUserMessageCard',
        '_renderPendingUserMessages',
    ]) {
        if (Object.hasOwn(window, name) && typeof window[name] === 'function')
            controller[name] = window[name].bind(window);
    }

    return controller;
}

function createConversationSidebar(window) {
    const sidebar = new ConversationSidebar({
        conversations: window._conversations,
        isConversationBusy: (conversationId) => window._isConversationBusy(conversationId),
        getAutomationJob: (jobId) => window._cronConversationSync?.getJob(jobId),
        onNewChat: () => window._createNewConversation(),
        onNewAutomation: () => window._presentNewAutomationDialog(),
        onSettings: () => window._showSettingsDialog(),
        onShowUsage: () => window._showUsagePage(),
        onShowPlugins: () => window._showPluginsPage(),
        onSelectConversation: (conversationId) => {
            window._showChatPage();
            window._conversationSelectionSerial += 1;
            window._selectConversation(conversationId);
            window._renderActiveConversation({ deferIfUncached: true });
        },
        onRenameConversation: (conversationId) => window._renameConversation(conversationId),
        onArchiveConversation: (conversationId) => window._archiveConversation(conversationId),
        onExportConversation: (conversationId) => window._exportConversation(conversationId),
        onDeleteConversation: (conversationId) => window._confirmDeleteConversation(conversationId),
        onDeleteCronConversation: (conversationId) => (
            window._confirmDeleteCronJobConversation(conversationId)
        ),
        onEditAutomation: (conversationId) => (
            window._presentEditAutomationDialog(conversationId)
        ),
        onRunAutomation: (conversationId) => window._runAutomationConversation(conversationId),
        onToggleAutomation: (conversationId) => (
            window._toggleAutomationConversation(conversationId)
        ),
        onModeChanged: (mode) => {
            if (mode === 'chats') {
                const hasChat = window._conversations.searchConversations('', {
                    conversationType: 'chat',
                    limit: 1,
                }).length > 0;

                if (!hasChat) {
                    window._createConversationWithDefaults();
                    window._refreshConversationList({ resetPage: true });
                    window._renderActiveConversation();
                }
                return;
            }

            window._syncCronJobsWithConversations({ refreshUi: true }).catch((error) => {
                logError(error, 'Failed to refresh automations');
            });
        },
    });

    return sidebar;
}

function createComposerUsageController(window) {
    return new ComposerUsageController({
        appSettings: window._appSettings,
        conversations: window._conversations,
        providerConfigs: window._providerConfigs,
        getState: (name) => window[name],
        setState: (name, value) => {
            window[name] = value;
        },
        getComposerText: () => window._getComposerText(),
        isConversationUsingComputer: (conversationId) => (
            window._isConversationUsingComputer(conversationId)
        ),
    });
}

function createChatSurfaceBuilder(window) {
    const call = (name) => (...args) => window[name](...args);

    return new ChatSurfaceBuilder({
        appSettings: window._appSettings,
        conversations: window._conversations,
        composerDraftsByConversation: window._composerDraftsByConversation,
        getState: (name) => window[name],
        setState: (name, value) => {
            window[name] = value;
        },
        activeQuestionSessionForConversation: call('_activeQuestionSessionForConversation'),
        appendSystemError: call('_appendSystemError'),
        attachFileContext: call('_attachFileContext'),
        consumePendingAttachments: call('_consumePendingAttachments'),
        createChatOptionsMenuButton: call('_createChatOptionsMenuButton'),
        createComposerSuggestionPanel: call('_createComposerSuggestionPanel'),
        createComposerUsagePopover: call('_createComposerUsagePopover'),
        createConversationView: call('_createConversationView'),
        createEmptyConversationState: call('_createEmptyConversationState'),
        createPendingUserMessagesRow: call('_createPendingUserMessagesRow'),
        createPromptMenuButton: call('_createPromptMenuButton'),
        createProviderConfigButton: call('_createProviderConfigButton'),
        createProviderPicker: call('_createProviderPicker'),
        deleteComposerReferenceAtCursor: call('_deleteComposerReferenceAtCursor'),
        enqueuePendingUserMessageWithHooks: call('_enqueuePendingUserMessageWithHooks'),
        getComposerReferences: call('_getComposerReferences'),
        getComposerText: call('_getComposerText'),
        handleComposerHistoryKey: call('_handleComposerHistoryKey'),
        handleComposerReadlineKey: call('_handleComposerReadlineKey'),
        handleComposerSuggestionKey: call('_handleComposerSuggestionKey'),
        handleModelChanged: call('_handleModelChanged'),
        handleProviderChanged: call('_handleProviderChanged'),
        handleThinkingLevelChanged: call('_handleThinkingLevelChanged'),
        isConversationBusy: call('_isConversationBusy'),
        pasteClipboardContentIfAvailable: call('_pasteClipboardContentIfAvailable'),
        populateProviderPicker: call('_populateProviderPicker'),
        scheduleComposerSuggestionRefresh: call('_scheduleComposerSuggestionRefresh'),
        scheduleComposerUsageChartSync: call('_scheduleComposerUsageChartSync'),
        scrollToBottom: call('_scrollToBottom'),
        sendMessage: call('_sendMessage'),
        setComposerText: call('_setComposerText'),
        showToast: call('_showToast'),
        submitAgentQuestionAnswer: call('_submitAgentQuestionAnswer'),
        syncComposerHint: call('_syncComposerHint'),
        syncComposerPlaceholder: call('_syncComposerPlaceholder'),
        syncComposerReferenceTagStyles: call('_syncComposerReferenceTagStyles'),
        syncComposerReferenceTags: call('_syncComposerReferenceTags'),
        syncComposerUsageChart: call('_syncComposerUsageChart'),
        syncScrollToBottomButton: call('_syncScrollToBottomButton'),
        syncUserMessageReferenceStyles: call('_syncUserMessageReferenceStyles'),
    });
}

function createComposerMenus(window) {
    const call = (name) => (...args) => window[name](...args);

    return new ComposerMenus({
        workspace: window._workspace,
        getParentWindow: () => window,
        getState: (name) => window[name],
        setState: (name, value) => {
            window[name] = value;
        },
        focusComposer: () => window.focusComposer(),
        getComposerText: call('_getComposerText'),
        setComposerText: call('_setComposerText'),
        handleMemoryToggleChanged: call('_handleMemoryToggleChanged'),
        handleAgentModeToggleChanged: call('_handleAgentModeToggleChanged'),
        handleSkillsToggleChanged: call('_handleSkillsToggleChanged'),
    });
}

function createConversationActions(window) {
    const call = (name) => (...args) => window[name](...args);

    return new ConversationActions({
        conversations: window._conversations,
        cron: window._cron,
        conversationsPendingDeletion: window._conversationsPendingDeletion ?? new Set(),
        pendingUserMessagesByConversation: window._pendingUserMessagesByConversation ?? new Map(),
        composerDraftsByConversation: window._composerDraftsByConversation ?? new Map(),
        pendingArtifactPresentationsByConversation: (
            window._pendingArtifactPresentationsByConversation ?? new Map()
        ),
        turns: window._activeTurnsByConversation ?? new Map(),
        getParentWindow: () => window,
        appendSystemError: call('_appendSystemError'),
        applyComposerDraft: call('_applyComposerDraft'),
        createConversationWithDefaults: call('_createConversationWithDefaults'),
        deleteCronConversation: call('_deleteCronConversation'),
        finishAgentQuestions: call('_finishAgentQuestions'),
        isActiveConversationId: (conversationId) => (
            window._conversations.activeConversation?.id === conversationId
        ),
        isCronConversation: call('_isCronConversation'),
        refreshConversationList: call('_refreshConversationList'),
        renderActiveConversation: call('_renderActiveConversation'),
        setFollowLatestMessage: call('_setFollowLatestMessage'),
        showToast: call('_showToast'),
    });
}

export const CuscoWindow = GObject.registerClass(
class CuscoWindow extends Adw.ApplicationWindow {
    _init(application) {
        super._init({
            application,
            title: 'Cusco',
            default_width: 1120,
            default_height: 760,
        });

        this._appSettings = new AppSettingsStore();
        this._hooks = new HookManager({
            settings: this._appSettings,
            onStatus: (message) => this._showToast?.(message),
        });
        this._memories = new MemoryManager({ store: new MemoryFileStore() });
        this._workspace = new WorkspaceManager({ store: new WorkspaceFileStore() });
        this._artifacts = new ArtifactManager();
        this._artifactRenderers = createDefaultArtifactRendererRegistry(this._artifacts);
        this._providerConfigs = new ProviderConfigStore();
        this._tools = new ToolManager({
            searchConfig: () => this._providerConfigs.createWebSearchFallbackConfig(),
        });
        this._computerUse = new ComputerUseService({
            settings: this._appSettings,
            onActiveChanged: (active) => this._syncComputerUseStatus(active),
            onStopRequested: () => this._stopComputerUseAndReturn(),
        });
        this._cron = new CronJobManager();
        this._mcp = new McpManager({ workspaceManager: this._workspace });
        this._composerDraftsByConversation = new Map();
        this._pendingArtifactPresentationsByConversation = new Map();
        this._conversationsPendingDeletion = new Set();
        this._composerReferences = [];
        this._userMessageReferenceContents = new Set();
        this._composerUsageSyncSourceId = 0;
        this._followLatestMessage = false;
        this._scrollToBottomSourceId = 0;
        this._scrollToBottomPasses = 0;
        this._scrollToBottomAnimationSourceId = 0;
        this._conversationViewCache = new Map();
        this._conversationMessageStartIndexes = new Map();
        this._conversationRenderSourceId = 0;
        this._pendingConversationView = null;
        this._isBatchRenderingConversation = false;
        this._renderedConversationId = null;
        this._conversationSelectionSerial = 0;
        this._animatedWelcomeMessageIds = new Set();
        this._welcomeStreamSourceIds = new Set();
        this._legacyArtifactMigrationIds = new Set();
        this._conversationLoadErrorToastIds = new Set();
        this._usageDisplaySourceId = 0;
        this._pendingUsageConversationId = null;
        const { provider: defaultProvider, model: defaultModel } = this._providerConfigs.getActiveSelection();

        this._conversations = new ConversationManager({
            providerId: defaultProvider?.id ?? '',
            modelId: defaultModel?.id ?? '',
            thinkingLevel: this._appSettings.thinkingLevel,
            store: new ConversationFileStore(),
        });
        this._scrollController = createTranscriptScrollController(this);
        this._transcriptRenderer = createTranscriptRenderer(this);
        this._composerUsage = createComposerUsageController(this);
        this._usagePage = new UsagePage({
            conversations: this._conversations,
            onBack: () => this._showChatPage(),
            providerConfigs: this._providerConfigs,
        });
        this._pluginClient = new CuscoPluginClient();
        this._gmailConnector = new GmailGoaConnector();
        this._mailConnector = new MailGoaConnector();
        this._goaConnectors = new Map([
            ['gmail-goa', this._gmailConnector],
            ['mail-goa', this._mailConnector],
        ]);
        this._pluginConnectors = {
            refreshTools: async (tools, options = {}) => {
                const enabledPlugins = new Set();

                try {
                    const plugins = await this._pluginClient.listPlugins();
                    for (const plugin of plugins) {
                        if (plugin.installed && plugin.enabled)
                            enabledPlugins.add(plugin.name);
                    }
                } catch (error) {
                    logError(error, 'Failed to determine which native plugins are installed');
                }

                return await Promise.all([
                    this._gmailConnector.refreshTools(tools, {
                        ...options,
                        enabled: enabledPlugins.has('gmail'),
                    }),
                    this._mailConnector.refreshTools(tools, {
                        ...options,
                        enabled: enabledPlugins.has('mail'),
                    }),
                ]);
            },
        };
        this._pluginsPage = new PluginsPage({
            client: this._pluginClient,
            getParentWindow: () => this,
            gmailConnector: this._gmailConnector,
            goaConnectors: this._goaConnectors,
            mcpManager: this._mcp,
            onBack: () => this._showChatPage(),
            onChanged: () => {
                this._workspace.refreshInstalledSkills();
                this._pluginsPage?.refreshSkills();
            },
            onManagementChanged: (change) => this._handleProviderSettingsChanged(change),
            onToast: (message) => this._showToast(message),
            workspaceManager: this._workspace,
        });
        this._cronConversationSync = createCronConversationSync(this);
        this._composerInput = createComposerInputController(this);
        this._composerSuggestions = new ComposerSuggestions({
            workspace: this._workspace,
            artifacts: this._artifacts,
            getActiveConversationId: () => this._conversations.activeConversation?.id ?? '',
            getBuffer: () => this._composerBuffer,
            getText: () => this._getComposerText(),
            getReferences: () => this._getComposerReferences(),
            addReference: (reference) => {
                const alreadyTracked = this._composerReferences.some((item) => (
                    item.kind === reference.kind
                    && item.value === reference.value
                    && item.insertText === reference.insertText
                ));
                if (!alreadyTracked)
                    this._composerReferences.push(reference);
            },
            isUpdatingReferences: () => Boolean(this._updatingComposerReferences),
            setUpdatingReferences: (updating) => {
                this._updatingComposerReferences = updating;
            },
            syncReferenceTags: () => this._syncComposerReferenceTags(),
            focusComposer: () => this.focusComposer(),
            isQuestionActive: (conversationId) => Boolean(
                this._activeQuestionSessionForConversation(conversationId),
            ),
        });
        this._composerAttachments = new ComposerAttachments({
            providerConfigs: this._providerConfigs,
            conversations: this._conversations,
            getProviderPicker: () => this._providerPicker,
            getComposer: () => this._composer,
            getComposerBuffer: () => this._composerBuffer,
            getAttachmentRow: () => this._attachmentRow,
            getAttachmentPreviewList: () => this._attachmentPreviewList,
            getParentWindow: () => this,
            showToast: (message) => this._showToast(message),
            presentWindow: () => this.present(),
            focusComposer: () => this.focusComposer(),
        });
        this._chatSelection = new ChatSelectionController({
            providerConfigs: this._providerConfigs,
            conversations: this._conversations,
            workspace: this._workspace,
            appSettings: this._appSettings,
            getProviderPicker: () => this._providerPicker,
            getModelPicker: () => this._modelPicker,
            getThinkingLevelPicker: () => this._thinkingLevelPicker,
            getProviderConfigButton: () => this._providerConfigButton,
            getMemoryToggle: () => this._memoryToggleButton,
            getAgentModeToggle: () => this._agentModeToggleButton,
            getSkillsToggle: () => this._skillsToggleButton,
            refreshConversationList: () => this._refreshConversationList(),
            discardUnsupportedImages: () => this._composerAttachments.discardUnsupportedImages(),
            updateUsage: (conversation) => this._updateUsageDisplay(conversation),
            showProviderSettings: () => this._showSettingsDialog({ initialPage: 'providers' }),
        });
        this._agentRuntime = createAgentRuntime(this);
        this._messageActions = createMessageActions(this);
        this._messagePresenter = createMessagePresenter(this);
        this._migrateLegacyArtifacts();
        this._tools.registerTool(createImageGenerationTool(this._providerConfigs));
        this._tools.registerTool(createAskUserTool(
            (questions, options) => this._requestAgentQuestions(questions, options),
        ));
        for (const tool of createMcpManagementTools(this._mcp, this._tools))
            this._tools.registerTool(tool);
        this._tools.registerTool(createAutomationCreateTool(this._cron, {
            onJobCreated: async (job) => this._handleCronJobChanged(job),
        }));
        for (const tool of createArtifactTools(this._artifacts, {
            getConversationId: () => this._conversations.activeConversation?.id ?? '',
            onPresent: (reference, context = {}) => {
                const conversationId = String(context.conversationId ?? '').trim();

                if (conversationId === this._conversations.activeConversation?.id)
                    return this._openArtifactWorkspace(reference);

                if (conversationId)
                    this._pendingArtifactPresentationsByConversation.set(conversationId, reference);
                return false;
            },
        })) {
            this._tools.registerTool(tool);
        }
        this._syncComputerUseTools();

        if (defaultProvider) {
            this._createConversationWithDefaults();
        } else if (this._conversations.conversations.length === 0) {
            this._createConversationWithDefaults({
                title: WELCOME_CONVERSATION_TITLE,
                thinkingLevel: this._appSettings.thinkingLevel,
                messages: [createWelcomeMessage()],
                persistImmediately: true,
            });
        }

        this._activeTurnsByConversation = new Map();
        this._turnCoordinator = createTurnCoordinator(this);
        this._sessionHookContexts = new Map();
        this._hookCoordinator = createHookCoordinator(this);
        this._requestedToolRunner = createRequestedToolRunner(this);
        this._assistantStreamRunner = createAssistantStreamRunner(this);
        this._conversationContext = createConversationContextBuilder(this);
        this._agentQuestions = createAgentQuestionSessions(this);
        this._activeQuestionSessionsByConversation = this._agentQuestions.sessions;
        this._pendingUserMessagesByConversation = new Map();
        this._pendingConversationSendSourceId = 0;
        this._pendingMessages = createPendingMessagesController(this);
        this._turnSubmission = createTurnSubmission(this);
        this._lastAssistantMessageView = null;
        this._pendingAssistantActivityEntries = [];
        this._gtkAnimationsChangedSignalId = 0;
        const gtkSettings = Gtk.Settings.get_default();

        if (gtkSettings) {
            this._gtkAnimationsChangedSignalId = gtkSettings.connect(
                'notify::gtk-enable-animations',
                () => this._refreshStreamPresentationPreferences(),
            );
        }
        this._closePersistencePromise = null;
        this._canCloseAfterPersistence = false;
        this.connect('close-request', () => {
            if (!this._canCloseAfterPersistence) {
                if (!this._closePersistencePromise) {
                    this._stopAllConversations();
                    this._closePersistencePromise = Promise.resolve(
                        this._conversations.persistAsync?.() ?? this._conversations.persist(),
                    ).finally(() => {
                        this._canCloseAfterPersistence = true;
                        this.close();
                    });
                }

                return true;
            }

            this._stopAllConversations();
            this._cronConversationSync.dispose();
            this._composerSuggestions.dispose();
            this._conversationSidebar?.dispose();

            this._composerAttachments.dispose();

            if (this._composerUsageSyncSourceId) {
                GLib.Source.remove(this._composerUsageSyncSourceId);
                this._composerUsageSyncSourceId = 0;
            }

            for (const sourceId of this._welcomeStreamSourceIds)
                GLib.Source.remove(sourceId);
            this._welcomeStreamSourceIds.clear();

            this._cancelScheduledConversationRender();
            this._scrollController.dispose();

            if (this._usageDisplaySourceId) {
                GLib.Source.remove(this._usageDisplaySourceId);
                this._usageDisplaySourceId = 0;
            }

            this._usagePage.dispose();
            this._pluginsPage.dispose();
            this._gmailConnector.dispose();
            this._mailConnector.dispose();

            if (this._pendingConversationSendSourceId) {
                GLib.Source.remove(this._pendingConversationSendSourceId);
                this._pendingConversationSendSourceId = 0;
            }

            if (this._composerStyleManagerSignalId) {
                Adw.StyleManager.get_default().disconnect(this._composerStyleManagerSignalId);
                this._composerStyleManagerSignalId = 0;
            }

            if (this._gtkAnimationsChangedSignalId) {
                Gtk.Settings.get_default()?.disconnect(this._gtkAnimationsChangedSignalId);
                this._gtkAnimationsChangedSignalId = 0;
            }

            if (this._chatStatisticsPopover) {
                this._chatStatisticsPopover.popdown();
                this._chatStatisticsPopover.unparent();
                this._chatStatisticsPopover = null;
            }

            if (this._composerUsagePopover) {
                this._composerUsagePopover.popdown();
                this._composerUsagePopover.unparent();
                this._composerUsagePopover = null;
            }

            this._mcp.shutdown();
            this._computerUse.shutdown();
            return false;
        });
        this._buildUi();

        if (this._conversations.storageError) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._showToast('Chat history could not be loaded. Existing data was left unchanged.');
                return GLib.SOURCE_REMOVE;
            });
        }

        this._refreshConversationList();
        this._renderActiveConversation();

        if (defaultProvider)
            this.focusComposer();

        this._syncCronJobsWithConversations({ refreshUi: true }).catch((error) => {
            logError(error, 'Failed to sync automations');
        });
        this._startCronLogSync();
    }

    get _pendingAttachments() {
        return this._composerAttachments.attachments;
    }

    set _pendingAttachments(attachments) {
        this._composerAttachments.attachments = Array.isArray(attachments) ? attachments : [];
    }

    _buildUi() {
        const headerBar = new Adw.HeaderBar();
        const title = new Adw.WindowTitle({
            title: 'Cusco',
            subtitle: '0 messages',
        });

        this._windowTitle = title;
        headerBar.set_title_widget(title);
        this._chatStatisticsPopover = this._createChatStatisticsPopover();
        this._chatStatisticsPopover.set_parent(title);
        const chatStatisticsMotionController = new Gtk.EventControllerMotion();
        chatStatisticsMotionController.connect(
            'enter',
            () => this._chatStatisticsPopover?.popup(),
        );
        chatStatisticsMotionController.connect(
            'leave',
            () => this._chatStatisticsPopover?.popdown(),
        );
        title.add_controller(chatStatisticsMotionController);
        this._artifactWorkspaceButton = new Gtk.Button({
            icon_name: 'view-grid-symbolic',
            tooltip_text: 'Artifacts',
        });
        this._artifactWorkspaceButton.connect('clicked', () => {
            if (this._artifactSplitView?.get_show_sidebar())
                this._closeArtifactWorkspace();
            else
                this._openArtifactWorkspace();
        });
        headerBar.pack_end(this._artifactWorkspaceButton);

        const split = new Gtk.Paned({
            orientation: Gtk.Orientation.HORIZONTAL,
            wide_handle: false,
            shrink_start_child: false,
            shrink_end_child: false,
            resize_start_child: false,
        });
        this._split = split;
        split.add_css_class('cusco-shell-paned');

        split.set_start_child(this._createSidebar());

        const chatView = new Adw.ToolbarView();
        chatView.add_top_bar(headerBar);
        chatView.set_content(this._createChatSurface());
        this._primaryStack = new Gtk.Stack({
            hexpand: true,
            vexpand: true,
            hhomogeneous: false,
            vhomogeneous: false,
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 160,
        });
        this._primaryStack.add_named(chatView, 'chat');
        this._primaryStack.set_visible_child_name('chat');
        this._artifactWorkspace = createArtifactWorkspace({
            artifactManager: this._artifacts,
            artifactRegistry: this._artifactRenderers,
            parentWindow: this,
            onClose: () => this._closeArtifactWorkspace(),
            onExternalLink: (uri) => this._confirmOpenArtifactLink(uri),
            onOpenImage: (image) => this._openImageViewer(image),
            onArtifactChanged: () => this._syncArtifactWorkspaceButton(),
        });
        this._artifactSplitView = new Adw.OverlaySplitView({
            content: this._primaryStack,
            sidebar: this._artifactWorkspace,
            sidebar_position: Gtk.PackType.END,
            show_sidebar: false,
            pin_sidebar: true,
            enable_show_gesture: true,
            enable_hide_gesture: true,
        });
        this._artifactSplitView.set_min_sidebar_width(360);
        this._artifactSplitView.set_max_sidebar_width(680);
        this._artifactSplitView.set_sidebar_width_fraction(0.38);
        split.set_end_child(this._artifactSplitView);

        this._toastOverlay = new Adw.ToastOverlay({
            child: split,
        });
        this.set_content(this._toastOverlay);
        this._installKeyboardShortcuts();
        this.connect('notify::width', () => this._updateAdaptiveLayout());
        this._applyAccessibilityPreferences();
        this._updateAdaptiveLayout();
    }

    _installKeyboardShortcuts() {
        const keyController = new Gtk.EventControllerKey();

        keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keyController.connect('key-pressed', (_controller, keyval) => {
            if (keyval === Gdk.KEY_Escape
                && this._isConversationUsingComputer(
                    this._conversations.activeConversation?.id,
                )) {
                this._stopComputerUseAndReturn();
                return true;
            }

            if (keyval === Gdk.KEY_Escape && this._activeQuestionSessionForConversation(
                this._conversations.activeConversation?.id,
            )) {
                this._finishAgentQuestions(null);
                return true;
            }

            if (keyval === Gdk.KEY_Escape && this._isComposerSuggestionPanelVisible()) {
                this._dismissComposerSuggestions();
                return true;
            }

            if (keyval === Gdk.KEY_Escape && this._isConversationBusy(
                this._conversations.activeConversation?.id,
            )) {
                this._stopActiveConversation();
                return true;
            }

            if (keyval === Gdk.KEY_Escape && this._artifactSplitView?.get_show_sidebar()) {
                this._closeArtifactWorkspace();
                return true;
            }

            return false;
        });

        this.add_controller(keyController);
    }

    _createSidebar() {
        this._conversationSidebar = createConversationSidebar(this);
        this._sidebar = this._conversationSidebar.widget;
        this._newChatButton = this._conversationSidebar.newChatButton;
        this._sidebarTitle = this._conversationSidebar.title;
        this._mainMenuButton = this._conversationSidebar.mainMenuButton;
        this._chatSearch = this._conversationSidebar.search;
        this._conversationListModel = this._conversationSidebar.listModel;
        this._conversationSelectionModel = this._conversationSidebar.selectionModel;
        this._conversationList = this._conversationSidebar.list;
        this._conversationListScroller = this._conversationSidebar.scroller;
        this._conversationSidebar.setMode(
            this._isCronConversation(this._conversations.activeConversation)
                ? 'automations'
                : 'chats',
            {
                preserveSelection: true,
                selectConversation: false,
            },
        );
        return this._sidebar;
    }

    _showUsagePage() {
        this._ensureUsageSurface();
        this._pluginsPage?.cancelRefresh();

        if (this._primaryStack?.get_visible_child_name() === 'usage')
            return;

        if (this._artifactSplitView?.get_show_sidebar())
            this._closeArtifactWorkspace();

        this._conversationSelectionModel?.unselect_all();
        this._primaryStack?.set_visible_child_name('usage');
        this._refreshUsageDashboard();
    }

    _showPluginsPage() {
        this._ensurePluginsSurface();
        this._usagePage?.cancelRefresh();

        if (this._primaryStack?.get_visible_child_name() === 'plugins')
            return;

        if (this._artifactSplitView?.get_show_sidebar())
            this._closeArtifactWorkspace();

        this._conversationSelectionModel?.unselect_all();
        this._primaryStack?.set_visible_child_name('plugins');
        this._refreshPlugins();
    }

    _showChatPage() {
        this._usagePage?.cancelRefresh();
        this._pluginsPage?.cancelRefresh();

        this._primaryStack?.set_visible_child_name('chat');
    }

    _ensureUsageSurface() {
        if (this._usageSurface)
            return;

        this._usageSurface = this._usagePage.widget;
        this._primaryStack.add_named(this._usageSurface, 'usage');
    }

    _ensurePluginsSurface() {
        if (this._pluginsSurface)
            return;

        this._pluginsSurface = this._pluginsPage.widget;
        this._primaryStack.add_named(this._pluginsSurface, 'plugins');
    }

    _refreshUsageDashboard() {
        this._usagePage.refresh();
    }

    _refreshPlugins() {
        this._pluginsPage.refresh();
    }

    _applyUsageDashboard(usage, options = {}) {
        this._usagePage.applyUsage(usage, options);
    }

    _createChatSurface() {
        this._chatSurfaceBuilder ??= createChatSurfaceBuilder(this);
        return this._chatSurfaceBuilder._createChatSurface();
    }

    _createConversationWithDefaults(options = {}) {
        return this._conversations.createConversation(defaultConversationOptions(
            this._workspace.enabledSkills,
            options,
        ));
    }

    _createNewConversation() {
        this._showChatPage();
        this._conversationSidebar?.setMode('chats', {
            preserveSelection: true,
            selectConversation: false,
        });
        const activeConversation = this._conversations.activeConversation;
        const transientConversation = this._conversations.allConversations.find((conversation) => (
            !conversation.archived
            && this._conversations.isConversationTransient(conversation.id)
        ));

        if (transientConversation) {
            if (transientConversation.id !== activeConversation?.id) {
                this._conversationSelectionSerial += 1;
                this._selectConversation(transientConversation.id);
                this._refreshConversationList();
            }

            this._renderActiveConversation();
            this.focusComposer();
            return;
        }

        const providerId = activeConversation?.providerId;
        const modelId = activeConversation?.modelId;
        const thinkingLevel = activeConversation?.thinkingLevel ?? this._appSettings.thinkingLevel;

        this._conversationSelectionSerial += 1;
        this._prepareComposerForConversationChange();
        const conversation = this._createConversationWithDefaults({
            providerId,
            modelId,
            thinkingLevel,
        });
        this._applyComposerDraft(this._composerDraftsByConversation.get(conversation.id));
        this._refreshConversationList();
        this._renderActiveConversation();
        this.focusComposer();
    }

    createNewConversation() {
        this._createNewConversation();
    }

    showSettings() {
        this._showSettingsDialog();
    }

    focusComposer() {
        this._composer?.grab_focus();
    }

    setComposerText(text) {
        this._setComposerText(text);
        this.focusComposer();
    }

    _getComposerText() {
        if (!this._composerBuffer)
            return '';

        const [start, end] = this._composerBuffer.get_bounds();
        return this._composerBuffer.get_text(start, end, true);
    }

    _setComposerText(text, {
        preserveHistory = false,
        preserveReferences = false,
    } = {}) {
        if (!this._composerBuffer)
            return;

        if (!preserveHistory)
            this._composerInput.resetHistory();

        if (!preserveReferences)
            this._composerReferences = [];

        this._updatingComposerReferences = true;
        this._composerBuffer.set_text(String(text ?? ''), -1);
        const [, end] = this._composerBuffer.get_bounds();
        this._composerBuffer.place_cursor(end);
        this._updatingComposerReferences = false;
        this._syncComposerReferenceTags();
        this._refreshComposerSuggestions();
        this._syncComposerPlaceholder();
    }

    _composerDraftSnapshot() {
        return {
            text: this._getComposerText(),
            references: normalizeComposerReferences(this._getComposerReferences()),
            attachments: this._pendingAttachments.map((attachment) => ({ ...attachment })),
        };
    }

    _applyComposerDraft(draft = null) {
        const normalizedDraft = draft ?? { text: '', references: [], attachments: [] };
        this._pendingAttachments = (normalizedDraft.attachments ?? [])
            .map((attachment) => ({ ...attachment }));
        this._composerReferences = normalizeComposerReferences(normalizedDraft.references);
        this._setComposerText(normalizedDraft.text ?? '', { preserveReferences: true });
        this._updateAttachmentLabel();
    }

    _captureComposerDraft(conversationId) {
        if (!conversationId)
            return;

        const questionSession = this._activeQuestionSessionForConversation(conversationId);
        const draft = questionSession?.uiActive && questionSession.draft
            ? questionSession.draft
            : this._composerDraftSnapshot();
        this._composerDraftsByConversation.set(conversationId, {
            text: draft.text ?? '',
            references: normalizeComposerReferences(draft.references),
            attachments: (draft.attachments ?? []).map((attachment) => ({ ...attachment })),
        });
    }

    _prepareComposerForConversationChange() {
        const conversationId = this._conversations.activeConversation?.id ?? null;

        if (!conversationId)
            return;

        this._captureComposerDraft(conversationId);
        this._deactivateAgentQuestionSessionUi(
            this._activeQuestionSessionForConversation(conversationId),
            { restoreDraft: false },
        );
        this._setFollowLatestMessage(false);
    }

    _selectConversation(conversationId) {
        const activeConversationId = this._conversations.activeConversation?.id ?? null;

        if (!conversationId || conversationId === activeConversationId)
            return this._conversations.activeConversation;

        this._prepareComposerForConversationChange();
        const conversation = this._conversations.selectConversation(conversationId);
        this._applyComposerDraft(this._composerDraftsByConversation.get(conversationId));
        return conversation;
    }

    _requestAgentQuestions(questions, options = {}) {
        this._agentQuestions ??= createAgentQuestionSessions(this);
        this._activeQuestionSessionsByConversation = this._agentQuestions.sessions;
        return this._agentQuestions.request(questions, options);
    }

    _activeQuestionSessionForConversation(conversationId) {
        this._agentQuestions ??= createAgentQuestionSessions(this);
        this._activeQuestionSessionsByConversation = this._agentQuestions.sessions;
        return this._agentQuestions.sessionFor(conversationId);
    }

    _activateAgentQuestionSessionUi(session) {
        this._agentQuestions ??= createAgentQuestionSessions(this);
        this._agentQuestions.activate(session);
    }

    _deactivateAgentQuestionSessionUi(session, options = {}) {
        this._agentQuestions ??= createAgentQuestionSessions(this);
        this._agentQuestions.deactivate(session, options);
    }

    _syncAgentQuestionComposerMode() {
        this._agentQuestions ??= createAgentQuestionSessions(this);
        this._agentQuestions.sync();
    }

    _setQuestionComposerMode(active) {
        this._composerMetaRow?.set_visible(!active);
        this._agentQuestionPanel?.set_visible(active);
        this._composerInlineControls?.set_visible(!active);
        this._composerHint?.set_visible(!active);
        this._attachmentRow?.set_visible(active ? false : this._pendingAttachments.length > 0);
        this._pendingUserMessagesRow?.set_visible(false);
        this._composer?.set_bottom_margin(active ? 8 : 26);
        this._composerScroller?.set_min_content_height(active ? 48 : 88);
        this._composerScroller?.set_max_content_height(active ? 120 : 176);
        this._composerPlaceholder?.set_label(active ? 'Type a custom answer' : 'Message Cusco');

        if (active) {
            this._hideComposerSuggestions();
        } else {
            this._updateAttachmentLabel();
            this._renderPendingUserMessages();
            this._syncComposerHint(this._isConversationBusy(
                this._conversations.activeConversation?.id,
            ));
        }

        this._syncComposerPlaceholder();
    }

    _syncAgentQuestionProgress() {
        const session = this._activeQuestionSessionForConversation(
            this._conversations.activeConversation?.id,
        );

        if (!session)
            return;

        const progress = session.questions.length > 1
            ? `${session.index + 1} of ${session.questions.length}`
            : '';
        const escapeAction = this._isConversationUsingComputer(session.conversationId)
            ? 'Esc to stop computer use'
            : 'Esc to skip';

        this._agentQuestionProgress.set_label(
            [progress, escapeAction].filter(Boolean).join(' · '),
        );
    }

    _showActiveAgentQuestion() {
        const session = this._activeQuestionSessionForConversation(
            this._conversations.activeConversation?.id,
        );
        const question = session?.questions?.[session.index];

        if (!session || !question)
            return;

        this._agentQuestionHeader.set_label(question.header || 'Question');
        this._agentQuestionPrompt.set_label(question.question);
        this._syncAgentQuestionProgress();
        this._clearBox(this._agentQuestionOptions);

        for (const option of question.options) {
            const button = new Gtk.Button({
                tooltip_text: option.description || option.label,
                halign: Gtk.Align.FILL,
                hexpand: true,
            });
            const content = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 1,
                hexpand: true,
            });
            const label = new Gtk.Label({
                label: option.label,
                xalign: 0,
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
            });
            label.add_css_class('cusco-agent-question-option-title');
            content.append(label);

            if (option.description) {
                const description = new Gtk.Label({
                    label: option.description,
                    xalign: 0,
                    wrap: true,
                    wrap_mode: Pango.WrapMode.WORD_CHAR,
                });
                description.add_css_class('caption');
                description.add_css_class('dim-label');
                content.append(description);
            }

            button.set_child(content);
            button.add_css_class('cusco-agent-question-option');
            button.connect('clicked', () => this._submitAgentQuestionAnswer(option.value));
            this._agentQuestionOptions.append(button);
        }

        this._agentQuestionOptions.set_visible(question.options.length > 0);
        this.focusComposer();
    }

    _submitAgentQuestionAnswer(answer) {
        this._agentQuestions ??= createAgentQuestionSessions(this);
        return this._agentQuestions.submit(answer);
    }

    _finishAgentQuestions(answers, options = {}) {
        this._agentQuestions ??= createAgentQuestionSessions(this);
        return this._agentQuestions.finish(answers, options);
    }

    _createComposerSuggestionPanel() {
        return this._composerSuggestions.createPanel();
    }

    _syncComposerReferenceTagStyles() {
        if (!this._composerReferenceTags)
            return;

        const palette = this._composerReferenceStyles();

        for (const [kind, tag] of this._composerReferenceTags) {
            tag.set_property('background', palette[kind].background);
            tag.set_property('foreground', palette[kind].foreground);
        }
    }

    _composerReferenceStyles() {
        return Adw.StyleManager.get_default().get_dark()
            ? COMPOSER_REFERENCE_STYLES.dark
            : COMPOSER_REFERENCE_STYLES.light;
    }

    _syncUserMessageReferenceStyles() {
        const palette = this._composerReferenceStyles();

        for (const content of this._userMessageReferenceContents) {
            if (!content.get_parent()) {
                this._userMessageReferenceContents.delete(content);
                continue;
            }

            content.updateReferenceStyles?.(palette);
        }

        this._renderPendingUserMessages();
    }

    _getComposerReferences() {
        const text = this._getComposerText();
        this._composerReferences = this._composerReferences.filter((reference) => (
            reference.insertText && text.includes(reference.insertText)
        ));
        return this._composerReferences.map((reference) => ({ ...reference }));
    }

    _syncComposerReferenceTags() {
        if (!this._composerBuffer || !this._composerReferenceTags)
            return;

        const [start, end] = this._composerBuffer.get_bounds();

        for (const tag of this._composerReferenceTags.values())
            this._composerBuffer.remove_tag(tag, start, end);

        const text = this._getComposerText();
        const references = this._getComposerReferences();

        for (const range of composerReferenceRanges(text, references)) {
            const tag = this._composerReferenceTags.get(range.reference.kind);

            if (!tag)
                continue;

            this._composerBuffer.apply_tag(
                tag,
                this._composerBuffer.get_iter_at_offset(range.startOffset),
                this._composerBuffer.get_iter_at_offset(range.endOffset),
            );
        }
    }

    _skillSuggestionItems() {
        return this._composerSuggestions._skillItems();
    }

    _artifactSuggestionItems() {
        return this._composerSuggestions._artifactItems();
    }

    _itemsForComposerTrigger(trigger) {
        return this._composerSuggestions._itemsForTrigger(trigger);
    }

    _composerTriggerKey(trigger) {
        return this._composerSuggestions._triggerKey(trigger);
    }

    _scheduleComposerSuggestionRefresh() {
        this._composerSuggestions.scheduleRefresh();
    }

    _refreshComposerSuggestions() {
        this._composerSuggestions.refresh();
    }

    _renderComposerSuggestions() {
        this._composerSuggestions._render();
    }

    _isComposerSuggestionPanelVisible() {
        return this._composerSuggestions.isVisible();
    }

    _hideComposerSuggestions() {
        this._composerSuggestions.hide();
    }

    _dismissComposerSuggestions() {
        this._composerSuggestions.dismiss();
    }

    _handleComposerSuggestionKey(keyval) {
        return this._composerSuggestions.handleKey(keyval);
    }

    _insertComposerSuggestion(suggestion) {
        this._composerSuggestions.insert(suggestion);
    }

    _deleteComposerReferenceAtCursor(keyval) {
        return this._composerSuggestions.deleteReferenceAtCursor(keyval);
    }

    _handleComposerReadlineKey(keyval, state) {
        this._composerInput ??= createComposerInputController(this);
        const handled = this._composerInput.handleReadlineKey(keyval, state);
        this._composerReadlineKillText = this._composerInput.killText;
        return handled;
    }

    _handleComposerHistoryKey(keyval, state) {
        this._composerInput ??= createComposerInputController(this);
        return this._composerInput.handleHistoryKey(keyval, state);
    }

    _navigateComposerHistory(direction) {
        this._composerInput ??= createComposerInputController(this);
        return this._composerInput.navigateHistory(direction);
    }

    _syncComposerPlaceholder() {
        if (!this._composerPlaceholder || !this._composerBuffer)
            return;

        this._composerPlaceholder.set_visible(this._composerBuffer.get_char_count() === 0);
    }

    _getUsageMessages(conversation, options = {}) {
        this._composerUsage ??= createComposerUsageController(this);
        return this._composerUsage._getUsageMessages(conversation, options);
    }

    _getContextWindowTokens(conversation) {
        this._composerUsage ??= createComposerUsageController(this);
        return this._composerUsage._getContextWindowTokens(conversation);
    }

    _createComposerUsagePopover() {
        this._composerUsage ??= createComposerUsageController(this);
        return this._composerUsage._createComposerUsagePopover();
    }

    _createChatStatisticsPopover() {
        this._composerUsage ??= createComposerUsageController(this);
        return this._composerUsage._createChatStatisticsPopover();
    }

    _syncChatStatisticsPopover(conversation) {
        this._composerUsage ??= createComposerUsageController(this);
        return this._composerUsage._syncChatStatisticsPopover(conversation);
    }

    _syncComposerUsageChart(baseUsage = null, conversation = this._conversations.activeConversation) {
        this._composerUsage ??= createComposerUsageController(this);
        return this._composerUsage._syncComposerUsageChart(baseUsage, conversation);
    }

    _scheduleComposerUsageChartSync() {
        this._composerUsage ??= createComposerUsageController(this);
        return this._composerUsage._scheduleComposerUsageChartSync();
    }

    _syncComposerHint(
        isBusy = false,
        computerUseActive = this._isConversationUsingComputer(
            this._conversations.activeConversation?.id,
        ),
    ) {
        this._composerUsage ??= createComposerUsageController(this);
        return this._composerUsage._syncComposerHint(isBusy, computerUseActive);
    }

    _createPendingUserMessagesRow() {
        this._pendingMessages ??= createPendingMessagesController(this);
        return this._pendingMessages._createPendingUserMessagesRow();
    }

    _pendingConversationId() {
        this._pendingMessages ??= createPendingMessagesController(this);
        return this._pendingMessages._pendingConversationId();
    }

    _getPendingUserMessages(conversationId) {
        this._pendingMessages ??= createPendingMessagesController(this);
        return this._pendingMessages._getPendingUserMessages(conversationId);
    }

    _enqueuePendingUserMessage(text, references = [], conversationId = this._pendingConversationId()) {
        this._pendingMessages ??= createPendingMessagesController(this);
        return this._pendingMessages._enqueuePendingUserMessage(text, references, conversationId);
    }

    _enqueuePendingUserMessageWithHooks(
        text,
        references = [],
        conversationId = this._pendingConversationId(),
    ) {
        this._pendingMessages ??= createPendingMessagesController(this);
        return this._pendingMessages._enqueuePendingUserMessageWithHooks(
            text,
            references,
            conversationId,
        );
    }

    _removePendingUserMessage(conversationId, messageId) {
        this._pendingMessages ??= createPendingMessagesController(this);
        return this._pendingMessages._removePendingUserMessage(conversationId, messageId);
    }

    _createPendingUserMessageCard(message) {
        this._pendingMessages ??= createPendingMessagesController(this);
        return this._pendingMessages._createPendingUserMessageCard(message);
    }

    _renderPendingUserMessages(conversation = this._conversations.activeConversation) {
        this._pendingMessages ??= createPendingMessagesController(this);
        return this._pendingMessages._renderPendingUserMessages(conversation);
    }

    selectConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        this._showChatPage();
        this._conversationSidebar?.setMode(
            this._isCronConversation(conversation) ? 'automations' : 'chats',
            {
                preserveSelection: true,
                selectConversation: false,
            },
        );
        this._conversationSelectionSerial += 1;
        this._selectConversation(conversationId);
        this._refreshConversationList();
        this._renderActiveConversation({ deferIfUncached: true });
        this.present();
    }

    showCommandPalette() {
        const dialog = new Adw.AlertDialog({
            heading: 'Command Palette',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('new-chat', 'New Chat');
        dialog.add_response('preferences', 'Preferences');
        dialog.add_response('focus-composer', 'Focus Composer');
        dialog.set_default_response('focus-composer');
        dialog.set_close_response('cancel');
        dialog.choose(this, null, (_dialog, result) => {
            switch (dialog.choose_finish(result)) {
            case 'new-chat':
                this._createNewConversation();
                break;
            case 'preferences':
                this._showSettingsDialog();
                break;
            case 'focus-composer':
                this.focusComposer();
                break;
            default:
                break;
            }
        });
    }

    _showSettingsDialog(options = {}) {
        presentProviderSettingsDialog(
            this,
            this._providerConfigs,
            this._appSettings,
            this._memories,
            this._workspace,
            this._mcp,
            (change) => this._handleProviderSettingsChanged(change),
            {
                ...options,
                computerUse: this._computerUse,
                hookManager: this._hooks,
                conversation: this._conversations.activeConversation,
                conversationManager: this._conversations,
                onWorkingDirectoryChanged: (conversation) => {
                    this._sessionHookContexts.delete(conversation.id);
                },
                archivedChatCount: this._conversations.archivedConversations.length,
                onOpenArchivedChats: (parent, onCountChanged) => (
                    this._showArchivedChatsWindow(parent, onCountChanged)
                ),
            },
        );
    }

    _showArchivedChatsWindow(parent = this, onCountChanged = () => {}) {
        presentArchivedChatsWindow(parent, this._conversations, () => {
            if (this._conversations.conversations.length === 0)
                this._createConversationWithDefaults();

            this._refreshConversationList();
            this._renderActiveConversation();
            onCountChanged(this._conversations.archivedConversations.length);
        });
    }

    _syncComputerUseTools() {
        this._tools.clearRegisteredTools((tool) => tool.name.startsWith('computer_'));

        if (!this._appSettings.computerUseEnabled)
            return;

        for (const tool of createComputerUseTools(this._computerUse))
            this._tools.registerTool(tool);
    }

    _syncComputerUseStatus(active) {
        const conversationId = this._conversations.activeConversation?.id;
        const isBusy = this._isConversationBusy(conversationId);
        this._syncComposerHint(
            isBusy,
            Boolean(active) && this._isConversationUsingComputer(conversationId),
        );
        this._syncAgentQuestionProgress();
    }

    _stopComputerUseAndReturn() {
        const ownerCancellable = this._computerUse.activeTurnCancellable;
        const stoppedComputerUse = this._computerUse.stop();
        const stoppedConversation = Boolean(
            ownerCancellable && this._activeTurnEntryForCancellable(ownerCancellable),
        );

        this.present();
        this.focusComposer();

        if (stoppedComputerUse || stoppedConversation)
            this._showToast('Computer use stopped.');
    }

    _showToast(title) {
        if (!this._toastOverlay)
            return;

        this._toastOverlay.add_toast(new Adw.Toast({
            title,
        }));
    }

    _syncArtifactWorkspaceButton() {
        if (!this._artifactWorkspaceButton)
            return;

        const conversationId = this._conversations.activeConversation?.id ?? '';
        const artifactCount = this._artifacts.listArtifacts({
            conversationId,
            includeArchived: true,
        }).length;

        this._artifactWorkspaceButton.set_sensitive(artifactCount > 0);
        this._artifactWorkspaceButton.set_tooltip_text(
            artifactCount > 0
                ? `Artifacts (${artifactCount})`
                : 'No artifacts in this chat',
        );
    }

    _openArtifactWorkspace(reference = null) {
        if (!this._artifactWorkspace || !this._artifactSplitView)
            return false;

        const conversationId = this._conversations.activeConversation?.id ?? '';
        this._artifactWorkspace.setConversation(conversationId);
        let selectedReference = reference;

        if (!selectedReference) {
            const artifact = this._artifacts.listArtifacts({
                conversationId,
                includeArchived: true,
            })[0];
            selectedReference = artifact
                ? {
                    artifactId: artifact.id,
                    revisionId: artifact.currentRevisionId,
                    title: artifact.title,
                    kind: artifact.kind,
                    format: artifact.format,
                    mimeType: artifact.mimeType,
                    preferredPresentation: artifact.preferredPresentation,
                }
                : null;
        }

        if (!selectedReference) {
            this._showToast('This chat does not have any artifacts yet.');
            return false;
        }

        if (!this._artifactWorkspace.openReference(selectedReference)) {
            this._showToast('That artifact revision is unavailable.');
            return false;
        }

        this._artifactSplitView.set_show_sidebar(true);
        return true;
    }

    _closeArtifactWorkspace() {
        this._artifactSplitView?.set_show_sidebar(false);
    }

    _exportArtifact(reference) {
        if (!this._openArtifactWorkspace(reference))
            return;

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._artifactWorkspace?.exportActiveArtifact?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    _confirmOpenArtifactLink(uri) {
        const normalizedUri = String(uri ?? '').trim();

        if (!/^https?:\/\//i.test(normalizedUri))
            return;

        const dialog = new Adw.AlertDialog({
            heading: 'Open external link?',
            body: normalizedUri,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('open', 'Open');
        dialog.set_default_response('open');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('open', Adw.ResponseAppearance.SUGGESTED);
        dialog.choose(this, null, (_dialog, result) => {
            try {
                if (dialog.choose_finish(result) === 'open')
                    Gtk.show_uri(this, normalizedUri, 0);
            } catch (error) {
                logError(error, 'Failed to resolve external artifact link dialog');
            }
        });
    }

    _automationRecordForConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation || !this._isCronConversation(conversation))
            return null;

        const job = this._cronConversationSync?.getJob(conversation.cronJobId) ?? null;
        return job ? { conversation, job } : null;
    }

    _selectAutomationConversation(jobId) {
        const conversation = this._findCronConversation(jobId);

        if (!conversation)
            return false;

        this._showChatPage();
        this._conversationSidebar?.setMode('automations', {
            preserveSelection: true,
            selectConversation: false,
        });
        this._conversationSelectionSerial += 1;
        this._selectConversation(conversation.id);
        this._refreshConversationList({ resetPage: true });
        this._renderActiveConversation({ deferIfUncached: true });
        return true;
    }

    _presentNewAutomationDialog() {
        presentAutomationDialog(this, {
            onSave: async (input) => {
                const job = await this._cron.createJob(input);
                await this._handleCronJobChanged(job);
                this._selectAutomationConversation(job.id);
                this._showToast('Automation created');
            },
        });
    }

    _presentEditAutomationDialog(conversationId) {
        const record = this._automationRecordForConversation(conversationId);

        if (!record?.job?.prompt) {
            this._showToast('This legacy command job cannot be edited as an automation.');
            return;
        }

        presentAutomationDialog(this, {
            job: record.job,
            onSave: async (input) => {
                const job = await this._cron.updateJob(record.job.id, input);
                await this._handleCronJobChanged(job);
                this._selectAutomationConversation(job.id);
                this._showToast('Automation updated');
            },
        });
    }

    _toggleAutomationConversation(conversationId) {
        const record = this._automationRecordForConversation(conversationId);

        if (!record)
            return;

        this._cron.setJobEnabled(record.job.id, !record.job.enabled).then(async (job) => {
            await this._handleCronJobChanged(job);
            this._showToast(job.enabled ? 'Automation resumed' : 'Automation paused');
        }).catch((error) => {
            logError(error, 'Failed to change automation status');
            this._appendSystemError(error.userMessage ?? error.message, conversationId);
        });
    }

    _runAutomationConversation(conversationId) {
        const record = this._automationRecordForConversation(conversationId);

        if (!record)
            return;

        this._showToast('Automation started');
        this._executeAutomation(record.job.id, {
            allowPaused: true,
            waitForQueued: false,
        }).then((result) => {
            if (result.queued)
                this._showToast('Automation queued');
            else
                this._showToast('Automation finished');
        }).catch((error) => {
            logError(error, 'Failed to run automation');
            this._showToast(error.userMessage ?? error.message);
        });
    }

    _waitForAutomationMessage(conversationId, messageId) {
        return new Promise((resolve) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                const stillQueued = this._getPendingUserMessages(conversationId)
                    .some((message) => message.id === messageId);

                if (stillQueued || this._isConversationBusy(conversationId))
                    return GLib.SOURCE_CONTINUE;

                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    async _executeAutomation(jobId, options = {}) {
        this._cronConversationSync ??= createCronConversationSync(this);
        const status = await this._cronConversationSync.sync({ refreshUi: true });

        if (!status.available)
            throw automationError(status.error || 'Automations are unavailable.');

        const job = status.jobs.find((item) => item.id === jobId);

        if (!job)
            throw automationError(`Automation does not exist: ${jobId}`);
        if (!job.prompt)
            throw automationError('This scheduled job does not contain an AI prompt.');
        if (!job.enabled && !options.allowPaused)
            throw automationError(`Automation is paused: ${job.title}`);

        const { conversation } = this._cronConversationSync.ensureConversation(job);
        const pendingMessage = this._enqueuePendingUserMessage(job.prompt, [], conversation.id);

        if (!pendingMessage)
            throw automationError('The automation prompt could not be queued.');

        if (this._isConversationBusy(conversation.id)) {
            this._schedulePendingConversationSend();

            if (options.waitForQueued !== false)
                await this._waitForAutomationMessage(conversation.id, pendingMessage.id);

            return { conversationId: conversation.id, queued: true };
        }

        try {
            const sent = await this._sendQueuedUserMessages(conversation.id);

            if (!sent)
                throw automationError('The automation could not start with the selected provider.');

            return { conversationId: conversation.id, queued: false };
        } catch (error) {
            const pending = this._getPendingUserMessages(conversation.id)
                .filter((message) => message.id !== pendingMessage.id);

            if (pending.length > 0)
                this._pendingUserMessagesByConversation.set(conversation.id, pending);
            else
                this._pendingUserMessagesByConversation.delete(conversation.id);

            this._renderPendingUserMessages();
            this._appendSystemError(
                `Automation failed: ${error.userMessage ?? error.message}`,
                conversation.id,
            );
            throw error;
        }
    }

    async runAutomation(jobId) {
        return await this._executeAutomation(String(jobId ?? '').trim());
    }

    async _handleCronJobChanged(_job) {
        this._cronConversationSync ??= createCronConversationSync(this);
        await this._cronConversationSync.sync({ refreshUi: true });
        this._refreshConversationList();
    }

    _startCronLogSync() {
        this._cronConversationSync ??= createCronConversationSync(this);
        this._cronConversationSync.start();
    }

    _stopCronLogSync() {
        this._cronConversationSync ??= createCronConversationSync(this);
        this._cronConversationSync.stop();
    }

    async _syncCronJobsWithConversations(options = {}) {
        this._cronConversationSync ??= createCronConversationSync(this);
        return await this._cronConversationSync.sync(options);
    }

    _ensureCronConversation(job) {
        this._cronConversationSync ??= createCronConversationSync(this);
        return this._cronConversationSync.ensureConversation(job);
    }

    _findCronConversation(jobId) {
        this._cronConversationSync ??= createCronConversationSync(this);
        return this._cronConversationSync.findConversation(jobId);
    }

    _deleteCronConversation(jobId) {
        this._cronConversationSync ??= createCronConversationSync(this);
        this._cronConversationSync.deleteConversation(jobId);

        if (this._conversationSidebar?.mode === 'automations')
            this._conversationSidebar.setMode('automations');
    }

    _appendCronRunLogs(job, conversation) {
        return this._cronConversationSync.appendRunLogs(job, conversation);
    }

    _formatCronJobCreatedMessage(job) {
        return this._cronConversationSync.formatJobCreatedMessage(job);
    }

    _formatCronRunMessage(job, run) {
        return this._cronConversationSync.formatRunMessage(job, run);
    }

    _streamPresentationPreferences() {
        return {
            streamAnimationStyle: () => this._appSettings.streamAnimationStyle,
            motionEnabled: () => (
                !this._appSettings.reducedMotionEnabled
                && Adw.get_enable_animations(this)
            ),
        };
    }

    _refreshStreamPresentationPreferences() {
        const views = new Set([this._lastAssistantMessageView]);

        for (const entry of this._conversationViewCache.values())
            views.add(entry.lastAssistantMessageView);

        const preferences = this._streamPresentationPreferences();

        for (const view of views)
            view?.set_stream_preferences?.(preferences);
    }

    _handleProviderSettingsChanged(change = {}) {
        if (change?.errorMessage)
            this._showToast(change.errorMessage);

        this._mcp.reloadConfig();
        if (change?.computerUseChanged)
            this._syncComputerUseTools();
        const conversation = this._conversations.activeConversation;

        if (conversation && !this._providerConfigs.isProviderAvailable(conversation.providerId)) {
            const defaultProvider = this._providerConfigs.getDefaultProvider();
            const defaultModel = defaultProvider ? this._providerConfigs.getDefaultModel(defaultProvider.id) : null;
            this._conversations.updateProviderConfig(conversation.id, {
                providerId: defaultProvider?.id ?? '',
                modelId: defaultModel?.id ?? '',
            });

            if (defaultProvider)
                this._providerConfigs.setActiveSelection(defaultProvider.id, defaultModel?.id ?? '');
            else
                this._providerConfigs.setActiveSelection('', '');
        }

        this._populateProviderPicker();
        this._syncProviderControls(this._conversations.activeConversation);
        this._refreshPromptMenu();
        this._syncComposerHint();
        this._applyAccessibilityPreferences();
        this._refreshStreamPresentationPreferences();
        this._refreshConversationList();

        if (change?.codeThemeChanged)
            this._renderActiveConversation();

        if (change?.emptyChatImageChanged)
            this._updateEmptyConversationImage();
    }

    _ensureConversationProviderAvailable(conversation) {
        if (this._providerConfigs.isProviderAvailable(conversation.providerId))
            return true;

        const defaultProvider = this._providerConfigs.getDefaultProvider();
        const defaultModel = defaultProvider ? this._providerConfigs.getDefaultModel(defaultProvider.id) : null;

        if (!defaultProvider) {
            const message = createMessage('system', 'Configure an AI provider in Settings before sending.');

            this._conversations.appendMessage(conversation.id, message);
            this._addMessageIfActiveConversation(conversation.id, message);
            this._updateUsageDisplay(conversation);

            if (this._isActiveConversationId(conversation.id))
                this._showSettingsDialog({ initialPage: 'providers' });
            else
                this._showToast('Configure an AI provider in Settings before sending.');

            return false;
        }

        this._conversations.updateProviderConfig(conversation.id, {
            providerId: defaultProvider.id,
            modelId: defaultModel?.id ?? '',
        });
        this._providerConfigs.setActiveSelection(defaultProvider.id, defaultModel?.id ?? '');

        if (this._isActiveConversationId(conversation.id))
            this._syncProviderControls(conversation);

        return true;
    }

    _drainPendingUserMessages(conversationId) {
        this._turnSubmission ??= createTurnSubmission(this);
        return this._turnSubmission._drainPendingUserMessages(conversationId);
    }

    _drainPendingUserMessagesForRuntime(conversation, runtimeMessages) {
        this._turnSubmission ??= createTurnSubmission(this);
        return this._turnSubmission._drainPendingUserMessagesForRuntime(
            conversation,
            runtimeMessages,
        );
    }

    _handleQueuedUserMessageError(error, conversationId = null) {
        this._turnSubmission ??= createTurnSubmission(this);
        return this._turnSubmission._handleQueuedUserMessageError(error, conversationId);
    }

    _preparePendingUserMessageHooks(conversation, cancellable) {
        this._turnSubmission ??= createTurnSubmission(this);
        return this._turnSubmission._preparePendingUserMessageHooks(conversation, cancellable);
    }

    _sendQueuedUserMessages(conversationId) {
        this._turnSubmission ??= createTurnSubmission(this);
        return this._turnSubmission._sendQueuedUserMessages(conversationId);
    }

    _schedulePendingConversationSend() {
        this._turnSubmission ??= createTurnSubmission(this);
        return this._turnSubmission._schedulePendingConversationSend();
    }

    _sendMessage(text, references = [], pendingAttachments = []) {
        this._turnSubmission ??= createTurnSubmission(this);
        return this._turnSubmission._sendMessage(text, references, pendingAttachments);
    }

    _turnHookContext(conversation) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._turnHookContext(conversation);
    }

    _appendHookNotice(conversation, text) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._appendHookNotice(conversation, text);
    }

    _applyHookResult(conversation, result, options = {}) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._applyHookResult(conversation, result, options);
    }

    _ensureTurnSessionHooks(conversation, cancellable) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._ensureTurnSessionHooks(conversation, cancellable);
    }

    _runUserPromptHooks(conversation, prompt, cancellable) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._runUserPromptHooks(conversation, prompt, cancellable);
    }

    _hookToolInput(request, options = {}) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._hookToolInput(request, options);
    }

    _requestWithHookInput(request, updatedInput) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._requestWithHookInput(request, updatedInput);
    }

    _authorizeToolRequestWithHooks(request, conversation, cancellable) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._authorizeToolRequestWithHooks(
            request,
            conversation,
            cancellable,
        );
    }

    _runPostToolUseHooks(request, conversation, toolResponse, cancellable) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._runPostToolUseHooks(
            request,
            conversation,
            toolResponse,
            cancellable,
        );
    }

    _setToolHookProviderOverride(conversationId, runningTool, postHookResult) {
        this._hookCoordinator ??= createHookCoordinator(this);
        return this._hookCoordinator._setToolHookProviderOverride(
            conversationId,
            runningTool,
            postHookResult,
        );
    }

    _runRequestedTool(text, conversationId, cancellable = null) {
        this._requestedToolRunner ??= createRequestedToolRunner(this);
        return this._requestedToolRunner._runRequestedTool(text, conversationId, cancellable);
    }

    _appendRunningToolMessage(conversationId, request, options = {}) {
        this._requestedToolRunner ??= createRequestedToolRunner(this);
        return this._requestedToolRunner._appendRunningToolMessage(
            conversationId,
            request,
            options,
        );
    }

    _appendToolOutputChunk(runningTool, chunk) {
        this._requestedToolRunner ??= createRequestedToolRunner(this);
        return this._requestedToolRunner._appendToolOutputChunk(runningTool, chunk);
    }

    _updateRunningToolMessage(conversationId, runningTool, content, toolCall) {
        this._requestedToolRunner ??= createRequestedToolRunner(this);
        return this._requestedToolRunner._updateRunningToolMessage(
            conversationId,
            runningTool,
            content,
            toolCall,
        );
    }

    _completeRunningToolMessage(conversationId, runningTool, result, status, options = {}) {
        this._requestedToolRunner ??= createRequestedToolRunner(this);
        return this._requestedToolRunner._completeRunningToolMessage(
            conversationId,
            runningTool,
            result,
            status,
            options,
        );
    }

    _completeRunningToolFailure(
        conversationId,
        runningTool,
        request,
        reason,
        status = 'failed',
        options = {},
    ) {
        this._requestedToolRunner ??= createRequestedToolRunner(this);
        return this._requestedToolRunner._completeRunningToolFailure(
            conversationId,
            runningTool,
            request,
            reason,
            status,
            options,
        );
    }

    _confirmToolPermission(request, cancellable = null) {
        this._requestedToolRunner ??= createRequestedToolRunner(this);
        return this._requestedToolRunner._confirmToolPermission(request, cancellable);
    }

    _promptSudoPassword(command, cancellable = null) {
        this._requestedToolRunner ??= createRequestedToolRunner(this);
        return this._requestedToolRunner._promptSudoPassword(command, cancellable);
    }

    _activeProviderSupportsImageAttachments() {
        return this._composerAttachments.supportsImages();
    }

    _imageAttachCapability() {
        return this._composerAttachments.imageAttachCapability();
    }

    _openImageViewer(image) {
        return this._composerAttachments.openImageViewer(image);
    }

    _attachEditedImageToComposer(path, attachmentToReplace = null) {
        return this._composerAttachments.attachEditedImage(path, attachmentToReplace);
    }

    _activeImageAttachmentUnsupportedMessage() {
        return this._composerAttachments.unsupportedMessage();
    }

    _pasteClipboardContentIfAvailable() {
        return this._composerAttachments.pasteClipboardContent();
    }

    _pasteClipboardImageIfAvailable() {
        return this._composerAttachments.pasteClipboardImage();
    }

    _pasteClipboardTextIfAvailable() {
        return this._composerAttachments.pasteClipboardText();
    }

    _handlePastedText(text) {
        return this._composerAttachments.handlePastedText(text);
    }

    _insertPastedComposerText(text) {
        this._composerAttachments.insertPastedText(text);
    }

    _attachFileContext() {
        this._composerAttachments.attachFile();
    }

    _createAttachmentFromPath(path) {
        return this._composerAttachments.createAttachmentFromPath(path);
    }

    _createAttachmentsForComposerReferences(references, existingAttachments = []) {
        return this._composerAttachments.createAttachmentsForReferences(
            references,
            existingAttachments,
        );
    }

    _consumePendingAttachments() {
        return this._composerAttachments.consume();
    }

    _discardPendingImageAttachmentsIfUnsupportedProvider() {
        this._composerAttachments.discardUnsupportedImages();
    }

    _removePendingAttachment(index) {
        this._composerAttachments.remove(index);
    }

    _updateAttachmentLabel() {
        this._composerAttachments.updatePreview();
    }

    _createPendingAttachmentPreview(attachment, index) {
        return this._composerAttachments.createPendingPreview(attachment, index);
    }

    _createAttachmentPreviewCard(attachment, options = {}) {
        return this._composerAttachments.createPreviewCard(attachment, options);
    }

    _formatUserMessageContent(text, attachments) {
        return this._composerAttachments.formatUserMessageContent(text, attachments);
    }

    _finalizeCancelledAssistantResponse(conversation, assistantView) {
        this._assistantStreamRunner ??= createAssistantStreamRunner(this);
        return this._assistantStreamRunner._finalizeCancelledAssistantResponse(
            conversation,
            assistantView,
        );
    }

    _streamAssistantResponse(conversationId, options = {}) {
        this._assistantStreamRunner ??= createAssistantStreamRunner(this);
        return this._assistantStreamRunner._streamAssistantResponse(conversationId, options);
    }

    async _collectProviderResponse(providerId, modelId, providerMessages, cancellable, onChunk = null, collectOptions = {}) {
        return await collectProviderResponse({
            providerConfigs: this._providerConfigs,
            appSettings: this._appSettings,
            conversations: this._conversations,
            resolveSelectionThinkingLevel: (selectedProviderId, selectedModelId, level) => (
                this._resolveThinkingLevelForSelection(selectedProviderId, selectedModelId, level)
            ),
        }, providerId, modelId, providerMessages, cancellable, onChunk, collectOptions);
    }

    async _collectProviderResponseWithFallback(conversation, providerMessages, cancellable, onChunk = null, collectOptions = {}) {
        return await collectProviderResponseWithFallback({
            collect: (...args) => this._collectProviderResponse(...args),
            getFallback: (providerId, error) => this._getProviderFallback(providerId, error),
            conversations: this._conversations,
            isActiveConversation: (conversationId) => this._isActiveConversationId(conversationId),
            onFallbackSelected: (selectedConversation, isActive) => {
                if (isActive)
                    this._syncProviderControls(selectedConversation);
                this._refreshConversationList();
            },
        }, conversation, providerMessages, cancellable, onChunk, collectOptions);
    }

    _createAgentReasoningPayload(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return this._agentRuntime._createAgentReasoningPayload(...args);
    }

    _appendOrUpdateAgentReasoningSegment(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return this._agentRuntime._appendOrUpdateAgentReasoningSegment(...args);
    }

    async _runAgentModeResponse(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return await this._agentRuntime._runAgentModeResponse(...args);
    }

    _updateAgentModeAssistantView(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return this._agentRuntime._updateAgentModeAssistantView(...args);
    }

    _parseAgentToolCallForRuntime(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return this._agentRuntime._parseAgentToolCallForRuntime(...args);
    }

    _createAgentToolRequest(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return this._agentRuntime._createAgentToolRequest(...args);
    }

    async _runAgentToolRequest(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return await this._agentRuntime._runAgentToolRequest(...args);
    }

    _appendProviderSearchResults(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return this._agentRuntime._appendProviderSearchResults(...args);
    }

    _appendAgentToolCancellation(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return this._agentRuntime._appendAgentToolCancellation(...args);
    }

    _appendAgentToolFailure(...args) {
        this._agentRuntime ??= createAgentRuntime(this);
        return this._agentRuntime._appendAgentToolFailure(...args);
    }

    _beginActiveTurn(conversationId = null, cancellable = null, options = {}) {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.begin(conversationId, cancellable, options);
    }

    _finishActiveTurn(cancellable, options = {}) {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.finish(cancellable, {
            ...options,
            hasConversationStack: Boolean(this._conversationStack),
        });
    }

    _stopActiveConversation() {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.stopActive();
    }

    _stopConversation(conversationId) {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.stop(conversationId);
    }

    _stopAllConversations() {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.stopAll();
    }

    _activeTurnEntryForCancellable(cancellable) {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.entryForCancellable(cancellable);
    }

    _activeTurnHookContexts(conversationId) {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.hookContexts(conversationId);
    }

    _isActiveConversationId(conversationId) {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.isActiveConversation(conversationId);
    }

    _isConversationBusy(conversationId) {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.isBusy(conversationId);
    }

    _isConversationUsingComputer(conversationId) {
        this._turnCoordinator ??= createTurnCoordinator(this);
        return this._turnCoordinator.isUsingComputer(conversationId);
    }

    _addMessageIfActiveConversation(conversationId, message, options = {}) {
        if (!this._isActiveConversationId(conversationId))
            return null;

        return this._addMessage(message.content, message.role, message, options);
    }

    _appendStoppedMessage(conversationId, text) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return null;

        const message = createMessage('system', text);
        this._conversations.appendMessage(conversation.id, message);
        this._addMessageIfActiveConversation(conversation.id, message);
        this._updateUsageDisplay(conversation);
        this._refreshConversationList();
        return message;
    }

    _appendToolCancellation(conversationId, request) {
        const reason = `${request.label} was stopped before it finished.`;
        const message = createMessage('system', reason, {
            toolCall: {
                name: request.name,
                label: request.label,
                input: request.input,
                output: reason,
                results: [],
                status: 'cancelled',
                createdAt: new Date().toISOString(),
            },
        });

        this._conversations.appendMessage(conversationId, message);
        this._addMessageIfActiveConversation(conversationId, message);
        this._updateUsageDisplay(this._conversations.getConversation(conversationId));
        return message;
    }

    _manageArtifactList(artifacts, conversationId) {
        return (Array.isArray(artifacts) ? artifacts : []).map((artifact) => {
            if (artifact?.artifactId && artifact?.revisionId)
                return artifact;

            try {
                return this._artifacts.importLegacyArtifact(artifact, {
                    originConversationId: conversationId,
                }) ?? artifact;
            } catch (error) {
                logError(error, 'Failed to import a legacy artifact');
                return artifact;
            }
        });
    }

    _migrateLegacyArtifacts(conversation = this._conversations.activeConversation) {
        if (!conversation || this._legacyArtifactMigrationIds.has(conversation.id))
            return;

        const messages = conversation.messages;

        if (!this._conversations.isConversationHydrated(conversation.id)) {
            if (this._toastOverlay
                && this._conversations.conversationLoadError(conversation.id)
                && !this._conversationLoadErrorToastIds.has(conversation.id)) {
                this._conversationLoadErrorToastIds.add(conversation.id);
                this._showToast('This chat transcript could not be loaded and will not be overwritten.');
            }
            return;
        }

        this._legacyArtifactMigrationIds.add(conversation.id);
        let changed = false;

        for (const message of messages) {
            if ((message.artifacts ?? []).some((artifact) => !artifact?.artifactId)) {
                message.artifacts = this._manageArtifactList(message.artifacts, conversation.id);
                changed = true;
            }

            if (message.toolCall) {
                let toolArtifacts = message.toolCall.artifacts ?? [];

                if (toolArtifacts.length === 0 && message.toolCall.name === 'image_gen') {
                    const imageArtifact = imageArtifactForToolCall(message.toolCall);
                    toolArtifacts = imageArtifact ? [imageArtifact] : [];
                }

                if (toolArtifacts.some((artifact) => !artifact?.artifactId)) {
                    message.toolCall.artifacts = this._manageArtifactList(toolArtifacts, conversation.id);
                    changed = true;
                }
            }
        }

        if (changed)
            this._conversations.persist();
    }

    _migrateWelcomeConversation(conversation = this._conversations.activeConversation) {
        if (!conversation
            || !this._conversations.isConversationHydrated(conversation.id)) {
            return;
        }

        const hasOutdatedTaggedWelcome = conversation.messages.length === 1
            && isWelcomeMessage(conversation.messages[0])
            && conversation.messages[0].content !== WELCOME_MESSAGE_CONTENT;

        if (!isLegacyWelcomeConversation(conversation) && !hasOutdatedTaggedWelcome)
            return;

        const defaults = defaultConversationOptions(this._workspace.enabledSkills);
        this._conversations.replaceMessages(conversation.id, [createWelcomeMessage()]);
        this._conversations.setMemoryEnabled(conversation.id, defaults.memoryEnabled);
        this._conversations.setAgentModeEnabled(conversation.id, defaults.agentModeEnabled);
        this._conversations.setSkillIds(conversation.id, defaults.skillIds);
    }

    _materializeAssistantArtifacts(text, conversationId = '') {
        try {
            return extractArtifactsFromMarkdown(text, {
                artifactManager: this._artifacts,
                originConversationId: conversationId,
                generatedBy: 'assistant',
            });
        } catch (error) {
            logError(error, 'Failed to materialize assistant artifacts');
            return [];
        }
    }

    _createStreamingAssistantView(conversation, options = {}) {
        return createStreamingAssistantView({
            conversation,
            options,
            conversations: this._conversations,
            isActiveConversationId: (conversationId) => (
                this._isActiveConversationId(conversationId)
            ),
            addMessage: (...args) => this._addMessage(...args),
        });
    }

    _startLongResponseNotification(cancellable) {
        const runtimeEntry = this._activeTurnEntryForCancellable(cancellable);

        if (!runtimeEntry)
            return;

        const [conversationId, runtime] = runtimeEntry;
        const notificationId = `long-response-${conversationId}`;
        this._stopLongResponseNotification(cancellable);
        runtime.longResponseNotificationSent = false;
        runtime.longResponseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_RESPONSE_NOTIFICATION_DELAY_MS, () => {
            if (this._shouldSendLongResponseNotification()) {
                const notification = new Gio.Notification();
                notification.set_title('Cusco is still responding');
                notification.set_body('The current response is taking longer than usual.');
                this.get_application()?.send_notification(notificationId, notification);
                runtime.longResponseNotificationSent = true;
            }

            runtime.longResponseTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _shouldSendLongResponseNotification() {
        return shouldSendLongResponseNotification(this);
    }

    _stopLongResponseNotification(cancellable) {
        const runtimeEntry = this._activeTurnEntryForCancellable(cancellable);

        if (!runtimeEntry)
            return;

        const [conversationId, runtime] = runtimeEntry;
        if (runtime.longResponseTimeoutId) {
            GLib.source_remove(runtime.longResponseTimeoutId);
            runtime.longResponseTimeoutId = 0;
        }

        if (runtime.longResponseNotificationSent)
            this.get_application()?.withdraw_notification(`long-response-${conversationId}`);

        runtime.longResponseNotificationSent = false;
    }

    _applyAccessibilityPreferences() {
        if (this._appSettings.highContrastEnabled)
            this.add_css_class('cusco-high-contrast');
        else
            this.remove_css_class('cusco-high-contrast');

        if (this._appSettings.reducedMotionEnabled)
            this.add_css_class('cusco-reduced-motion');
        else
            this.remove_css_class('cusco-reduced-motion');
    }

    _updateAdaptiveLayout() {
        if (!this._sidebar)
            return;

        const compact = this.get_width() > 0 && this.get_width() < 820;
        const artifactOverlay = this.get_width() > 0 && this.get_width() < 1180;
        this._sidebar.set_size_request(compact ? 220 : 280, -1);
        this._artifactSplitView?.set_collapsed(artifactOverlay);
        this._artifactSplitView?.set_pin_sidebar(!artifactOverlay);

        if (compact)
            this.add_css_class('cusco-compact');
        else
            this.remove_css_class('cusco-compact');
    }

    _getProviderFallback(providerId, error) {
        if (!this._appSettings.providerFallbackEnabled)
            return { provider: null, model: null };

        if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
            return { provider: null, model: null };

        return this._providerConfigs.getFallbackSelection(providerId);
    }

    _injectMemoryContext(conversation) {
        return this._conversationContext.injectMemoryContext(conversation);
    }

    _injectSkillContext(conversation) {
        return this._conversationContext.injectSkillContext(conversation);
    }

    _buildArtifactReferenceContext(conversation) {
        return this._conversationContext.buildArtifactReferenceContext(conversation);
    }

    _buildProviderMessages(conversation, skills, options = {}) {
        return this._conversationContext.buildProviderMessages(conversation, skills, options);
    }

    _maybeAutoCompactConversation(conversation, skills, cancellable) {
        return this._conversationContext.maybeAutoCompactConversation(
            conversation,
            skills,
            cancellable,
        );
    }

    _generateContextCompactionSummary(conversation, compaction, cancellable) {
        return this._conversationContext.generateContextCompactionSummary(
            conversation,
            compaction,
            cancellable,
        );
    }

    _promptMemoryProposal(message, conversation) {
        const proposal = this._memories.createProposalFromMessage(message, conversation);

        if (!proposal)
            return;

        const label = new Gtk.Label({
            label: `${proposal.content}\n\n${proposal.reason}`,
            wrap: true,
            selectable: true,
            xalign: 0,
        });
        const dialog = new Adw.AlertDialog({
            heading: 'Save Memory?',
        });
        dialog.set_extra_child(label);
        dialog.add_response('dismiss', 'Dismiss');
        dialog.add_response('save', 'Save');
        dialog.set_default_response('save');
        dialog.set_close_response('dismiss');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.choose(this, null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'save')
                return;

            try {
                this._memories.addMemory(proposal);
            } catch (error) {
                logError(error, 'Failed to save memory');
            }
        });
    }

    _appendSystemError(text, conversationId = null) {
        const conversation = conversationId
            ? this._conversations.getConversation(conversationId)
            : this._conversations.activeConversation;

        if (conversation) {
            const message = createMessage('system', text);
            this._conversations.appendMessage(conversation.id, message);
            this._addMessageIfActiveConversation(conversation.id, message);
        } else if (!conversationId) {
            this._addMessage(text, 'system');
        } else {
            this._showToast(text);
        }

        this._updateUsageDisplay(conversation);
    }

    _populateProviderPicker() {
        this._chatSelection.populateProviders();
    }

    _syncProviderSelectorVisibility(hasEnabledProviders) {
        this._chatSelection.syncVisibility(hasEnabledProviders);
    }

    _populateModelPicker(providerId, selectedModelId = null) {
        this._chatSelection.populateModels(providerId, selectedModelId);
    }

    _populateThinkingLevelPicker(conversation) {
        this._chatSelection.populateThinkingLevels(conversation);
    }

    _createProviderPicker() {
        return this._chatSelection.createProviderPicker();
    }

    _createProviderConfigButton() {
        return this._chatSelection.createProviderConfigButton();
    }

    _createChatOptionsMenuButton() {
        this._composerMenus ??= createComposerMenus(this);
        return this._composerMenus._createChatOptionsMenuButton();
    }

    _createPromptMenuButton() {
        this._composerMenus ??= createComposerMenus(this);
        return this._composerMenus._createPromptMenuButton();
    }

    _refreshPromptMenu() {
        this._composerMenus ??= createComposerMenus(this);
        return this._composerMenus._refreshPromptMenu();
    }

    _insertPrompt(prompt) {
        this._composerMenus ??= createComposerMenus(this);
        return this._composerMenus._insertPrompt(prompt);
    }

    _promptForPromptVariables(prompt, variables) {
        this._composerMenus ??= createComposerMenus(this);
        return this._composerMenus._promptForPromptVariables(prompt, variables);
    }

    _insertPromptContent(content) {
        this._composerMenus ??= createComposerMenus(this);
        return this._composerMenus._insertPromptContent(content);
    }

    _syncProviderControls(conversation) {
        this._chatSelection.sync(conversation);
    }

    _handleMemoryToggleChanged() {
        this._chatSelection.handleMemoryChanged();
    }

    _handleAgentModeToggleChanged() {
        this._chatSelection.handleAgentModeChanged();
    }

    _handleSkillsToggleChanged() {
        this._chatSelection.handleSkillsChanged();
    }

    _resolveThinkingLevelForSelection(providerId, modelId, currentLevel) {
        return this._chatSelection.resolveThinkingLevel(providerId, modelId, currentLevel);
    }

    _handleThinkingLevelChanged() {
        this._chatSelection.handleThinkingLevelChanged();
    }

    _handleProviderChanged() {
        this._chatSelection.handleProviderChanged();
    }

    _handleModelChanged() {
        this._chatSelection.handleModelChanged();
    }

    _refreshConversationList(options = {}) {
        this._conversationSidebar?.refresh(options);
    }

    _maybeLoadNextConversationListPage() {
        this._conversationSidebar?.maybeLoadNextPage();
    }

    _isCronConversation(conversation) {
        return conversation?.conversationType === 'cron' && Boolean(conversation.cronJobId);
    }

    _createConversationRow(conversation, hoverTarget = null) {
        this._conversationSidebar ??= createConversationSidebar(this);
        return this._conversationSidebar.createConversationRow(conversation, hoverTarget);
    }

    _createConversationMenuButton(conversation, hoverTarget, options = {}) {
        this._conversationSidebar ??= createConversationSidebar(this);
        return this._conversationSidebar.createConversationMenuButton(conversation, hoverTarget, options);
    }

    _createConversationMenuItem(iconName, label, onClicked, options = {}) {
        this._conversationSidebar ??= createConversationSidebar(this);
        return this._conversationSidebar.createConversationMenuItem(
            iconName,
            label,
            onClicked,
            options,
        );
    }

    _archiveConversation(conversationId) {
        this._conversationActions ??= createConversationActions(this);
        return this._conversationActions._archiveConversation(conversationId);
    }

    _renameConversation(conversationId) {
        this._conversationActions ??= createConversationActions(this);
        return this._conversationActions._renameConversation(conversationId);
    }

    _exportConversation(conversationId) {
        this._conversationActions ??= createConversationActions(this);
        return this._conversationActions._exportConversation(conversationId);
    }

    _saveConversationExport(conversation, format) {
        this._conversationActions ??= createConversationActions(this);
        return this._conversationActions._saveConversationExport(conversation, format);
    }

    _confirmDeleteConversation(conversationId) {
        this._conversationActions ??= createConversationActions(this);
        return this._conversationActions._confirmDeleteConversation(conversationId);
    }

    _deleteConversationAfterStopping(conversationId) {
        this._conversationActions ??= createConversationActions(this);
        return this._conversationActions._deleteConversationAfterStopping(conversationId);
    }

    _confirmDeleteCronJobConversation(conversationId) {
        this._conversationActions ??= createConversationActions(this);
        return this._conversationActions._confirmDeleteCronJobConversation(conversationId);
    }

    _createConversationView() {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.createConversationView();
    }

    _conversationViewFingerprint(conversation) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.conversationViewFingerprint(conversation);
    }

    _normalizeConversationMessageStartIndex(conversation, requestedStartIndex) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.normalizeMessageStartIndex(
            conversation,
            requestedStartIndex,
        );
    }

    _conversationMessageStartIndex(conversation) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.messageStartIndex(conversation);
    }

    _createLoadEarlierMessagesRow(conversation, startIndex) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.createLoadEarlierMessagesRow(conversation, startIndex);
    }

    _getCachedConversationView(conversation) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.getCachedConversationView(conversation);
    }

    _captureCurrentConversationView() {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.captureCurrentConversationView();
    }

    _activateConversationView(entry, options = {}) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.activateConversationView(entry, options);
    }

    _touchConversationView(entry) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.touchConversationView(entry);
    }

    _removeConversationView(entry) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.removeConversationView(entry);
    }

    _trimConversationViewCache() {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.trimConversationViewCache();
    }

    _cancelScheduledConversationRender() {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.cancelScheduledConversationRender();
    }

    _scheduleActiveConversationRender(conversation) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.scheduleActiveConversationRender(conversation);
    }

    _finishConversationViewRender(conversation, entry, staleEntry) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.finishConversationViewRender(conversation, entry, staleEntry);
    }

    _renderConversationMessagesIncrementally(conversation, entry, staleEntry, messages) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.renderConversationMessagesIncrementally(
            conversation,
            entry,
            staleEntry,
            messages,
        );
    }

    _renderActiveConversation(options = {}) {
        this._transcriptRenderer ??= createTranscriptRenderer(this);
        return this._transcriptRenderer.renderActiveConversation(options);
    }

    _updateUsageDisplay(conversation = this._conversations.activeConversation, pendingAssistantText = '') {
        if (!this._windowTitle)
            return;

        if (conversation?.id && !this._isActiveConversationId(conversation.id))
            return;

        const usage = estimateConversationUsage(this._getUsageMessages(conversation, {
            pendingAssistantText,
        }));

        this._windowTitle.set_subtitle(`${usage.messages} messages`);
        this._syncChatStatisticsPopover(conversation);
        this._syncComposerUsageChart(usage, conversation);
        this._syncComposerHint(this._isConversationBusy(conversation?.id));
    }

    _scheduleUsageDisplayUpdate(conversation) {
        this._pendingUsageConversationId = conversation?.id ?? null;

        if (this._usageDisplaySourceId)
            return;

        this._usageDisplaySourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            STREAMING_USAGE_UPDATE_INTERVAL_MS,
            () => {
                this._usageDisplaySourceId = 0;
                const pendingConversation = this._pendingUsageConversationId
                    ? this._conversations.getConversation(this._pendingUsageConversationId)
                    : null;
                this._pendingUsageConversationId = null;

                if (pendingConversation && this._isActiveConversationId(pendingConversation.id))
                    this._updateUsageDisplay(pendingConversation);

                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _setComposerBusy(isBusy) {
        this._composer.set_sensitive(true);
        this._attachButton.set_sensitive(!isBusy);
        this._syncComposerHint(isBusy);

        this._newChatButton.set_sensitive(true);
        this._chatSearch.set_sensitive(true);
        this._promptMenuButton.set_sensitive(true);
        this._conversationList.set_sensitive(true);
        this._providerPicker.set_sensitive(!isBusy);
        this._providerConfigButton.set_sensitive(!isBusy);
        this._modelPicker.set_sensitive(!isBusy);
        this._thinkingLevelPicker.set_sensitive(!isBusy && this._providerConfigs.supportsThinking(
            this._conversations.activeConversation?.providerId,
            this._conversations.activeConversation?.modelId,
        ));
        this._memoryToggleButton.set_sensitive(!isBusy);
        this._agentModeToggleButton.set_sensitive(!isBusy);
        this._skillsToggleButton.set_sensitive(!isBusy && this._workspace.enabledSkills.length > 0);
        this._chatOptionsMenuButton.set_sensitive(!isBusy);
        this._mainMenuButton.set_sensitive(true);
    }

    _messageContentOptions(options = {}) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._messageContentOptions(options);
    }

    _createEmptyConversationState() {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createEmptyConversationState();
    }

    _syncEmptyConversationState(conversation = this._conversations.activeConversation) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._syncEmptyConversationState(conversation);
    }

    _showConversationLoadingState() {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._showConversationLoadingState();
    }

    _showEmptyConversationState() {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._showEmptyConversationState();
    }

    _hideEmptyConversationState() {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._hideEmptyConversationState();
    }

    _updateEmptyConversationImage() {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._updateEmptyConversationImage();
    }

    _createKnotIcon(options = {}) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createKnotIcon(options);
    }

    _createTextShimmerController(label) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createTextShimmerController(label);
    }

    _createAgentWorkingRow(startedAt = GLib.get_monotonic_time()) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createAgentWorkingRow(startedAt);
    }

    _createKnotStatusRow(text = '', options = {}) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createKnotStatusRow(text, options);
    }

    _createThinkingLabelWidget(isActive) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createThinkingLabelWidget(isActive);
    }

    _createReasoningExpander(contentOrFactory, options = {}) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createReasoningExpander(contentOrFactory, options);
    }

    _createAgentReasoningSegment(message, options = {}) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createAgentReasoningSegment(message, options);
    }

    _createBashOutputPreview(initialOutput = '') {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createBashOutputPreview(initialOutput);
    }

    _createToolArtifactPreviews() {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createToolArtifactPreviews();
    }

    _createToolResultExpander(message, options = {}) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createToolResultExpander(message, options);
    }

    _createMessageImageAttachmentPreviews(message, role) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createMessageImageAttachmentPreviews(message, role);
    }

    _createMessageImageAttachmentPreview(attachment) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createMessageImageAttachmentPreview(attachment);
    }

    _shouldAnimateWelcomeMessage(message) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._shouldAnimateWelcomeMessage(message);
    }

    _startWelcomeMessageStream(messageView, content) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._startWelcomeMessageStream(messageView, content);
    }

    _addMessage(body, kind, message = null, options = {}) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._addMessage(body, kind, message, options);
    }

    _addToolMessage(message) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._addToolMessage(message);
    }

    _createMessageActions(message) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createMessageActions(message);
    }

    _createMessageActionButton(iconName, tooltipText, onClicked, options = {}) {
        this._messagePresenter ??= createMessagePresenter(this);
        return this._messagePresenter._createMessageActionButton(
            iconName,
            tooltipText,
            onClicked,
            options,
        );
    }

    _handleChatActionError(error) {
        this._messageActions ??= createMessageActions(this);
        return this._messageActions._handleChatActionError(error);
    }

    _editMessage(message) {
        this._messageActions ??= createMessageActions(this);
        return this._messageActions._editMessage(message);
    }

    _retryFromMessage(message) {
        this._messageActions ??= createMessageActions(this);
        return this._messageActions._retryFromMessage(message);
    }

    _regenerateFromMessage(message) {
        this._messageActions ??= createMessageActions(this);
        return this._messageActions._regenerateFromMessage(message);
    }

    _branchFromMessage(message) {
        this._messageActions ??= createMessageActions(this);
        return this._messageActions._branchFromMessage(message);
    }

    _clearBox(box) {
        let child = box.get_first_child();

        while (child) {
            const next = child.get_next_sibling();
            box.remove(child);
            child = next;
        }
    }

    _clearConversationListRow(container) {
        const row = container?.get_first_child?.();

        row?._releaseConversationRow?.();

        if (container)
            this._clearBox(container);
    }

    _appendMessageBottomSpacer() {
        if (!this._messages || !this._messageBottomSpacer)
            return;

        if (this._messageBottomSpacer.get_parent() === this._messages)
            return;

        this._messages.append(this._messageBottomSpacer);
    }

    _appendMessageWidget(widget) {
        this._hideEmptyConversationState();

        if (this._messageBottomSpacer?.get_parent?.() === this._messages)
            this._messages.remove(this._messageBottomSpacer);

        this._messages.append(widget);
        this._appendMessageBottomSpacer();
    }

    _setFollowLatestMessage(enabled) {
        this._scrollController ??= createTranscriptScrollController(this);
        return this._scrollController.setFollowLatest(enabled);
    }

    _stopScrollToBottomAnimation() {
        this._scrollController ??= createTranscriptScrollController(this);
        return this._scrollController.stopAnimation();
    }

    _getScrollToBottomValue() {
        this._scrollController ??= createTranscriptScrollController(this);
        return this._scrollController.getBottomValue();
    }

    _animateScrollToBottom() {
        this._scrollController ??= createTranscriptScrollController(this);
        return this._scrollController.animateToBottom();
    }

    _queueScrollToBottomPass() {
        this._scrollController ??= createTranscriptScrollController(this);
        return this._scrollController.queueBottomPass();
    }

    _scrollToBottom(options = {}) {
        this._scrollController ??= createTranscriptScrollController(this);
        return this._scrollController.scrollToBottom(options);
    }

    _syncScrollToBottomButton() {
        this._scrollController ??= createTranscriptScrollController(this);
        return this._scrollController.syncButton();
    }
});
