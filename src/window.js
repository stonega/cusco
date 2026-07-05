import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import {
    buildAgentModeSystemPrompt,
    createAgentToolFailurePrompt,
    createAgentToolResultPrompt,
    DEFAULT_AGENT_MAX_ITERATIONS,
    formatAgentToolCall,
    isPartialAgentToolCall,
    parseAgentToolCall,
} from './chat/agentMode.js';
import { ConversationManager } from './chat/conversation.js';
import { copyTextToClipboard, createMessageContent } from './chat/messageView.js';
import { estimateConversationUsage } from './chat/usage.js';
import { createCronCreateTool, CronJobManager } from './cron/manager.js';
import { MemoryManager } from './memory/memory.js';
import { McpManager } from './mcp/manager.js';
import { ProviderConfigStore } from './providers/config.js';
import { getProviderGIcon } from './providers/icons.js';
import { createMessage } from './providers/provider.js';
import {
    DEFAULT_THINKING_LEVEL,
    getThinkingLevelLabel,
    normalizeThinkingLevel,
} from './providers/thinking.js';
import { normalizeTokenUsage } from './providers/usage.js';
import { AppSettingsStore } from './settings/appSettings.js';
import { presentProviderSettingsDialog } from './settings/providerSettings.js';
import { ConversationFileStore } from './storage/conversationStore.js';
import { MemoryFileStore } from './storage/memoryStore.js';
import { WorkspaceFileStore } from './storage/workspaceStore.js';
import { buildSkillContext } from './skills/skills.js';
import { createToolPermissionDecision } from './tools/permissions.js';
import { formatToolResultForTranscript, ToolManager } from './tools/tools.js';
import { exportConversation } from './workspace/exports.js';
import { extractPromptVariables, formatPromptVariables, renderPromptTemplate } from './workspace/promptVariables.js';
import { WorkspaceManager } from './workspace/workspace.js';

const GIT_BRANCH_ICON_FILE = 'git-branch-symbolic.svg';
const ATTACHMENT_ICON_FILE = 'attachment-symbolic.svg';
const PROMPT_ICON_FILE = 'prompt-symbolic.svg';
const PROVIDER_PICKER_ID_COLUMN = 0;
const PROVIDER_PICKER_NAME_COLUMN = 1;
const PROVIDER_PICKER_ICON_COLUMN = 2;
const BASE_RESPONSE_SYSTEM_PROMPT = [
    'Complete the user\'s current request in one assistant response whenever possible.',
    'If more work remains, keep going within the available output budget instead of asking the user to say "continue".',
    'Ask a follow-up only when required information is missing or the user must choose between options.',
].join(' ');

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isCancellableCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

function wasOperationCancelled(error, cancellable = null) {
    return isCancellableCancelled(cancellable) || isGioError(error, Gio.IOErrorEnum.CANCELLED);
}

function getBundledResourcePath(filename) {
    const modulePath = Gio.File.new_for_uri(import.meta.url).get_path();

    if (!modulePath)
        return null;

    const moduleDir = GLib.path_get_dirname(modulePath);
    const candidates = [
        GLib.build_filenamev([moduleDir, 'resources', filename]),
        GLib.build_filenamev([moduleDir, '..', 'data', 'resources', filename]),
    ];

    return candidates.find((path) => GLib.file_test(path, GLib.FileTest.EXISTS)) ?? null;
}

function createBundledIcon(filename, fallbackIconName) {
    const iconPath = getBundledResourcePath(filename);
    const image = iconPath
        ? new Gtk.Image({ file: iconPath })
        : new Gtk.Image({ icon_name: fallbackIconName });

    image.set_pixel_size(16);
    return image;
}

function createLabeledControlRow(label, control) {
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        margin_top: 3,
        margin_bottom: 3,
        margin_start: 3,
        margin_end: 3,
    });
    const labelWidget = new Gtk.Label({
        label,
        xalign: 0,
        hexpand: true,
        valign: Gtk.Align.CENTER,
    });

    row.append(labelWidget);
    row.append(control);
    return row;
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

function normalizeProviderChunk(chunk) {
    if (typeof chunk === 'string')
        return { type: 'text', text: chunk };

    if (!chunk || typeof chunk !== 'object')
        return { type: 'text', text: '' };

    if (chunk.type === 'usage')
        return {
            type: 'usage',
            text: '',
            usage: normalizeTokenUsage(chunk.usage),
        };

    if (chunk.type === 'tool_calls')
        return {
            type: 'tool_calls',
            text: '',
            toolCalls: Array.isArray(chunk.toolCalls) ? chunk.toolCalls : [],
            usage: null,
        };

    return {
        type: chunk.type === 'reasoning' ? 'reasoning' : 'text',
        text: String(chunk.text ?? chunk.content ?? ''),
        usage: null,
    };
}

