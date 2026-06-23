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
    isPartialAgentToolCall,
    parseAgentToolCall,
} from './chat/agentMode.js';
import { ConversationManager } from './chat/conversation.js';
import { createMessageContent } from './chat/messageView.js';
import { estimateConversationUsage } from './chat/usage.js';
import { MemoryManager } from './memory/memory.js';
import { McpManager } from './mcp/manager.js';
import { ProviderConfigStore } from './providers/config.js';
import { getProviderGIcon } from './providers/icons.js';
import { createMessage } from './providers/provider.js';
import { AppSettingsStore } from './settings/appSettings.js';
import { presentProviderSettingsDialog } from './settings/providerSettings.js';
import { ConversationFileStore } from './storage/conversationStore.js';
import { MemoryFileStore } from './storage/memoryStore.js';
import { WorkspaceFileStore } from './storage/workspaceStore.js';
import { buildSkillContext } from './skills/skills.js';
import { createToolPermissionDecision } from './tools/permissions.js';
import { formatToolResultForTranscript, ToolManager } from './tools/tools.js';
import { exportConversation } from './workspace/exports.js';
import { WorkspaceManager } from './workspace/workspace.js';

const PAPER_PLANE_ICON_FILE = 'paper-plane-symbolic.svg';
const GIT_BRANCH_ICON_FILE = 'git-branch-symbolic.svg';
const STOP_ICON_NAME = 'process-stop-symbolic';
const PROVIDER_PICKER_ID_COLUMN = 0;
const PROVIDER_PICKER_NAME_COLUMN = 1;
const PROVIDER_PICKER_ICON_COLUMN = 2;

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