function getMessageReasoningContent(message) {
    if (typeof message?.reasoning === 'string')
        return message.reasoning.trim();

    return String(message?.reasoning?.content ?? '').trim();
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
        this._memories = new MemoryManager({ store: new MemoryFileStore() });
        this._workspace = new WorkspaceManager({ store: new WorkspaceFileStore() });
        this._tools = new ToolManager();
        this._cron = new CronJobManager();
        this._mcp = new McpManager({ workspaceManager: this._workspace });
        this._pendingAttachments = [];
        this._cronJobIndex = new Map();
        this._cronLogSyncTimeoutId = 0;
        this._providerConfigs = new ProviderConfigStore();
        const { provider: defaultProvider, model: defaultModel } = this._providerConfigs.getActiveSelection();

        this._conversations = new ConversationManager({
            providerId: defaultProvider?.id ?? '',
            modelId: defaultModel?.id ?? '',
            thinkingLevel: this._appSettings.thinkingLevel,
            store: new ConversationFileStore(),
        });
        this._tools.registerTool(createCronCreateTool(this._cron, {
            onJobCreated: async (job) => this._handleCronJobChanged(job),
        }));

        if (this._conversations.allConversations.length === 0) {
            this._conversations.createConversation({
                title: 'Welcome to Cusco',
                thinkingLevel: this._appSettings.thinkingLevel,
                messages: [
                    createMessage('assistant', 'Ask a question, compare providers, or start building a reusable AI workflow.'),
                    createMessage('system', 'Next steps: markdown rendering, memory controls, web search, and desktop integration.'),
                ],
            });
        }

        this._isRefreshingConversations = false;
        this._isUpdatingProviderControls = false;
        this._activeChatCancellable = null;
        this._lastAssistantMessageView = null;
        this.connect('close-request', () => {
            this._stopActiveConversation();
            this._stopCronLogSync();
            this._mcp.shutdown();
            return false;
        });
        this._buildUi();
        this._refreshConversationList();
        this._renderActiveConversation();
        this._syncCronJobsWithConversations({ refreshUi: true }).catch((error) => {
            logError(error, 'Failed to sync cron job chats');
        });
        this._startCronLogSync();
    }

    _buildUi() {
        const headerBar = new Adw.HeaderBar();
        const title = new Adw.WindowTitle({
            title: 'Cusco',
            subtitle: '0 est. tokens · 0 messages',
        });

        this._windowTitle = title;
        headerBar.set_title_widget(title);

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
        split.set_end_child(chatView);

        this.set_content(split);
        this._installKeyboardShortcuts();
        this.connect('notify::width', () => this._updateAdaptiveLayout());
        this._applyAccessibilityPreferences();
        this._updateAdaptiveLayout();
    }

    _installKeyboardShortcuts() {
        const keyController = new Gtk.EventControllerKey();

        keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keyController.connect('key-pressed', (_controller, keyval) => {
            if (keyval === Gdk.KEY_Escape && this._activeChatCancellable) {
                this._stopActiveConversation();
                return true;
            }

            return false;
        });

        this.add_controller(keyController);
    }

    _createSidebar() {
        const sidebar = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
        });
        sidebar.add_css_class('sidebar');
        sidebar.add_css_class('cusco-sidebar');
        sidebar.set_size_request(280, -1);
        this._sidebar = sidebar;

        const sidebarHandle = new Gtk.WindowHandle();
        const sidebarHeader = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });

        this._newChatButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'New chat',
        });
        this._newChatButton.connect('clicked', () => this._createNewConversation());

        this._sidebarTitle = new Gtk.Label({
            label: 'Chats',
            hexpand: true,
            xalign: 0.5,
        });
        this._sidebarTitle.add_css_class('heading');

        this._settingsButton = new Gtk.Button({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: 'Preferences',
        });
        this._settingsButton.connect('clicked', () => this._showSettingsDialog());

        sidebarHeader.append(this._newChatButton);
        sidebarHeader.append(this._sidebarTitle);
        sidebarHeader.append(this._settingsButton);
        sidebarHandle.set_child(sidebarHeader);
        sidebar.append(sidebarHandle);

        const sidebarContent = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 6,
            margin_bottom: 12,
            margin_start: 6,
            margin_end: 6,
            hexpand: true,
            vexpand: true,
        });

        this._chatSearch = new Gtk.SearchEntry({
            placeholder_text: 'Search chats',
            hexpand: true,
        });
        this._chatSearch.connect('search-changed', () => this._refreshConversationList());

        sidebarContent.append(this._chatSearch);

        this._conversationList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            hexpand: true,
            vexpand: true,
        });
        this._conversationList.add_css_class('cusco-conversation-list');
        this._conversationList.connect('row-selected', (_list, row) => {
            if (this._isRefreshingConversations || !row)
                return;

            this._conversations.selectConversation(row.conversationId);
            this._renderActiveConversation();
        });

        sidebarContent.append(this._conversationList);
        sidebar.append(sidebarContent);

        return sidebar;
    }

    _createChatSurface() {
        const main = new Gtk.Overlay({
            hexpand: true,
            vexpand: true,
        });

        const composerShell = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.END,
            hexpand: true,
            margin_start: 18,
            margin_end: 18,
            margin_bottom: 10,
        });
        composerShell.add_css_class('cusco-floating-composer');

        const composerMetaRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        composerMetaRow.add_css_class('cusco-composer-meta');

        this._providerPicker = this._createProviderPicker();
        this._providerConfigButton = this._createProviderConfigButton();
        this._modelPicker = new Gtk.ComboBoxText();
        this._populateProviderPicker();
        this._providerPicker.connect('changed', () => this._handleProviderChanged());
        this._modelPicker.connect('changed', () => this._handleModelChanged());
        this._chatOptionsMenuButton = this._createChatOptionsMenuButton();

        this._messages = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 8,
            margin_start: 26,
            margin_end: 26,
        });
        this._messageBottomSpacer = new Gtk.Box();
        this._messageBottomSpacer.set_size_request(-1, 260);
        this._messageBottomSpacer.add_css_class('cusco-message-bottom-spacer');
        this._appendMessageBottomSpacer();

        this._scroller = new Gtk.ScrolledWindow({
            child: this._messages,
            hexpand: true,
            vexpand: true,
        });

        const composerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });

        this._attachmentRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            visible: false,
        });
        this._attachmentRow.add_css_class('cusco-attachment-row');
        this._attachmentLabel = new Gtk.Label({
            label: '',
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        });
        this._attachmentLabel.add_css_class('caption');
        this._attachmentLabel.add_css_class('dim-label');
        this._removeAttachmentButton = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            tooltip_text: 'Remove attachment',
            valign: Gtk.Align.CENTER,
        });
        this._removeAttachmentButton.add_css_class('flat');
        this._removeAttachmentButton.add_css_class('circular');
        this._removeAttachmentButton.connect('clicked', () => this._clearPendingAttachments());
        this._attachmentRow.append(this._attachmentLabel);
        this._attachmentRow.append(this._removeAttachmentButton);

        this._attachButton = new Gtk.Button({
            tooltip_text: 'Attach file or image',
            valign: Gtk.Align.CENTER,
        });
        this._attachButton.set_child(createBundledIcon(ATTACHMENT_ICON_FILE, 'mail-attachment-symbolic'));
        this._attachButton.connect('clicked', () => this._attachFileContext());

        this._promptMenuButton = this._createPromptMenuButton();
        this._promptMenuButton.set_valign(Gtk.Align.CENTER);

        composerMetaRow.append(this._providerPicker);
        composerMetaRow.append(this._providerConfigButton);
        composerMetaRow.append(this._modelPicker);
        composerMetaRow.append(this._attachButton);
        composerMetaRow.append(this._promptMenuButton);
        composerMetaRow.append(this._chatOptionsMenuButton);

        this._composerBuffer = new Gtk.TextBuffer();
        this._composer = new Gtk.TextView({
            buffer: this._composerBuffer,
            accepts_tab: false,
            hexpand: true,
            top_margin: 8,
            bottom_margin: 26,
            left_margin: 10,
            right_margin: 10,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
        });
        this._composer.add_css_class('cusco-composer-text');

        this._composerPlaceholder = new Gtk.Label({
            label: 'Message Cusco',
            xalign: 0,
            yalign: 0,
            halign: Gtk.Align.START,
            valign: Gtk.Align.START,
            margin_top: 10,
            margin_start: 12,
        });
        this._composerPlaceholder.add_css_class('dim-label');
        this._composerPlaceholder.set_can_target(false);

        this._composerScroller = new Gtk.ScrolledWindow({
            child: this._composer,
            hexpand: true,
            min_content_height: 88,
            max_content_height: 176,
            propagate_natural_height: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        });
        this._composerScroller.add_css_class('cusco-composer-input');

        const composerOverlay = new Gtk.Overlay({
            child: this._composerScroller,
            hexpand: true,
        });
        composerOverlay.add_overlay(this._composerPlaceholder);

        this._composerHint = new Gtk.Label({
            xalign: 1,
            yalign: 1,
            halign: Gtk.Align.END,
            valign: Gtk.Align.END,
            margin_end: 12,
            margin_bottom: 8,
        });
        this._composerHint.add_css_class('caption');
        this._composerHint.add_css_class('dim-label');
        this._composerHint.set_can_target(false);
        composerOverlay.add_overlay(this._composerHint);

        const sendMessage = () => {
            if (this._activeChatCancellable) {
                this._stopActiveConversation();
                return;
            }

            const text = this._getComposerText().trim();

            if (!text)
                return;

            this._setComposerText('');
            this._sendMessage(text).catch((error) => {
                logError(error, 'Failed to stream provider response');
                this._appendSystemError(getProviderErrorMessage(error));
            });
        };

        const composerKeyController = new Gtk.EventControllerKey();
        composerKeyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            const isEnter = keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter;
            const shiftPressed = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
            const controlPressed = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;

            if (isEnter && !shiftPressed && (this._appSettings.sendWithEnter || controlPressed)) {
                sendMessage();
                return true;
            }

            return false;
        });
        this._composer.add_controller(composerKeyController);
        this._composerBuffer.connect('changed', () => this._syncComposerPlaceholder());
        this._syncComposerPlaceholder();
        this._syncComposerHint();

        composerRow.append(composerOverlay);

        composerShell.append(composerMetaRow);
        composerShell.append(this._attachmentRow);
        composerShell.append(composerRow);

        main.set_child(this._scroller);
        main.add_overlay(composerShell);

        return main;
    }

    _createNewConversation() {
        const activeConversation = this._conversations.activeConversation;
        const providerId = activeConversation?.providerId;
        const modelId = activeConversation?.modelId;
        const memoryEnabled = activeConversation?.memoryEnabled !== false;
        const agentModeEnabled = Boolean(activeConversation?.agentModeEnabled);
        const skillIds = activeConversation?.skillIds ?? [];
        const thinkingLevel = activeConversation?.thinkingLevel ?? this._appSettings.thinkingLevel;

        this._conversations.createConversation({
            providerId,
            modelId,
            memoryEnabled,
            agentModeEnabled,
            skillIds,
            thinkingLevel,
        });
        this._refreshConversationList();
        this._renderActiveConversation();
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

    _setComposerText(text) {
        if (!this._composerBuffer)
            return;

        this._composerBuffer.set_text(String(text ?? ''), -1);
        const [, end] = this._composerBuffer.get_bounds();
        this._composerBuffer.place_cursor(end);
        this._syncComposerPlaceholder();
    }

    _syncComposerPlaceholder() {
        if (!this._composerPlaceholder || !this._composerBuffer)
            return;

        this._composerPlaceholder.set_visible(this._composerBuffer.get_char_count() === 0);
    }

    _syncComposerHint(isBusy = false) {
        if (!this._composerHint)
            return;

        this._composerHint.set_label(isBusy
            ? 'Esc to stop'
            : `${this._appSettings.sendWithEnter ? 'Enter' : 'Ctrl+Enter'} ↵ to send`);
    }

    selectConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        this._conversations.selectConversation(conversationId);
        this._refreshConversationList();
        this._renderActiveConversation();
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
            options,
        );
    }

    async _handleCronJobChanged(job) {
        await this._syncCronJobsWithConversations({ refreshUi: true });
    }

    _startCronLogSync() {
        if (this._cronLogSyncTimeoutId)
            return;

        this._cronLogSyncTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._syncCronJobsWithConversations({ refreshUi: true }).catch((error) => {
                logError(error, 'Failed to sync cron job logs');
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCronLogSync() {
        if (!this._cronLogSyncTimeoutId)
            return;

        GLib.source_remove(this._cronLogSyncTimeoutId);
        this._cronLogSyncTimeoutId = 0;
    }

    async _syncCronJobsWithConversations({ refreshUi = false } = {}) {
        const activeConversationId = this._conversations.activeConversation?.id ?? null;
        const status = await this._cron.getStatus();

        if (!status.available)
            return status;

        this._cronJobIndex = new Map(status.jobs.map((job) => [job.id, job]));

        for (const job of status.jobs) {
            const conversation = this._ensureCronConversation(job);

            if (conversation && job.conversationId !== conversation.id) {
                const updatedJob = await this._cron.updateJob(job.id, { conversationId: conversation.id });
                this._cronJobIndex.set(updatedJob.id, updatedJob);
            }

            if (conversation)
                this._appendCronRunLogs(job, conversation);
        }

        if (activeConversationId && this._conversations.getConversation(activeConversationId))
            this._conversations.selectConversation(activeConversationId);

        if (refreshUi) {
            this._refreshConversationList();

            if (this._isCronConversation(this._conversations.activeConversation))
                this._renderActiveConversation();
        }

        return status;
    }

    _ensureCronConversation(job) {
        let conversation = job.conversationId
            ? this._conversations.getConversation(job.conversationId)
            : null;

        if (!conversation)
            conversation = this._findCronConversation(job.id);

        if (!conversation) {
            conversation = this._conversations.createConversation({
                title: job.title,
                conversationType: 'cron',
                cronJobId: job.id,
                memoryEnabled: false,
                agentModeEnabled: false,
                messages: [
                    createMessage('system', this._formatCronJobCreatedMessage(job)),
                ],
            });
        } else if (conversation.conversationType !== 'cron' || conversation.cronJobId !== job.id) {
            this._conversations.setCronMetadata(conversation.id, {
                conversationType: 'cron',
                cronJobId: job.id,
            });
        }

        return conversation;
    }

    _findCronConversation(jobId) {
        return this._conversations.allConversations.find((conversation) => (
            conversation.conversationType === 'cron' && conversation.cronJobId === jobId
        )) ?? null;
    }

    _deleteCronConversation(jobId) {
        const conversation = this._findCronConversation(jobId);

        if (!conversation)
            return;

        this._conversations.deleteConversation(conversation.id);

        if (this._conversations.allConversations.length === 0)
            this._conversations.createConversation();

        this._refreshConversationList();
        this._renderActiveConversation();
    }

    _appendCronRunLogs(job, conversation) {
        const existingRunIds = new Set(conversation.messages
            .map((message) => message.cronRun?.runId)
            .filter(Boolean));
        const logs = this._cron.readRunLogs(job);
        let appended = false;

        for (const run of logs) {
            if (existingRunIds.has(run.runId))
                continue;

            this._conversations.appendMessage(conversation.id, createMessage(
                'system',
                this._formatCronRunMessage(job, run),
                {
                    cronRun: {
                        jobId: job.id,
                        runId: run.runId,
                        exitStatus: run.exitStatus,
                        startedAt: run.startedAt,
                        finishedAt: run.finishedAt,
                    },
                },
            ));
            existingRunIds.add(run.runId);
            appended = true;
        }

        return appended;
    }

    _formatCronJobCreatedMessage(job) {
        return [
            `Cron job: ${job.title}`,
            `Schedule: ${job.schedule}`,
            `Status: ${job.enabled ? 'Enabled' : 'Disabled'}`,
            '',
            'Command:',
            '```sh',
            job.command,
            '```',
        ].join('\n');
    }

    _formatCronRunMessage(job, run) {
        return [
            `Cron job run: ${job.title}`,
            `Schedule: ${job.schedule}`,
            `Started: ${run.startedAt || 'unknown'}`,
            `Finished: ${run.finishedAt || 'unknown'}`,
            `Exit status: ${Number.isFinite(run.exitStatus) ? run.exitStatus : 'unknown'}`,
            '',
            'stdout',
            '```text',
            run.stdout || '<empty>',
            '```',
            '',
            'stderr',
            '```text',
            run.stderr || '<empty>',
            '```',
        ].join('\n');
    }

    _handleProviderSettingsChanged(change = {}) {
        this._mcp.reloadConfig();
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
        this._refreshConversationList();

        if (change?.codeThemeChanged)
            this._renderActiveConversation();
    }

    async _sendMessage(text) {
        const conversation = this._conversations.activeConversation ?? this._conversations.createConversation();

        if (!this._providerConfigs.isProviderAvailable(conversation.providerId)) {
            const defaultProvider = this._providerConfigs.getDefaultProvider();
            const defaultModel = defaultProvider ? this._providerConfigs.getDefaultModel(defaultProvider.id) : null;

            if (!defaultProvider) {
                this._appendSystemError('Configure an AI provider in Settings before sending.');
                this._showSettingsDialog({ initialPage: 'providers' });
                return;
            }

            this._conversations.updateProviderConfig(conversation.id, {
                providerId: defaultProvider.id,
                modelId: defaultModel?.id ?? '',
            });
            this._providerConfigs.setActiveSelection(defaultProvider.id, defaultModel?.id ?? '');
            this._syncProviderControls(conversation);
        }

        const cancellable = this._beginActiveTurn();

        if (!cancellable)
            return;

        const attachments = this._consumePendingAttachments();
        const userMessage = createMessage(
            'user',
            this._formatUserMessageContent(text, attachments),
            { attachments },
        );

        try {
            this._conversations.appendMessage(conversation.id, userMessage);
            this._addMessage(userMessage.content, userMessage.role, userMessage);
            this._promptMemoryProposal(userMessage, conversation);

            const toolStatus = await this._runRequestedTool(text, conversation.id, cancellable);
            this._refreshConversationList();

            if (isCancellableCancelled(cancellable)) {
                if (toolStatus !== 'cancelled')
                    this._appendStoppedMessage(conversation.id, 'Response stopped before the provider request started.');

                return;
            }

            await this._streamAssistantResponse(conversation.id, { cancellable });
        } finally {
            this._finishActiveTurn(cancellable);
        }
    }

    async _runRequestedTool(text, conversationId, cancellable = null) {
        const request = this._tools.parseRequest(text);

        if (!request)
            return 'skipped';

        if (isCancellableCancelled(cancellable)) {
            this._appendToolCancellation(conversationId, request);
            return 'cancelled';
        }

        const permissionDecision = createToolPermissionDecision(request, {
            autoModeEnabled: this._appSettings.autoModeEnabled,
        });

        if (permissionDecision.status === 'deny') {
            const message = createMessage('system', `${request.label} was not run because it is blocked by policy.`);
            this._conversations.appendMessage(conversationId, message);
            this._addMessage(message.content, message.role, message);
            return 'blocked';
        }

        if (permissionDecision.requiresUserApproval && !await this._confirmToolPermission(request, cancellable)) {
            if (isCancellableCancelled(cancellable)) {
                this._appendToolCancellation(conversationId, request);
                return 'cancelled';
            }

            const message = createMessage('system', `${request.label} was not run because permission was denied.`);
            this._conversations.appendMessage(conversationId, message);
            this._addMessage(message.content, message.role, message);
            return 'denied';
        }

        try {
            const result = await this._tools.runRequest(request, {
                timeoutSeconds: this._appSettings.responseTimeoutSeconds,
                cancellable,
            });
            const status = result.cancelled ? 'cancelled' : 'completed';
            const message = createMessage('system', formatToolResultForTranscript(result), {
                toolCall: {
                    name: result.name,
                    label: result.label,
                    input: result.input,
                    output: result.output ?? '',
                    results: result.results ?? [],
                    status,
                    createdAt: new Date().toISOString(),
                },
            });
            this._conversations.appendMessage(conversationId, message);
            this._addMessage(message.content, message.role, message);
            this._updateUsageDisplay(this._conversations.getConversation(conversationId));
            return status;
        } catch (error) {
            if (wasOperationCancelled(error, cancellable)) {
                this._appendToolCancellation(conversationId, request);
                return 'cancelled';
            }

            const message = createMessage('system', error.userMessage ?? `Tool failed: ${error.message}`);
            this._conversations.appendMessage(conversationId, message);
            this._addMessage(message.content, message.role, message);
            logError(error, 'Failed to run tool request');
            return 'failed';
        }
    }

    _confirmToolPermission(request, cancellable = null) {
        return new Promise((resolve) => {
            if (isCancellableCancelled(cancellable)) {
                resolve(false);
                return;
            }

            const dialog = new Adw.AlertDialog({
                heading: `Run ${request.label}?`,
                body: request.name === 'search'
                    ? `Cusco will send this query to DuckDuckGo:\n${request.input}`
                    : request.input,
            });
            dialog.add_response('deny', 'Deny');
            dialog.add_response('stop', 'Stop');
            dialog.add_response('allow', 'Allow');
            dialog.set_default_response('allow');
            dialog.set_close_response('stop');
            dialog.set_response_appearance('stop', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_response_appearance('allow', Adw.ResponseAppearance.SUGGESTED);
            dialog.choose(this, cancellable, (_dialog, result) => {
                try {
                    const response = dialog.choose_finish(result);

                    if (response === 'stop')
                        cancellable?.cancel();

                    resolve(response === 'allow');
                } catch (error) {
                    if (!wasOperationCancelled(error, cancellable))
                        logError(error, 'Failed to resolve tool permission dialog');

                    resolve(false);
                }
            });
        });
    }

    _attachFileContext() {
        const dialog = new Gtk.FileDialog({
            title: 'Attach File or Image',
        });

        dialog.open(this, null, (_dialog, result) => {
            try {
                const file = dialog.open_finish(result);
                const path = file.get_path();

                if (!path)
                    throw new Error('Only local file attachments are supported right now');

                this._pendingAttachments.push(this._createAttachmentFromPath(path));
                this._updateAttachmentLabel();
            } catch (error) {
                logError(error, 'Failed to attach file');
            }
        });
    }

    _createAttachmentFromPath(path) {
        const name = GLib.path_get_basename(path);
        const lowerName = name.toLowerCase();
        const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].some((extension) => (
            lowerName.endsWith(extension)
        ));

        if (isImage) {
            return {
                kind: 'image',
                name,
                path,
            };
        }

        const [, contents] = GLib.file_get_contents(path);
        const text = new TextDecoder().decode(contents);

        return {
            kind: 'file',
            name,
            path,
            content: text.slice(0, 20000),
            truncated: text.length > 20000,
        };
    }

    _consumePendingAttachments() {
        const attachments = this._pendingAttachments.map((attachment) => ({ ...attachment }));
        this._pendingAttachments = [];
        this._updateAttachmentLabel();
        return attachments;
    }

    _clearPendingAttachments() {
        this._pendingAttachments = [];
        this._updateAttachmentLabel();
        this.focusComposer();
    }

    _updateAttachmentLabel() {
        if (this._pendingAttachments.length === 0) {
            this._attachmentLabel.set_label('');
            this._attachmentRow.set_visible(false);
            return;
        }

        this._attachmentLabel.set_label(`Attached: ${this._pendingAttachments.map((attachment) => attachment.name).join(', ')}`);
        this._attachmentRow.set_visible(true);
    }

    _formatUserMessageContent(text, attachments) {
        if (attachments.length === 0)
            return text;

        const attachmentText = attachments.map((attachment) => {
            if (attachment.kind === 'image')
                return `Image attachment: ${attachment.name}`;

            return [
                `File attachment: ${attachment.name}${attachment.truncated ? ' (truncated)' : ''}`,
                '```text',
                attachment.content,
                '```',
            ].join('\n');
        }).join('\n\n');

        return `${text}\n\n${attachmentText}`;
    }

    async _streamAssistantResponse(conversationId, options = {}) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        const ownsActiveTurn = !options.cancellable;
        const cancellable = options.cancellable ?? this._beginActiveTurn();

        if (!cancellable)
            return;

        let assistantView = null;
        this._startLongResponseNotification();

        try {
            this._injectMemoryContext(conversation);
            const activeSkills = this._injectSkillContext(conversation);
            if (conversation.agentModeEnabled)
                await this._mcp.refreshTools(this._tools, {
                    timeoutSeconds: this._appSettings.responseTimeoutSeconds,
                    cancellable,
                });

            const providerMessages = this._buildProviderMessages(conversation, activeSkills, {
                agentMode: Boolean(conversation.agentModeEnabled),
            });
            assistantView = this._createStreamingAssistantView(conversation);
            const assistantText = conversation.agentModeEnabled
                ? await this._runAgentModeResponse(conversation, providerMessages, assistantView, cancellable)
                : await this._collectProviderResponseWithFallback(
                    conversation,
                    providerMessages,
                    cancellable,
                    (text, _chunk, state) => {
                        if (state?.type === 'usage')
                            assistantView.set_usage(state.usage);

                        if (state?.type === 'reasoning')
                            assistantView.set_reasoning(state.reasoning);

                        if (state?.type !== 'usage')
                            assistantView.set_label(text);

                        this._updateUsageDisplay(conversation);
                        this._scrollToBottom();
                    },
                );

            if (isCancellableCancelled(cancellable)) {
                this._appendStoppedMessage(
                    conversation.id,
                    assistantView.hasContent()
                        ? 'Response stopped. Partial assistant text was saved.'
                        : 'Response stopped before the assistant returned text.',
                );
                return;
            }

            assistantView.set_stream_text(assistantText, assistantText);
            this._refreshConversationList();
            this._renderActiveConversation();
        } catch (error) {
            if (wasOperationCancelled(error, cancellable)) {
                this._appendStoppedMessage(
                    conversation.id,
                    assistantView?.hasContent()
                        ? 'Response stopped. Partial assistant text was saved.'
                        : 'Response stopped before the assistant returned text.',
                );
                return;
            }

            throw error;
        } finally {
            this._stopLongResponseNotification();

            if (ownsActiveTurn)
                this._finishActiveTurn(cancellable);
        }
    }

    async _collectProviderResponse(providerId, modelId, providerMessages, cancellable, onChunk = null, collectOptions = {}) {
        const activeProvider = this._providerConfigs.createProvider(providerId);
        const providerConfig = this._providerConfigs.resolve(providerId, modelId);
        let responseText = '';
        let reasoningText = '';
        let usage = null;
        const toolCalls = [];

        for await (const chunk of activeProvider.streamChat(providerMessages, {
            ...providerConfig,
            cancellable,
            timeoutSeconds: this._appSettings.responseTimeoutSeconds,
            maxOutputTokens: this._appSettings.maxOutputTokens,
            thinkingLevel: this._conversations.activeConversation?.thinkingLevel ?? this._appSettings.thinkingLevel,
            tools: collectOptions.tools ?? [],
        })) {
            const normalizedChunk = normalizeProviderChunk(chunk);

            if (normalizedChunk.type === 'usage')
                usage = normalizedChunk.usage;
            else if (normalizedChunk.type === 'reasoning')
                reasoningText += normalizedChunk.text;
            else if (normalizedChunk.type === 'tool_calls')
                toolCalls.push(...normalizedChunk.toolCalls);
            else
                responseText += normalizedChunk.text;

            onChunk?.(responseText, normalizedChunk.text, {
                type: normalizedChunk.type,
                text: responseText,
                reasoning: reasoningText,
                usage,
                toolCalls,
            });
        }

        if (collectOptions.returnState)
            return {
                text: responseText,
                reasoning: reasoningText,
                usage,
                toolCalls,
            };

        return responseText;
    }

    async _collectProviderResponseWithFallback(conversation, providerMessages, cancellable, onChunk = null, collectOptions = {}) {
        try {
            return await this._collectProviderResponse(
                conversation.providerId,
                conversation.modelId,
                providerMessages,
                cancellable,
                onChunk,
                collectOptions,
            );
        } catch (error) {
            const fallback = this._getProviderFallback(conversation.providerId, error);

            if (!fallback.provider)
                throw error;

            this._conversations.updateProviderConfig(conversation.id, {
                providerId: fallback.provider.id,
                modelId: fallback.model?.id ?? '',
            });
            this._syncProviderControls(conversation);
            this._refreshConversationList();

            return await this._collectProviderResponse(
                fallback.provider.id,
                fallback.model?.id ?? '',
                providerMessages,
                cancellable,
                onChunk,
                collectOptions,
            );
        }
    }

    async _runAgentModeResponse(conversation, providerMessages, assistantView, cancellable) {
        const runtimeMessages = providerMessages.map((message) => ({ ...message }));
        const setAssistantStatus = (text) => {
            if (typeof assistantView.set_status === 'function')
                assistantView.set_status(text);
            else
                assistantView.set_label(text);
        };

        for (let iteration = 0; iteration < DEFAULT_AGENT_MAX_ITERATIONS; iteration++) {
            if (isCancellableCancelled(cancellable))
                return '';

            setAssistantStatus(iteration === 0 ? 'Agent Mode is thinking...' : 'Agent Mode is continuing...');
            const responseState = await this._collectProviderResponseWithFallback(
                conversation,
                runtimeMessages,
                cancellable,
                (text, _chunk, state) => {
                    if (state?.type === 'usage')
                        assistantView.set_usage(state.usage);

                    if (state?.type === 'reasoning')
                        assistantView.set_reasoning(state.reasoning);

                    if (state?.type !== 'usage' && state?.type !== 'tool_calls')
                        this._updateAgentModeAssistantView(conversation, assistantView, text);
                },
                {
                    returnState: true,
                    tools: this._tools.listTools(),
                },
            );
            const responseText = responseState.text;

            if (isCancellableCancelled(cancellable))
                return responseText;

            if (responseState.toolCalls.length > 0) {
                let ranAnyTool = false;

                for (const nativeToolCall of responseState.toolCalls) {
                    const runtimeToolCallText = responseText || formatAgentToolCall(nativeToolCall);
                    const request = this._createAgentToolRequest(
                        nativeToolCall,
                        runtimeToolCallText,
                        conversation,
                        runtimeMessages,
                    );

                    if (!request)
                        continue;

                    setAssistantStatus(`Agent Mode requested ${request.label}...`);
                    ranAnyTool = await this._runAgentToolRequest(
                        request,
                        runtimeToolCallText,
                        conversation,
                        runtimeMessages,
                        cancellable,
                    ) || ranAnyTool;
                }

                if (ranAnyTool)
                    continue;
            }

            const toolCall = this._parseAgentToolCallForRuntime(responseText, conversation, runtimeMessages);

            if (!toolCall)
                return responseText;

            if (toolCall.invalid)
                continue;

            const request = this._createAgentToolRequest(toolCall, responseText, conversation, runtimeMessages);

            if (!request)
                continue;

            setAssistantStatus(`Agent Mode requested ${request.label}...`);
            const ranTool = await this._runAgentToolRequest(
                request,
                responseText,
                conversation,
                runtimeMessages,
                cancellable,
            );

            if (!ranTool)
                continue;
        }

        const limitMessage = createMessage(
            'system',
            `Agent Mode stopped after ${DEFAULT_AGENT_MAX_ITERATIONS} tool-use iterations.`,
        );
        this._conversations.appendMessage(conversation.id, limitMessage);
        this._addMessage(limitMessage.content, limitMessage.role, limitMessage);

        return 'Agent Mode stopped because it reached the tool-use limit. Review the tool results above or send a narrower request.';
    }

    _updateAgentModeAssistantView(conversation, assistantView, text) {
        let displayText;

        if (isPartialAgentToolCall(text)) {
            displayText = 'Agent Mode is preparing a tool call...';
        } else {
            try {
                const toolCall = parseAgentToolCall(text);
                const tool = toolCall ? this._tools.getTool(toolCall.name) : null;
                displayText = toolCall
                    ? (tool ? `Agent Mode requested ${tool.label}...` : 'Agent Mode requested a tool...')
                    : text;
            } catch (_error) {
                displayText = text;
            }
        }

        if (typeof assistantView.set_stream_text === 'function')
            assistantView.set_stream_text(text, displayText);
        else
            assistantView.set_label(displayText);

        this._updateUsageDisplay(conversation);
        this._scrollToBottom();
    }

    _parseAgentToolCallForRuntime(responseText, conversation, runtimeMessages) {
        try {
            return parseAgentToolCall(responseText);
        } catch (error) {
            const reason = error.userMessage ?? error.message;
            const message = createMessage('system', reason);
            this._conversations.appendMessage(conversation.id, message);
            this._addMessage(message.content, message.role, message);
            runtimeMessages.push(
                { role: 'assistant', content: responseText },
                { role: 'user', content: createAgentToolFailurePrompt({ name: 'unknown' }, reason) },
            );
            return { invalid: true };
        }
    }

    _createAgentToolRequest(toolCall, responseText, conversation, runtimeMessages) {
        try {
            return this._tools.createRequest(toolCall.name, toolCall.input);
        } catch (error) {
            const reason = error.userMessage ?? error.message;
            const message = createMessage('system', reason);
            this._conversations.appendMessage(conversation.id, message);
            this._addMessage(message.content, message.role, message);
            runtimeMessages.push(
                { role: 'assistant', content: responseText },
                { role: 'user', content: createAgentToolFailurePrompt(toolCall, reason) },
            );
            return null;
        }
    }

    async _runAgentToolRequest(request, responseText, conversation, runtimeMessages, cancellable = null) {
        if (isCancellableCancelled(cancellable)) {
            this._appendAgentToolCancellation(request, responseText, conversation, runtimeMessages);
            return false;
        }

        const permissionDecision = createToolPermissionDecision(request, {
            autoModeEnabled: this._appSettings.autoModeEnabled,
        });

        if (permissionDecision.status === 'deny') {
            const reason = `${request.label} is blocked by policy.`;
            this._appendAgentToolFailure(request, responseText, conversation, runtimeMessages, reason);
            return false;
        }

        if (permissionDecision.requiresUserApproval && !await this._confirmToolPermission(request, cancellable)) {
            if (isCancellableCancelled(cancellable)) {
                this._appendAgentToolCancellation(request, responseText, conversation, runtimeMessages);
                return false;
            }

            const reason = `${request.label} was not run because permission was denied.`;
            this._appendAgentToolFailure(request, responseText, conversation, runtimeMessages, reason);
            return false;
        }

        try {
            const result = await this._tools.runRequest(request, {
                timeoutSeconds: this._appSettings.responseTimeoutSeconds,
                cancellable,
            });
            const transcriptText = formatToolResultForTranscript(result);
            const message = createMessage('system', transcriptText, {
                toolCall: {
                    name: result.name,
                    label: result.label,
                    input: result.input,
                    output: result.output ?? '',
                    results: result.results ?? [],
                    status: result.cancelled ? 'cancelled' : 'completed',
                    agentMode: true,
                    createdAt: new Date().toISOString(),
                },
            });
            this._conversations.appendMessage(conversation.id, message);
            this._addMessage(message.content, message.role, message);
            this._updateUsageDisplay(conversation);

            if (result.cancelled)
                return false;

            runtimeMessages.push(
                { role: 'assistant', content: responseText },
                { role: 'user', content: createAgentToolResultPrompt(request, transcriptText) },
            );
            return true;
        } catch (error) {
            if (wasOperationCancelled(error, cancellable)) {
                this._appendAgentToolCancellation(request, responseText, conversation, runtimeMessages);
                return false;
            }

            const reason = error.userMessage ?? `Tool failed: ${error.message}`;
            this._appendAgentToolFailure(request, responseText, conversation, runtimeMessages, reason);
            logError(error, 'Failed to run Agent Mode tool request');
            return false;
        }
    }

    _appendAgentToolCancellation(request, responseText, conversation, runtimeMessages) {
        const reason = `${request.label} was stopped before it finished.`;
        this._appendAgentToolFailure(request, responseText, conversation, runtimeMessages, reason, 'cancelled');
    }

    _appendAgentToolFailure(request, responseText, conversation, runtimeMessages, reason, status = 'failed') {
        const message = createMessage('system', reason, {
            toolCall: {
                name: request.name,
                label: request.label,
                input: request.input,
                output: reason,
                results: [],
                status,
                agentMode: true,
                createdAt: new Date().toISOString(),
            },
        });
        this._conversations.appendMessage(conversation.id, message);
        this._addMessage(message.content, message.role, message);
        this._updateUsageDisplay(conversation);
        runtimeMessages.push(
            { role: 'assistant', content: responseText },
            { role: 'user', content: createAgentToolFailurePrompt(request, reason) },
        );
    }

    _beginActiveTurn(cancellable = new Gio.Cancellable()) {
        if (this._activeChatCancellable)
            return null;

        this._activeChatCancellable = cancellable;
        this._setComposerBusy(true);
        return cancellable;
    }

    _finishActiveTurn(cancellable) {
        if (this._activeChatCancellable === cancellable)
            this._activeChatCancellable = null;

        this._setComposerBusy(false);
    }

    _stopActiveConversation() {
        const cancellable = this._activeChatCancellable;

        if (!cancellable)
            return false;

        if (!isCancellableCancelled(cancellable))
            cancellable.cancel();

        return true;
    }

    _appendStoppedMessage(conversationId, text) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return null;

        const message = createMessage('system', text);
        this._conversations.appendMessage(conversation.id, message);
        this._addMessage(message.content, message.role, message);
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
        this._addMessage(message.content, message.role, message);
        this._updateUsageDisplay(this._conversations.getConversation(conversationId));
        return message;
    }

    _createStreamingAssistantView(conversation) {
        let view = null;
        let assistantMessage = null;
        let currentText = '';
        let currentReasoning = '';
        let currentUsage = null;

        const ensureView = () => {
            if (!view)
                view = this._addMessage('', 'assistant');

            return view;
        };

        const ensureMessage = (text) => {
            if (assistantMessage)
                return assistantMessage;

            assistantMessage = createMessage('assistant', text);
            this._conversations.appendMessage(conversation.id, assistantMessage);
            return assistantMessage;
        };

        const updatePersistentText = (text, displayText = text) => {
            currentText = String(text ?? '');
            const message = ensureMessage(currentText);

            this._conversations.updateMessageContent(conversation.id, message.id, currentText);
            ensureView().set_label(displayText);
        };

        const updatePersistentReasoning = (reasoning) => {
            currentReasoning = String(reasoning ?? '');
            const message = ensureMessage(currentText);

            this._conversations.updateMessageReasoning(conversation.id, message.id, {
                content: currentReasoning,
                providerId: conversation.providerId,
                modelId: conversation.modelId,
                thinkingLevel: conversation.thinkingLevel,
                createdAt: new Date().toISOString(),
            });
            ensureView().set_reasoning(currentReasoning);
        };

        const updatePersistentUsage = (usage) => {
            currentUsage = normalizeTokenUsage(usage, {
                providerId: conversation.providerId,
                modelId: conversation.modelId,
                thinkingLevel: conversation.thinkingLevel,
                createdAt: new Date().toISOString(),
            });

            if (!currentUsage)
                return;

            const message = ensureMessage(currentText);
            this._conversations.updateMessageUsage(conversation.id, message.id, currentUsage);
        };

        return {
            set_label: (text) => updatePersistentText(text, text),
            set_stream_text: updatePersistentText,
            set_reasoning: updatePersistentReasoning,
            set_usage: updatePersistentUsage,
            set_status: (text) => ensureView().set_label(text),
            hasContent: () => currentText.length > 0 || currentReasoning.length > 0 || Boolean(currentUsage),
        };
    }

    _startLongResponseNotification() {
        this._stopLongResponseNotification();
        this._longResponseNotificationId = `long-response-${GLib.uuid_string_random()}`;
        this._longResponseNotificationSent = false;
        this._longResponseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            const notification = new Gio.Notification();
            notification.set_title('Cusco is still responding');
            notification.set_body('The current response is taking longer than usual.');
            this.get_application()?.send_notification(this._longResponseNotificationId, notification);
            this._longResponseNotificationSent = true;
            this._longResponseTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopLongResponseNotification() {
        if (this._longResponseTimeoutId) {
            GLib.source_remove(this._longResponseTimeoutId);
            this._longResponseTimeoutId = 0;
        }

        if (this._longResponseNotificationSent && this._longResponseNotificationId)
            this.get_application()?.withdraw_notification(this._longResponseNotificationId);

        this._longResponseNotificationSent = false;
        this._longResponseNotificationId = null;
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
        this._sidebar.set_size_request(compact ? 220 : 280, -1);

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
        const latestUserMessage = [...conversation.messages]
            .reverse()
            .find((message) => message.role === 'user');
        const memories = this._memories.getMemoriesForConversation(conversation, {
            latestText: latestUserMessage?.content ?? '',
        });

        if (memories.length === 0)
            return;

        const auditMessage = createMessage(
            'system',
            `Memory used for this response:\n${memories.map((memory) => `- ${memory.content}`).join('\n')}`,
        );
        this._conversations.appendMessage(conversation.id, auditMessage);
        this._memories.recordMemoryUse(memories.map((memory) => memory.id), {
            conversationId: conversation.id,
            messageId: auditMessage.id,
        });
        this._addMessage(auditMessage.content, auditMessage.role, auditMessage);
        this._updateUsageDisplay(conversation);
    }

    _injectSkillContext(conversation) {
        return this._workspace.getSkillsForConversation(conversation);
    }

    _buildProviderMessages(conversation, skills, options = {}) {
        const systemMessages = [{
            role: 'system',
            content: BASE_RESPONSE_SYSTEM_PROMPT,
        }];

        if (options.agentMode) {
            systemMessages.push({
                role: 'system',
                content: buildAgentModeSystemPrompt(this._tools.listTools()),
            });
        }

        const skillContext = buildSkillContext(skills);

        if (skillContext) {
            systemMessages.push({
                role: 'system',
                content: skillContext,
            });
        }

        return [
            ...systemMessages,
            ...conversation.messages,
        ];
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

    _appendSystemError(text) {
        const conversation = this._conversations.activeConversation;

        if (conversation)
            this._conversations.appendMessage(conversation.id, createMessage('system', text));

        this._addMessage(text, 'system');
        this._updateUsageDisplay(conversation);
    }

    _populateProviderPicker() {
        const providerStore = new Gtk.ListStore();
        let providerCount = 0;

        providerStore.set_column_types([
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            Gio.Icon.$gtype,
        ]);

        for (const provider of this._providerConfigs.listProviders({ enabledOnly: true, usableOnly: false })) {
            const iter = providerStore.append();
            providerCount++;
            providerStore.set(iter, [
                PROVIDER_PICKER_ID_COLUMN,
                PROVIDER_PICKER_NAME_COLUMN,
                PROVIDER_PICKER_ICON_COLUMN,
            ], [
                provider.id,
                provider.name,
                getProviderGIcon(provider),
            ]);
        }

        this._providerPicker.set_model(providerStore);
        this._providerPicker.set_id_column(PROVIDER_PICKER_ID_COLUMN);
        this._syncProviderSelectorVisibility(providerCount > 0);
    }

    _syncProviderSelectorVisibility(hasEnabledProviders) {
        this._providerPicker?.set_visible(hasEnabledProviders);
        this._modelPicker?.set_visible(hasEnabledProviders);
        this._providerConfigButton?.set_visible(!hasEnabledProviders);
    }

    _populateModelPicker(providerId, selectedModelId = null) {
        const provider = this._providerConfigs.getProvider(providerId);
        this._modelPicker.remove_all();

        for (const model of provider?.models ?? [])
            this._modelPicker.append(model.id, model.name);

        const fallbackModel = this._providerConfigs.getDefaultModel(providerId);
        this._modelPicker.set_active_id(selectedModelId ?? fallbackModel?.id ?? null);
    }

    _populateThinkingLevelPicker(conversation) {
        if (!this._thinkingLevelPicker)
            return;

        this._thinkingLevelPicker.remove_all();

        if (!conversation) {
            this._thinkingLevelPicker.append(DEFAULT_THINKING_LEVEL, getThinkingLevelLabel(DEFAULT_THINKING_LEVEL));
            this._thinkingLevelPicker.set_active_id(DEFAULT_THINKING_LEVEL);
            this._thinkingLevelPicker.set_sensitive(false);
            return;
        }

        const levels = this._providerConfigs.getThinkingLevels(conversation.providerId, conversation.modelId);

        if (levels.length === 0) {
            this._thinkingLevelPicker.append('off', getThinkingLevelLabel('off'));
            this._thinkingLevelPicker.set_active_id('off');
            this._thinkingLevelPicker.set_tooltip_text('Thinking is not supported by this provider and model.');
            this._thinkingLevelPicker.set_sensitive(false);
            return;
        }

        for (const level of levels)
            this._thinkingLevelPicker.append(level, getThinkingLevelLabel(level));

        const currentLevel = normalizeThinkingLevel(conversation.thinkingLevel ?? this._appSettings.thinkingLevel);
        const selectedLevel = levels.includes(currentLevel)
            ? currentLevel
            : levels.includes(DEFAULT_THINKING_LEVEL)
                ? DEFAULT_THINKING_LEVEL
                : levels[0];

        this._thinkingLevelPicker.set_active_id(selectedLevel);
        this._thinkingLevelPicker.set_tooltip_text('Thinking level for this chat');
        this._thinkingLevelPicker.set_sensitive(true);
    }

    _createProviderPicker() {
        const picker = new Gtk.ComboBox({
            id_column: PROVIDER_PICKER_ID_COLUMN,
        });
        const iconRenderer = new Gtk.CellRendererPixbuf({
            xpad: 2,
        });
        const textRenderer = new Gtk.CellRendererText({
            ellipsize: Pango.EllipsizeMode.END,
        });

        picker.pack_start(iconRenderer, false);
        picker.add_attribute(iconRenderer, 'gicon', PROVIDER_PICKER_ICON_COLUMN);
        picker.pack_start(textRenderer, true);
        picker.add_attribute(textRenderer, 'text', PROVIDER_PICKER_NAME_COLUMN);

        return picker;
    }

    _createProviderConfigButton() {
        const button = new Gtk.Button({
            label: 'Configure Provider',
            tooltip_text: 'Configure an AI provider',
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        button.add_css_class('suggested-action');
        button.connect('clicked', () => this._showSettingsDialog({ initialPage: 'providers' }));
        return button;
    }

    _createChatOptionsMenuButton() {
        const menuButton = new Gtk.MenuButton({
            label: 'Chat Options',
            tooltip_text: 'Chat options',
        });
        const popover = new Gtk.Popover();
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 10,
            margin_end: 10,
        });

        this._thinkingLevelPicker = new Gtk.ComboBoxText({
            tooltip_text: 'Thinking level',
        });
        this._thinkingLevelPicker.connect('changed', () => this._handleThinkingLevelChanged());

        this._memoryToggleButton = new Gtk.Switch({
            tooltip_text: 'Use memories for this chat',
            valign: Gtk.Align.CENTER,
        });
        this._memoryToggleButton.connect('notify::active', () => this._handleMemoryToggleChanged());

        this._agentModeToggleButton = new Gtk.Switch({
            tooltip_text: 'Agent mode',
            valign: Gtk.Align.CENTER,
        });
        this._agentModeToggleButton.connect('notify::active', () => this._handleAgentModeToggleChanged());

        this._skillsToggleButton = new Gtk.Switch({
            tooltip_text: 'Use enabled skills for this chat',
            valign: Gtk.Align.CENTER,
        });
        this._skillsToggleButton.connect('notify::active', () => this._handleSkillsToggleChanged());

        content.append(createLabeledControlRow('Thinking', this._thinkingLevelPicker));
        content.append(createLabeledControlRow('Memory', this._memoryToggleButton));
        content.append(createLabeledControlRow('Agent mode', this._agentModeToggleButton));
        content.append(createLabeledControlRow('Skills', this._skillsToggleButton));

        popover.set_child(new Gtk.ScrolledWindow({
            child: content,
            max_content_height: 240,
            min_content_width: 320,
            propagate_natural_height: true,
        }));
        this._chatOptionsMenuButton = menuButton;
        menuButton.set_popover(popover);
        return menuButton;
    }

    _createPromptMenuButton() {
        const menuButton = new Gtk.MenuButton({
            tooltip_text: 'Insert prompt',
        });
        const popover = new Gtk.Popover();

        menuButton.set_child(createBundledIcon(PROMPT_ICON_FILE, 'insert-text-symbolic'));
        menuButton.set_popover(popover);
        this._promptMenuButton = menuButton;
        this._promptMenuPopover = popover;
        this._refreshPromptMenu();
        return menuButton;
    }

    _refreshPromptMenu() {
        if (!this._promptMenuPopover || !this._promptMenuButton)
            return;

        const prompts = this._workspace.prompts;
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
        });

        if (prompts.length === 0) {
            const emptyLabel = new Gtk.Label({
                label: 'No saved prompts',
                xalign: 0,
            });
            emptyLabel.add_css_class('dim-label');
            box.append(emptyLabel);
        }

        for (const prompt of prompts) {
            const variableText = formatPromptVariables(prompt.content);
            const button = new Gtk.Button({
                halign: Gtk.Align.FILL,
                tooltip_text: [prompt.content, variableText].filter(Boolean).join('\n'),
            });
            button.add_css_class('flat');

            const labels = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 2,
                margin_top: 4,
                margin_bottom: 4,
                margin_start: 6,
                margin_end: 6,
            });
            const titleLabel = new Gtk.Label({
                label: prompt.title,
                xalign: 0,
                ellipsize: Pango.EllipsizeMode.END,
            });
            const contentLabel = new Gtk.Label({
                label: prompt.content,
                xalign: 0,
                ellipsize: Pango.EllipsizeMode.END,
            });
            contentLabel.add_css_class('caption');
            contentLabel.add_css_class('dim-label');

            labels.append(titleLabel);
            labels.append(contentLabel);

            if (variableText) {
                const variableLabel = new Gtk.Label({
                    label: variableText,
                    xalign: 0,
                    ellipsize: Pango.EllipsizeMode.END,
                });
                variableLabel.add_css_class('caption');
                variableLabel.add_css_class('dim-label');
                labels.append(variableLabel);
            }

            button.set_child(labels);
            button.connect('clicked', () => {
                this._promptMenuPopover.popdown();
                this._insertPrompt(prompt);
            });
            box.append(button);
        }

        this._promptMenuPopover.set_child(new Gtk.ScrolledWindow({
            child: box,
            max_content_height: 360,
            min_content_width: 320,
            propagate_natural_height: true,
        }));
    }

    _insertPrompt(prompt) {
        const content = String(prompt?.content ?? '').trim();

        if (!content || !this._composer)
            return;

        const variables = extractPromptVariables(content);

        if (variables.length > 0) {
            this._promptForPromptVariables(prompt, variables);
            return;
        }

        this._insertPromptContent(content);
    }

    _promptForPromptVariables(prompt, variables) {
        const entries = new Map();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        const dialog = new Adw.AlertDialog({
            heading: 'Fill Prompt Variables',
            body: String(prompt?.title ?? ''),
        });

        const syncInsertEnabled = () => {
            dialog.set_response_enabled('insert', variables.every((name) => (
                entries.get(name)?.get_text().trim()
            )));
        };

        for (const name of variables) {
            const row = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 3,
            });
            const label = new Gtk.Label({
                label: name,
                xalign: 0,
            });
            const entry = new Gtk.Entry({
                placeholder_text: name,
                hexpand: true,
                activates_default: true,
            });

            entry.connect('changed', syncInsertEnabled);
            entries.set(name, entry);
            row.append(label);
            row.append(entry);
            box.append(row);
        }

        dialog.set_extra_child(box);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('insert', 'Insert');
        dialog.set_default_response('insert');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('insert', Adw.ResponseAppearance.SUGGESTED);
        syncInsertEnabled();
        dialog.choose(this, null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'insert')
                return;

            const values = {};

            for (const name of variables)
                values[name] = entries.get(name).get_text().trim();

            this._insertPromptContent(renderPromptTemplate(prompt.content, values).trim());
        });
    }

    _insertPromptContent(content) {
        const existingText = this._getComposerText();
        const cursorIter = this._composerBuffer.get_iter_at_mark(this._composerBuffer.get_insert());
        const cursorPosition = Math.max(cursorIter.get_offset(), 0);
        const before = existingText.slice(0, cursorPosition);
        const after = existingText.slice(cursorPosition);
        const beforeSeparator = before && !/\s$/.test(before) ? ' ' : '';
        const afterSeparator = after && !/^\s/.test(after) ? ' ' : '';
        const nextText = `${before}${beforeSeparator}${content}${afterSeparator}${after}`;
        const nextCursorPosition = before.length + beforeSeparator.length + content.length;

        this._setComposerText(nextText);
        this._composerBuffer.place_cursor(this._composerBuffer.get_iter_at_offset(nextCursorPosition));
        this.focusComposer();
    }

    _syncProviderControls(conversation) {
        if (!conversation)
            return;

        this._isUpdatingProviderControls = true;
        this._providerPicker.set_active_id(conversation.providerId);
        this._populateModelPicker(conversation.providerId, conversation.modelId);
        this._populateThinkingLevelPicker(conversation);
        this._memoryToggleButton.set_active(conversation.memoryEnabled !== false);
        this._agentModeToggleButton.set_active(Boolean(conversation.agentModeEnabled));
        this._skillsToggleButton.set_active(this._workspace.getSkillsForConversation(conversation).length > 0);
        this._skillsToggleButton.set_sensitive(this._workspace.enabledSkills.length > 0);
        this._isUpdatingProviderControls = false;
    }

    _handleMemoryToggleChanged() {
        if (this._isUpdatingProviderControls)
            return;

        const conversation = this._conversations.activeConversation;

        if (!conversation)
            return;

        this._conversations.setMemoryEnabled(conversation.id, this._memoryToggleButton.get_active());
        this._refreshConversationList();
    }

    _handleAgentModeToggleChanged() {
        if (this._isUpdatingProviderControls)
            return;

        const conversation = this._conversations.activeConversation;

        if (!conversation)
            return;

        this._conversations.setAgentModeEnabled(conversation.id, this._agentModeToggleButton.get_active());
        this._refreshConversationList();
    }

    _handleSkillsToggleChanged() {
        if (this._isUpdatingProviderControls)
            return;

        const conversation = this._conversations.activeConversation;

        if (!conversation)
            return;

        const skillIds = this._skillsToggleButton.get_active()
            ? this._workspace.enabledSkills.map((skill) => skill.id)
            : [];

        this._conversations.setSkillIds(conversation.id, skillIds);
        this._refreshConversationList();
    }

    _resolveThinkingLevelForSelection(providerId, modelId, currentLevel) {
        const levels = this._providerConfigs.getThinkingLevels(providerId, modelId);

        if (levels.length === 0)
            return normalizeThinkingLevel(currentLevel ?? this._appSettings.thinkingLevel);

        const normalizedLevel = normalizeThinkingLevel(currentLevel ?? this._appSettings.thinkingLevel);

        if (levels.includes(normalizedLevel))
            return normalizedLevel;

        return levels.includes(DEFAULT_THINKING_LEVEL) ? DEFAULT_THINKING_LEVEL : levels[0];
    }

    _handleThinkingLevelChanged() {
        if (this._isUpdatingProviderControls)
            return;

        const conversation = this._conversations.activeConversation;
        const thinkingLevel = this._thinkingLevelPicker.get_active_id();

        if (!conversation || !thinkingLevel)
            return;

        this._conversations.setThinkingLevel(conversation.id, thinkingLevel);
        this._refreshConversationList();
    }

    _handleProviderChanged() {
        if (this._isUpdatingProviderControls)
            return;

        const conversation = this._conversations.activeConversation;
        const providerId = this._providerPicker.get_active_id();

        if (!conversation || !providerId)
            return;

        const model = this._providerConfigs.getDefaultModel(providerId);
        this._conversations.updateProviderConfig(conversation.id, {
            providerId,
            modelId: model?.id ?? '',
        });
        this._conversations.setThinkingLevel(
            conversation.id,
            this._resolveThinkingLevelForSelection(providerId, model?.id ?? '', conversation.thinkingLevel),
        );
        this._providerConfigs.setActiveSelection(providerId, model?.id ?? '');
        this._syncProviderControls(conversation);
        this._refreshConversationList();
    }

    _handleModelChanged() {
        if (this._isUpdatingProviderControls)
            return;

        const conversation = this._conversations.activeConversation;
        const modelId = this._modelPicker.get_active_id();

        if (!conversation || !modelId)
            return;

        this._conversations.updateProviderConfig(conversation.id, {
            providerId: conversation.providerId,
            modelId,
        });
        this._conversations.setThinkingLevel(
            conversation.id,
            this._resolveThinkingLevelForSelection(conversation.providerId, modelId, conversation.thinkingLevel),
        );
        this._providerConfigs.setActiveSelection(conversation.providerId, modelId);
        this._syncProviderControls(conversation);
        this._refreshConversationList();
    }

    _refreshConversationList() {
        this._isRefreshingConversations = true;
        this._clearBox(this._conversationList);

        const activeConversation = this._conversations.activeConversation;

        for (const conversation of this._getVisibleConversations()) {
            const row = new Gtk.ListBoxRow();
            row.conversationId = conversation.id;
            row.set_child(this._createConversationRow(conversation, row));
            this._conversationList.append(row);

            if (conversation.id === activeConversation?.id)
                this._conversationList.select_row(row);
        }

        this._isRefreshingConversations = false;
    }

    _getVisibleConversations() {
        return this._conversations.searchConversations(this._chatSearch?.get_text() ?? '');
    }

    _isCronConversation(conversation) {
        return conversation?.conversationType === 'cron' && Boolean(conversation.cronJobId);
    }

    _createConversationRow(conversation, hoverTarget = null) {
        const providerConfig = this._providerConfigs.resolve(conversation.providerId, conversation.modelId);
        const cronJob = this._isCronConversation(conversation)
            ? this._cronJobIndex.get(conversation.cronJobId)
            : null;
        const rowBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            margin_top: 4,
            margin_bottom: 4,
            margin_start: 6,
            margin_end: 6,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });

        const title = new Gtk.Label({
            label: conversation.title,
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        });

        const titleRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            hexpand: true,
        });

        if (this._isCronConversation(conversation)) {
            const cronIcon = new Gtk.Image({
                icon_name: 'alarm-symbolic',
                tooltip_text: 'Cron job chat',
                valign: Gtk.Align.CENTER,
            });
            cronIcon.set_pixel_size(14);
            cronIcon.add_css_class('cusco-cron-chat-icon');
            titleRow.append(cronIcon);
        }
        titleRow.append(title);

        const organizationLabel = [
            conversation.folderId ? `Folder ${conversation.folderId}` : '',
            ...(conversation.tags ?? []).map((tag) => `#${tag}`),
        ].filter(Boolean).join(' ');
        const subtitle = new Gtk.Label({
            label: this._isCronConversation(conversation)
                ? [
                    cronJob ? (cronJob.enabled ? 'Enabled' : 'Disabled') : 'Missing crontab entry',
                    cronJob?.schedule ?? '',
                    organizationLabel,
                ].filter(Boolean).join(' / ')
                : [
                    conversation.archived ? 'Archived' : '',
                    conversation.agentModeEnabled ? 'Agent Mode' : '',
                    `${providerConfig.provider.name} / ${providerConfig.model?.name ?? 'No model'}`,
                    organizationLabel,
                ].filter(Boolean).join(' / '),
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
        });
        subtitle.add_css_class('caption');
        subtitle.add_css_class('dim-label');

        box.append(titleRow);
        box.append(subtitle);

        const actions = this._createConversationMenuButton(conversation, hoverTarget ?? rowBox);

        rowBox.append(box);
        rowBox.append(actions);
        return rowBox;
    }

    _createConversationMenuButton(conversation, hoverTarget) {
        const menuButton = new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            tooltip_text: 'Chat actions',
            valign: Gtk.Align.CENTER,
        });
        menuButton.add_css_class('flat');
        menuButton.add_css_class('cusco-conversation-menu-button');

        const popover = new Gtk.Popover();
        const menu = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        menu.add_css_class('cusco-conversation-menu');

        const addMenuItem = (iconName, label, onClicked, options = {}) => {
            menu.append(this._createConversationMenuItem(iconName, label, () => {
                popover.popdown();
                onClicked();
            }, options));
        };

        addMenuItem('document-edit-symbolic', 'Rename chat', () => {
            this._renameConversation(conversation.id);
        });

        if (this._isCronConversation(conversation)) {
            addMenuItem('user-trash-symbolic', 'Delete cron job', () => {
                this._confirmDeleteCronJobConversation(conversation.id);
            }, { destructive: true });
        } else {
            addMenuItem('document-save-symbolic', 'Export chat', () => {
                this._exportConversation(conversation.id);
            });
            addMenuItem('user-trash-symbolic', 'Delete chat', () => {
                this._confirmDeleteConversation(conversation.id);
            }, { destructive: true });
        }

        popover.set_child(menu);
        menuButton.set_popover(popover);

        const setMenuVisible = (visible) => {
            menuButton.set_opacity(visible ? 1 : 0);
            menuButton.set_sensitive(visible);
        };
        let isHovered = false;
        const syncMenuVisibility = () => setMenuVisible(isHovered || popover.get_visible());
        const motionController = new Gtk.EventControllerMotion();

        motionController.connect('enter', () => {
            isHovered = true;
            syncMenuVisibility();
        });
        motionController.connect('leave', () => {
            isHovered = false;
            syncMenuVisibility();
        });
        popover.connect('closed', syncMenuVisibility);

        hoverTarget.add_controller(motionController);
        setMenuVisible(false);

        return menuButton;
    }

    _createConversationMenuItem(iconName, label, onClicked, options = {}) {
        const button = new Gtk.Button({
            icon_name: iconName,
            tooltip_text: label,
            halign: Gtk.Align.FILL,
        });
        button.add_css_class('flat');
        button.add_css_class('cusco-conversation-menu-item');

        if (options.destructive)
            button.add_css_class('destructive-action');

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 4,
            margin_bottom: 4,
            margin_start: 6,
            margin_end: 6,
        });
        content.append(new Gtk.Image({ icon_name: iconName }));
        content.append(new Gtk.Label({
            label,
            xalign: 0,
            hexpand: true,
        }));
        button.set_child(content);
        button.connect('clicked', onClicked);
        return button;
    }

    _renameConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        const entry = new Gtk.Entry({
            text: conversation.title,
            hexpand: true,
        });
        const dialog = new Adw.AlertDialog({
            heading: 'Rename Chat',
        });
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('rename', 'Rename');
        dialog.set_default_response('rename');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('rename', Adw.ResponseAppearance.SUGGESTED);
        dialog.choose(this, null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'rename')
                return;

            this._conversations.renameConversation(conversationId, entry.get_text());
            this._refreshConversationList();
            this._renderActiveConversation();
        });
    }

    _exportConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        const dialog = new Adw.AlertDialog({
            heading: 'Export Chat',
            body: conversation.title,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('markdown', 'Markdown');
        dialog.add_response('json', 'JSON');
        dialog.add_response('pdf', 'PDF');
        dialog.set_default_response('markdown');
        dialog.set_close_response('cancel');
        dialog.choose(this, null, (_dialog, result) => {
            const format = dialog.choose_finish(result);

            if (format === 'cancel')
                return;

            this._saveConversationExport(conversation, format);
        });
    }

    _saveConversationExport(conversation, format) {
        const extension = format === 'markdown' ? 'md' : format;
        const dialog = new Gtk.FileDialog({
            title: 'Save Conversation',
            initial_name: `${conversation.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'conversation'}.${extension}`,
        });

        dialog.save(this, null, (_dialog, result) => {
            try {
                const file = dialog.save_finish(result);
                const path = file.get_path();

                if (!path)
                    throw new Error('Only local export paths are supported right now');

                GLib.file_set_contents(path, exportConversation(conversation, format));
            } catch (error) {
                logError(error, 'Failed to export conversation');
            }
        });
    }

    _confirmDeleteConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        const dialog = new Adw.AlertDialog({
            heading: 'Delete Chat?',
            body: conversation.title,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(this, null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'delete')
                return;

            this._conversations.deleteConversation(conversationId);

            if (this._conversations.allConversations.length === 0)
                this._conversations.createConversation();

            this._refreshConversationList();
            this._renderActiveConversation();
        });
    }

    _confirmDeleteCronJobConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation || !this._isCronConversation(conversation))
            return;

        const dialog = new Adw.AlertDialog({
            heading: 'Delete Cron Job?',
            body: conversation.title,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(this, null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'delete')
                return;

            this._cron.deleteJob(conversation.cronJobId).then(() => {
                this._deleteCronConversation(conversation.cronJobId);
            }).catch((error) => {
                logError(error, 'Failed to delete cron job from chat');
                this._appendSystemError(error.userMessage ?? error.message);
            });
        });
    }

    _renderActiveConversation() {
        const conversation = this._conversations.activeConversation;
        this._clearBox(this._messages);
        this._appendMessageBottomSpacer();
        this._lastAssistantMessageView = null;
        this._syncProviderControls(conversation);

        for (const message of conversation?.messages ?? [])
            this._addMessage(message.content, message.role, message);

        this._updateUsageDisplay(conversation);
        this._scrollToBottom();
    }

    _updateUsageDisplay(conversation = this._conversations.activeConversation, pendingAssistantText = '') {
        if (!this._windowTitle)
            return;

        const messages = [...(conversation?.messages ?? [])];

        if (pendingAssistantText)
            messages.push({ content: pendingAssistantText });

        const usage = estimateConversationUsage(messages);
        this._windowTitle.set_subtitle(`${usage.tokens} est. tokens · ${usage.messages} messages`);
    }

    _setComposerBusy(isBusy) {
        this._composer.set_sensitive(!isBusy);
        this._attachButton.set_sensitive(!isBusy);
        this._syncComposerHint(isBusy);

        this._newChatButton.set_sensitive(!isBusy);
        this._chatSearch.set_sensitive(!isBusy);
        this._promptMenuButton.set_sensitive(!isBusy);
        this._conversationList.set_sensitive(!isBusy);
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
        this._settingsButton.set_sensitive(!isBusy);
    }

    _messageContentOptions(options = {}) {
        return {
            codeTheme: this._appSettings.codeTheme,
            ...options,
        };
    }

    _createToolResultExpander(message, options = {}) {
        const statusLabel = message.toolCall.status === 'failed'
            ? 'failed'
            : message.toolCall.status === 'cancelled'
                ? 'cancelled'
                : 'result';
        const expander = new Gtk.Expander({
            label: `${message.toolCall.label} ${statusLabel}`,
            expanded: false,
            hexpand: true,
        });
        expander.add_css_class('cusco-tool-result');

        if (!options.embedded)
            expander.set_size_request(460, -1);

        const bodyContent = createMessageContent(message.content, this._messageContentOptions({
            role: 'system',
            hexpand: true,
            codeMinWidth: 380,
        }));

        if (!options.embedded) {
            bodyContent.add_css_class('cusco-message-bubble');
            bodyContent.add_css_class('cusco-message-assistant');
        }

        expander.set_child(bodyContent);
        return expander;
    }

    _addMessage(body, kind, message = null) {
        if (message?.toolCall?.agentMode && this._lastAssistantMessageView?.append_tool_result) {
            this._lastAssistantMessageView.append_tool_result(message);
            this._scrollToBottom();
            return {
                set_label: () => {},
            };
        }

        if (message?.toolCall)
            return this._addToolMessage(message);

        const wrapper = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 4,
            margin_bottom: 4,
            halign: kind === 'user' ? Gtk.Align.END : Gtk.Align.START,
        });
        const reasoningText = kind === 'assistant'
            ? getMessageReasoningContent(message)
            : '';
        let reasoningContent = null;
        let reasoningExpander = null;

        if (kind === 'assistant') {
            reasoningExpander = new Gtk.Expander({
                label: 'Reasoning',
                expanded: false,
                visible: Boolean(reasoningText),
                hexpand: true,
            });
            reasoningExpander.add_css_class('cusco-reasoning');
            reasoningContent = createMessageContent(reasoningText || ' ', this._messageContentOptions({
                role: 'assistant',
                hexpand: true,
                codeMinWidth: 380,
            }));
            reasoningContent.add_css_class('cusco-message-bubble');
            reasoningContent.add_css_class('cusco-message-assistant');
            reasoningExpander.set_child(reasoningContent);
            wrapper.append(reasoningExpander);
        }

        const bubble = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: Boolean(kind !== 'user'),
        });
        bubble.add_css_class('cusco-message-bubble');
        bubble.add_css_class(kind === 'user' ? 'cusco-message-user' : 'cusco-message-assistant');

        const bodyContent = createMessageContent(body, this._messageContentOptions({
            role: kind,
        }));
        bubble.append(bodyContent);

        let toolResultsBox = null;
        const appendToolResult = (toolMessage) => {
            if (!toolResultsBox) {
                toolResultsBox = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    spacing: 4,
                    hexpand: true,
                });
                bubble.append(toolResultsBox);
            }

            toolResultsBox.append(this._createToolResultExpander(toolMessage, { embedded: true }));
        };

        wrapper.append(bubble);

        if (message?.id && kind !== 'system')
            wrapper.append(this._createMessageActions(message));

        this._appendMessageWidget(wrapper);
        this._scrollToBottom();

        const messageView = {
            set_label: (text) => bodyContent.updateContent(text),
            set_reasoning: (text) => {
                if (!reasoningContent || !reasoningExpander)
                    return;

                const nextText = String(text ?? '').trim();
                reasoningContent.updateContent(nextText || ' ');
                reasoningExpander.set_visible(Boolean(nextText));
            },
            append_tool_result: appendToolResult,
        };

        if (kind === 'assistant')
            this._lastAssistantMessageView = messageView;
        else
            this._lastAssistantMessageView = null;

        return messageView;
    }

    _addToolMessage(message) {
        const wrapper = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 4,
            margin_bottom: 4,
            hexpand: true,
            halign: Gtk.Align.START,
        });
        wrapper.append(this._createToolResultExpander(message));
        this._appendMessageWidget(wrapper);
        this._lastAssistantMessageView = null;
        this._scrollToBottom();

        return {
            set_label: () => {},
        };
    }

    _createMessageActions(message) {
        const actions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            halign: message.role === 'user' ? Gtk.Align.END : Gtk.Align.START,
        });
        actions.add_css_class('cusco-message-actions');

        if (message.role === 'user') {
            actions.append(this._createMessageActionButton('document-edit-symbolic', 'Edit message', () => {
                this._editMessage(message);
            }));
            actions.append(this._createMessageActionButton('view-refresh-symbolic', 'Retry from message', () => {
                this._retryFromMessage(message);
            }));
        } else if (message.role === 'assistant') {
            actions.append(this._createMessageActionButton('view-refresh-symbolic', 'Regenerate response', () => {
                this._regenerateFromMessage(message);
            }));
        }

        actions.append(this._createMessageActionButton('edit-copy-symbolic', 'Copy message', () => {
            copyTextToClipboard(message.content);
        }));

        actions.append(this._createMessageActionButton('tab-new-symbolic', 'Branch from message', () => {
            this._branchFromMessage(message);
        }, { iconFile: GIT_BRANCH_ICON_FILE }));

        return actions;
    }

    _createMessageActionButton(iconName, tooltipText, onClicked, options = {}) {
        const button = new Gtk.Button({
            icon_name: iconName,
            tooltip_text: tooltipText,
            valign: Gtk.Align.CENTER,
        });
        button.add_css_class('flat');
        button.add_css_class('circular');
        if (options.iconFile)
            button.set_child(createBundledIcon(options.iconFile, iconName));

        button.connect('clicked', onClicked);
        return button;
    }

    _handleChatActionError(error) {
        logError(error, 'Failed to update conversation');
        this._appendSystemError(getProviderErrorMessage(error));
    }

    _editMessage(message) {
        if (this._activeChatCancellable)
            return;

        const conversation = this._conversations.activeConversation;

        if (!conversation)
            return;

        const buffer = new Gtk.TextBuffer();
        buffer.set_text(message.content, -1);

        const textView = new Gtk.TextView({
            buffer,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            monospace: false,
            vexpand: true,
        });
        const scroller = new Gtk.ScrolledWindow({
            child: textView,
            min_content_height: 160,
            max_content_height: 260,
            propagate_natural_height: true,
        });
        const dialog = new Adw.AlertDialog({
            heading: 'Edit Message',
        });
        dialog.set_extra_child(scroller);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', 'Save');
        dialog.set_default_response('save');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.choose(this, null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'save')
                return;

            if (this._activeChatCancellable)
                return;

            const [start, end] = buffer.get_bounds();
            const content = buffer.get_text(start, end, true).trim();

            if (!content)
                return;

            try {
                this._conversations.updateMessageContent(conversation.id, message.id, content);

                if (message.role === 'user') {
                    this._conversations.truncateAfterMessage(conversation.id, message.id);
                    this._renderActiveConversation();
                    this._streamAssistantResponse(conversation.id).catch((error) => this._handleChatActionError(error));
                } else {
                    this._renderActiveConversation();
                }

                this._refreshConversationList();
            } catch (error) {
                this._handleChatActionError(error);
            }
        });
    }

    _retryFromMessage(message) {
        if (this._activeChatCancellable)
            return;

        const conversation = this._conversations.activeConversation;

        if (!conversation)
            return;

        try {
            this._conversations.truncateAfterMessage(conversation.id, message.id);
            this._renderActiveConversation();
            this._streamAssistantResponse(conversation.id).catch((error) => this._handleChatActionError(error));
        } catch (error) {
            this._handleChatActionError(error);
        }
    }

    _regenerateFromMessage(message) {
        if (this._activeChatCancellable)
            return;

        const conversation = this._conversations.activeConversation;

        if (!conversation)
            return;

        try {
            this._conversations.truncateAfterMessage(conversation.id, message.id, { includeMessage: true });
            this._renderActiveConversation();
            this._streamAssistantResponse(conversation.id).catch((error) => this._handleChatActionError(error));
        } catch (error) {
            this._handleChatActionError(error);
        }
    }

    _branchFromMessage(message) {
        const conversation = this._conversations.activeConversation;

        if (!conversation)
            return;

        try {
            this._conversations.branchFromMessage(conversation.id, message.id);
            this._refreshConversationList();
            this._renderActiveConversation();
        } catch (error) {
            this._handleChatActionError(error);
        }
    }

    _clearBox(box) {
        let child = box.get_first_child();

        while (child) {
            const next = child.get_next_sibling();
            box.remove(child);
            child = next;
        }
    }

    _appendMessageBottomSpacer() {
        if (!this._messages || !this._messageBottomSpacer)
            return;

        if (this._messageBottomSpacer.get_parent() === this._messages)
            return;

        this._messages.append(this._messageBottomSpacer);
    }

    _appendMessageWidget(widget) {
        if (this._messageBottomSpacer?.get_parent?.() === this._messages)
            this._messages.remove(this._messageBottomSpacer);

        this._messages.append(widget);
        this._appendMessageBottomSpacer();
    }

    _scrollToBottom() {
        if (!this._scroller)
            return;

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const adjustment = this._scroller.get_vadjustment();
            adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size());
            return GLib.SOURCE_REMOVE;
        });
    }
});