function getProviderErrorMessage(error) {
    if (error?.userMessage)
        return error.userMessage;

    if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
        return 'The provider request was cancelled.';

    if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
        return 'The provider did not respond before the request timed out.';

    return 'The active provider failed while streaming.';
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
        this._mcp = new McpManager({ workspaceManager: this._workspace });
        this._pendingAttachments = [];
        this._providerConfigs = new ProviderConfigStore();
        const { provider: defaultProvider, model: defaultModel } = this._providerConfigs.getActiveSelection();

        this._conversations = new ConversationManager({
            providerId: defaultProvider.id,
            modelId: defaultModel?.id ?? '',
            store: new ConversationFileStore(),
        });

        if (this._conversations.allConversations.length === 0) {
            this._conversations.createConversation({
                title: 'Welcome to Cusco',
                messages: [
                    createMessage('assistant', 'Ask a question, compare providers, or start building a reusable AI workflow.'),
                    createMessage('system', 'Next steps: markdown rendering, memory controls, web search, and desktop integration.'),
                ],
            });
        }

        this._isRefreshingConversations = false;
        this._isUpdatingProviderControls = false;
        this._isUpdatingSkillControls = false;
        this._activeChatCancellable = null;
        this.connect('close-request', () => {
            this._stopActiveConversation();
            this._mcp.shutdown();
            return false;
        });
        this._buildUi();
        this._refreshConversationList();
        this._renderActiveConversation();
    }

    _buildUi() {
        const headerBar = new Adw.HeaderBar();
        const title = new Adw.WindowTitle({
            title: 'Cusco',
            subtitle: 'GNOME AI chat',
        });

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

        const sidebarTitle = new Gtk.Label({
            label: 'Chats',
            hexpand: true,
            xalign: 0.5,
        });
        sidebarTitle.add_css_class('heading');

        this._settingsButton = new Gtk.Button({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: 'Preferences',
        });
        this._settingsButton.connect('clicked', () => this._showSettingsDialog());

        sidebarHeader.append(this._newChatButton);
        sidebarHeader.append(sidebarTitle);
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
        const main = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            margin_bottom: 18,
            hexpand: true,
            vexpand: true,
        });

        const composerShell = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_start: 18,
            margin_end: 18,
        });

        const composerMetaRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        composerMetaRow.add_css_class('cusco-composer-meta');

        this._providerPicker = this._createProviderPicker();
        this._modelPicker = new Gtk.ComboBoxText();
        this._populateProviderPicker();
        this._providerPicker.connect('changed', () => this._handleProviderChanged());
        this._modelPicker.connect('changed', () => this._handleModelChanged());

        this._memoryToggleButton = new Gtk.ToggleButton({
            icon_name: 'user-bookmarks-symbolic',
            tooltip_text: 'Use memories for this chat',
        });
        this._memoryToggleButton.connect('toggled', () => this._handleMemoryToggleChanged());

        this._agentModeToggleButton = new Gtk.ToggleButton({
            icon_name: 'applications-engineering-symbolic',
            tooltip_text: 'Agent mode',
        });
        this._agentModeToggleButton.connect('toggled', () => this._handleAgentModeToggleChanged());

        this._skillMenuButton = this._createSkillMenuButton();

        this._usageLabel = new Gtk.Label({
            label: '0 est. tokens · 0 messages',
            xalign: 1,
            hexpand: true,
        });
        this._usageLabel.add_css_class('caption');
        this._usageLabel.add_css_class('dim-label');

        composerMetaRow.append(this._providerPicker);
        composerMetaRow.append(this._modelPicker);
        composerMetaRow.append(this._memoryToggleButton);
        composerMetaRow.append(this._agentModeToggleButton);
        composerMetaRow.append(this._skillMenuButton);
        composerMetaRow.append(this._usageLabel);

        this._messages = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 26,
            margin_end: 26,
        });

        this._scroller = new Gtk.ScrolledWindow({
            child: this._messages,
            hexpand: true,
            vexpand: true,
        });

        const composerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });

        this._attachmentLabel = new Gtk.Label({
            label: '',
            xalign: 0,
            visible: false,
        });
        this._attachmentLabel.add_css_class('caption');
        this._attachmentLabel.add_css_class('dim-label');

        this._attachButton = new Gtk.Button({
            icon_name: 'mail-attachment-symbolic',
            tooltip_text: 'Attach file or image',
        });
        this._attachButton.connect('clicked', () => this._attachFileContext());

        this._promptMenuButton = this._createPromptMenuButton();

        this._composer = new Gtk.Entry({
            placeholder_text: 'Message Cusco',
            hexpand: true,
        });

        this._sendButton = new Gtk.Button({
            tooltip_text: 'Send',
        });
        this._sendButton.set_child(createBundledIcon(PAPER_PLANE_ICON_FILE, 'document-send-symbolic'));

        const sendMessage = () => {
            if (this._activeChatCancellable) {
                this._stopActiveConversation();
                return;
            }

            const text = this._composer.get_text().trim();

            if (!text)
                return;

            this._composer.set_text('');
            this._sendMessage(text).catch((error) => {
                logError(error, 'Failed to stream provider response');
                this._appendSystemError(getProviderErrorMessage(error));
            });
        };

        this._composer.connect('activate', () => {
            if (this._appSettings.sendWithEnter)
                sendMessage();
        });
        this._sendButton.connect('clicked', sendMessage);

        composerRow.append(this._attachButton);
        composerRow.append(this._promptMenuButton);
        composerRow.append(this._composer);
        composerRow.append(this._sendButton);

        composerShell.append(composerMetaRow);
        composerShell.append(this._attachmentLabel);
        composerShell.append(composerRow);

        main.append(this._scroller);
        main.append(composerShell);

        return main;
    }

    _createNewConversation() {
        const activeConversation = this._conversations.activeConversation;
        const providerId = activeConversation?.providerId;
        const modelId = activeConversation?.modelId;
        const memoryEnabled = activeConversation?.memoryEnabled !== false;
        const agentModeEnabled = Boolean(activeConversation?.agentModeEnabled);
        const skillIds = activeConversation?.skillIds ?? [];

        this._conversations.createConversation({ providerId, modelId, memoryEnabled, agentModeEnabled, skillIds });
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
        this._composer?.set_text(text);
        this.focusComposer();
    }

    selectConversation(conversationId) {
        if (!this._conversations.getConversation(conversationId))
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

    _showSettingsDialog() {
        presentProviderSettingsDialog(
            this,
            this._providerConfigs,
            this._appSettings,
            this._memories,
            this._workspace,
            this._mcp,
            () => this._handleProviderSettingsChanged(),
        );
    }

    _handleProviderSettingsChanged() {
        this._mcp.reloadConfig();
        const conversation = this._conversations.activeConversation;

        if (conversation && !this._providerConfigs.isProviderAvailable(conversation.providerId)) {
            const defaultProvider = this._providerConfigs.getDefaultProvider();
            const defaultModel = this._providerConfigs.getDefaultModel(defaultProvider.id);
            this._conversations.updateProviderConfig(conversation.id, {
                providerId: defaultProvider.id,
                modelId: defaultModel?.id ?? '',
            });
            this._providerConfigs.setActiveSelection(defaultProvider.id, defaultModel?.id ?? '');
        }

        this._populateProviderPicker();
        this._syncProviderControls(this._conversations.activeConversation);
        this._refreshPromptMenu();
        this._refreshSkillMenu(this._conversations.activeConversation);
        this._applyAccessibilityPreferences();
        this._refreshConversationList();
    }

    async _sendMessage(text) {
        const cancellable = this._beginActiveTurn();

        if (!cancellable)
            return;

        const conversation = this._conversations.activeConversation ?? this._conversations.createConversation();
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

    _updateAttachmentLabel() {
        if (this._pendingAttachments.length === 0) {
            this._attachmentLabel.set_visible(false);
            this._attachmentLabel.set_label('');
            return;
        }

        this._attachmentLabel.set_label(`Attached: ${this._pendingAttachments.map((attachment) => attachment.name).join(', ')}`);
        this._attachmentLabel.set_visible(true);
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
                    (text) => {
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

    async _collectProviderResponse(providerId, modelId, providerMessages, cancellable, onChunk = null) {
        const activeProvider = this._providerConfigs.createProvider(providerId);
        const providerConfig = this._providerConfigs.resolve(providerId, modelId);
        let responseText = '';

        for await (const chunk of activeProvider.streamChat(providerMessages, {
            ...providerConfig,
            cancellable,
            timeoutSeconds: this._appSettings.responseTimeoutSeconds,
        })) {
            responseText += chunk;
            onChunk?.(responseText, chunk);
        }

        return responseText;
    }

    async _collectProviderResponseWithFallback(conversation, providerMessages, cancellable, onChunk = null) {
        try {
            return await this._collectProviderResponse(
                conversation.providerId,
                conversation.modelId,
                providerMessages,
                cancellable,
                onChunk,
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
            const responseText = await this._collectProviderResponseWithFallback(
                conversation,
                runtimeMessages,
                cancellable,
                (text) => this._updateAgentModeAssistantView(conversation, assistantView, text),
            );

            if (isCancellableCancelled(cancellable))
                return responseText;

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

        this._sendButton?.set_sensitive(false);
        this._sendButton?.set_tooltip_text('Stopping current response');
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

        return {
            set_label: (text) => updatePersistentText(text, text),
            set_stream_text: updatePersistentText,
            set_status: (text) => ensureView().set_label(text),
            hasContent: () => currentText.length > 0,
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
        const skills = this._workspace.getSkillsForConversation(conversation);

        if (skills.length === 0)
            return [];

        const auditMessage = createMessage(
            'system',
            `Skills used for this response:\n${skills.map((skill) => `- ${skill.name}`).join('\n')}`,
        );
        this._conversations.appendMessage(conversation.id, auditMessage);
        this._addMessage(auditMessage.content, auditMessage.role, auditMessage);
        this._updateUsageDisplay(conversation);
        return skills;
    }

    _buildProviderMessages(conversation, skills, options = {}) {
        const systemMessages = [];
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

        providerStore.set_column_types([
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            Gio.Icon.$gtype,
        ]);

        for (const provider of this._providerConfigs.listProviders({ enabledOnly: true })) {
            const iter = providerStore.append();
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
    }

    _populateModelPicker(providerId, selectedModelId = null) {
        const provider = this._providerConfigs.getProvider(providerId);
        this._modelPicker.remove_all();

        for (const model of provider?.models ?? [])
            this._modelPicker.append(model.id, model.name);

        const fallbackModel = this._providerConfigs.getDefaultModel(providerId);
        this._modelPicker.set_active_id(selectedModelId ?? fallbackModel?.id ?? null);
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

    _createSkillMenuButton() {
        const menuButton = new Gtk.MenuButton({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: 'Skills',
        });
        const popover = new Gtk.Popover();

        menuButton.set_popover(popover);
        this._skillMenuPopover = popover;
        this._refreshSkillMenu();
        return menuButton;
    }

    _createPromptMenuButton() {
        const menuButton = new Gtk.MenuButton({
            icon_name: 'insert-text-symbolic',
            tooltip_text: 'Insert prompt',
        });
        const popover = new Gtk.Popover();

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
            const button = new Gtk.Button({
                halign: Gtk.Align.FILL,
                tooltip_text: prompt.content,
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

        const existingText = this._composer.get_text();
        const cursorPosition = Math.max(this._composer.get_position(), 0);
        const before = existingText.slice(0, cursorPosition);
        const after = existingText.slice(cursorPosition);
        const beforeSeparator = before && !/\s$/.test(before) ? ' ' : '';
        const afterSeparator = after && !/^\s/.test(after) ? ' ' : '';
        const nextText = `${before}${beforeSeparator}${content}${afterSeparator}${after}`;

        this._composer.set_text(nextText);
        this._composer.set_position(before.length + beforeSeparator.length + content.length);
        this.focusComposer();
    }

    _refreshSkillMenu(conversation = this._conversations?.activeConversation) {
        if (!this._skillMenuPopover || !this._skillMenuButton)
            return;

        this._isUpdatingSkillControls = true;

        const selectedSkillIds = new Set(conversation?.skillIds ?? []);
        const enabledSkills = this._workspace.enabledSkills;
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
        });

        if (enabledSkills.length === 0) {
            const emptyLabel = new Gtk.Label({
                label: 'No enabled skills',
                xalign: 0,
            });
            emptyLabel.add_css_class('dim-label');
            box.append(emptyLabel);
        }

        for (const skill of enabledSkills) {
            const row = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                margin_top: 3,
                margin_bottom: 3,
                margin_start: 3,
                margin_end: 3,
            });
            const check = new Gtk.CheckButton({
                active: selectedSkillIds.has(skill.id),
                tooltip_text: skill.description || skill.path,
            });
            const labels = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 2,
                hexpand: true,
            });
            const nameLabel = new Gtk.Label({
                label: skill.name,
                xalign: 0,
                hexpand: true,
            });
            const descriptionLabel = new Gtk.Label({
                label: skill.description || skill.path,
                xalign: 0,
                hexpand: true,
                wrap: true,
            });
            descriptionLabel.add_css_class('caption');
            descriptionLabel.add_css_class('dim-label');

            check.connect('toggled', () => {
                if (this._isUpdatingSkillControls)
                    return;

                this._setConversationSkillSelected(skill.id, check.get_active());
            });

            labels.append(nameLabel);
            labels.append(descriptionLabel);
            row.append(check);
            row.append(labels);
            box.append(row);
        }

        const selectedCount = enabledSkills.filter((skill) => selectedSkillIds.has(skill.id)).length;
        this._skillMenuButton.set_tooltip_text(selectedCount > 0
            ? `${selectedCount} skill${selectedCount === 1 ? '' : 's'} selected`
            : 'Skills');
        this._skillMenuPopover.set_child(box);
        this._isUpdatingSkillControls = false;
    }

    _syncProviderControls(conversation) {
        if (!conversation)
            return;

        this._isUpdatingProviderControls = true;
        this._providerPicker.set_active_id(conversation.providerId);
        this._populateModelPicker(conversation.providerId, conversation.modelId);
        this._memoryToggleButton.set_active(conversation.memoryEnabled !== false);
        this._agentModeToggleButton.set_active(Boolean(conversation.agentModeEnabled));
        this._refreshSkillMenu(conversation);
        this._isUpdatingProviderControls = false;
    }

    _setConversationSkillSelected(skillId, selected) {
        const conversation = this._conversations.activeConversation;

        if (!conversation)
            return;

        const skillIds = new Set(conversation.skillIds ?? []);

        if (selected)
            skillIds.add(skillId);
        else
            skillIds.delete(skillId);

        this._conversations.setSkillIds(conversation.id, [...skillIds]);
        this._refreshSkillMenu(conversation);
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
        this._providerConfigs.setActiveSelection(conversation.providerId, modelId);
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

    _createConversationRow(conversation, hoverTarget = null) {
        const providerConfig = this._providerConfigs.resolve(conversation.providerId, conversation.modelId);
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
            ellipsize: Pango.EllipsizeMode.END,
        });

        const organizationLabel = [
            conversation.folderId ? `Folder ${conversation.folderId}` : '',
            ...(conversation.tags ?? []).map((tag) => `#${tag}`),
        ].filter(Boolean).join(' ');
        const subtitle = new Gtk.Label({
            label: [
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

        box.append(title);
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
        addMenuItem('document-save-symbolic', 'Export chat', () => {
            this._exportConversation(conversation.id);
        });
        addMenuItem('user-trash-symbolic', 'Delete chat', () => {
            this._confirmDeleteConversation(conversation.id);
        }, { destructive: true });

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

    _renderActiveConversation() {
        const conversation = this._conversations.activeConversation;
        this._clearBox(this._messages);
        this._syncProviderControls(conversation);

        for (const message of conversation?.messages ?? [])
            this._addMessage(message.content, message.role, message);

        this._updateUsageDisplay(conversation);
        this._scrollToBottom();
    }

    _updateUsageDisplay(conversation = this._conversations.activeConversation, pendingAssistantText = '') {
        if (!this._usageLabel)
            return;

        const messages = [...(conversation?.messages ?? [])];

        if (pendingAssistantText)
            messages.push({ content: pendingAssistantText });

        const usage = estimateConversationUsage(messages);
        this._usageLabel.set_label(`${usage.tokens} est. tokens · ${usage.messages} messages`);
    }

    _setComposerBusy(isBusy) {
        this._composer.set_sensitive(!isBusy);
        this._attachButton.set_sensitive(!isBusy);
        this._sendButton.set_sensitive(true);
        this._sendButton.set_tooltip_text(isBusy ? 'Stop response' : 'Send');

        if (isBusy) {
            const stopIcon = new Gtk.Image({ icon_name: STOP_ICON_NAME });
            stopIcon.set_pixel_size(16);
            this._sendButton.set_child(stopIcon);
            this._sendButton.add_css_class('destructive-action');
        } else {
            this._sendButton.set_child(createBundledIcon(PAPER_PLANE_ICON_FILE, 'document-send-symbolic'));
            this._sendButton.remove_css_class('destructive-action');
        }

        this._newChatButton.set_sensitive(!isBusy);
        this._chatSearch.set_sensitive(!isBusy);
        this._promptMenuButton.set_sensitive(!isBusy);
        this._conversationList.set_sensitive(!isBusy);
        this._providerPicker.set_sensitive(!isBusy);
        this._modelPicker.set_sensitive(!isBusy);
        this._memoryToggleButton.set_sensitive(!isBusy);
        this._agentModeToggleButton.set_sensitive(!isBusy);
        this._skillMenuButton.set_sensitive(!isBusy);
        this._settingsButton.set_sensitive(!isBusy);
    }

    _addMessage(body, kind, message = null) {
        if (message?.toolCall)
            return this._addToolMessage(message);

        const wrapper = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 4,
            margin_bottom: 4,
            halign: kind === 'user' ? Gtk.Align.END : Gtk.Align.START,
        });

        const bodyContent = createMessageContent(body, {
            role: kind,
        });
        bodyContent.add_css_class('cusco-message-bubble');
        bodyContent.add_css_class(kind === 'user' ? 'cusco-message-user' : 'cusco-message-assistant');

        wrapper.append(bodyContent);

        if (message?.id && kind !== 'system')
            wrapper.append(this._createMessageActions(message));

        this._messages.append(wrapper);
        this._scrollToBottom();

        return {
            set_label: (text) => bodyContent.updateContent(text),
        };
    }

    _addToolMessage(message) {
        const wrapper = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 4,
            margin_bottom: 4,
            hexpand: true,
            halign: Gtk.Align.START,
        });
        const statusLabel = message.toolCall.status === 'failed'
            ? 'failed'
            : message.toolCall.status === 'cancelled'
                ? 'cancelled'
                : 'result';
        const expander = new Gtk.Expander({
            label: `${message.toolCall.label} ${statusLabel}`,
            expanded: true,
            hexpand: true,
        });
        expander.set_size_request(460, -1);
        expander.add_css_class('cusco-tool-result');

        const bodyContent = createMessageContent(message.content, {
            role: 'system',
            hexpand: true,
            codeMinWidth: 380,
        });
        bodyContent.add_css_class('cusco-message-bubble');
        bodyContent.add_css_class('cusco-message-assistant');
        expander.set_child(bodyContent);
        wrapper.append(expander);
        this._messages.append(wrapper);
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
