import Cairo from 'cairo';
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
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
import { extractArtifactsFromMarkdown } from './chat/artifacts.js';
import {
    AUTO_COMPACTION_MAX_SUMMARY_OUTPUT_TOKENS,
    buildCompactedMessageList,
    buildCompactionPrompt,
    getContextUsageState,
    prepareContextCompaction,
} from './chat/compaction.js';
import { ConversationManager } from './chat/conversation.js';
import { copyTextToClipboard, createArtifactCard, createMessageContent } from './chat/messageView.js';
import { estimateConversationUsage } from './chat/usage.js';
import {
    filterComposerSuggestions,
    findComposerTrigger,
    HomeFileIndex,
    listPathExecutables,
} from './composer/references.js';
import { createCronCreateTool, CronJobManager } from './cron/manager.js';
import { MemoryManager } from './memory/memory.js';
import { McpManager } from './mcp/manager.js';
import { ProviderConfigStore } from './providers/config.js';
import { createImageGenerationTool } from './providers/imageGeneration.js';
import { getProviderGIcon } from './providers/icons.js';
import { createMessage } from './providers/provider.js';
import {
    getThinkingLevelLabel,
    normalizeThinkingLevel,
} from './providers/thinking.js';
import { normalizeTokenUsage } from './providers/usage.js';
import { createBundledIcon, getBundledImagePath } from './bundledIcons.js';
import { AppSettingsStore } from './settings/appSettings.js';
import { presentProviderSettingsDialog } from './settings/providerSettings.js';
import { ConversationFileStore } from './storage/conversationStore.js';
import { MemoryFileStore } from './storage/memoryStore.js';
import { WorkspaceFileStore } from './storage/workspaceStore.js';
import { buildSkillContext } from './skills/skills.js';
import { createToolPermissionDecision } from './tools/permissions.js';
import {
    appendToolOutputPreview,
    createToolCallFromFailure,
    createToolCallFromRequest,
    createToolCallFromResult,
    latestOutputLines,
    normalizeToolCallDisplay,
} from './tools/display.js';
import { formatToolResultForTranscript, ToolManager } from './tools/tools.js';
import { exportConversation } from './workspace/exports.js';
import { extractPromptVariables, formatPromptVariables, renderPromptTemplate } from './workspace/promptVariables.js';
import { WorkspaceManager } from './workspace/workspace.js';

const GIT_BRANCH_ICON_FILE = 'git-branch-symbolic.svg';
const ATTACHMENT_ICON_FILE = 'attachment-symbolic.svg';
const PROMPT_ICON_FILE = 'prompt-symbolic.svg';
const MORE_VERTICAL_ICON_FILE = 'more-vertical-symbolic.svg';
const EMPTY_STATE_IMAGE_DARK = 'machupicchu_dark.png';
const EMPTY_STATE_IMAGE_LIGHT = 'machupicchu_light.png';
const EMPTY_STATE_FRAME_WIDTH_RATIO = 1 / 3;
const EMPTY_STATE_FRAME_ASPECT_RATIO = 176 / 236;
const EMPTY_STATE_VERTICAL_RATIO = 0.618;
const EMPTY_STATE_FADE_DURATION_MS = 220;
const PROVIDER_PICKER_ID_COLUMN = 0;
const PROVIDER_PICKER_NAME_COLUMN = 1;
const PROVIDER_PICKER_ICON_COLUMN = 2;
const KNOT_ICON_VIEWBOX_WIDTH = 903;
const KNOT_ICON_VIEWBOX_HEIGHT = 414;
const KNOT_ICON_STROKE_WIDTH = 35;
const KNOT_ICON_SAMPLE_STEPS = 28;
const KNOT_ICON_ANIMATION_SECONDS = 1;
const LONG_RESPONSE_NOTIFICATION_DELAY_MS = 10000;
const SCROLL_TO_BOTTOM_ANIMATION_MS = 180;
const SCROLL_TO_BOTTOM_ANIMATION_INTERVAL_MS = 16;
// SVG is XML text; most model image endpoints do not accept it as a vision input.
const IMAGE_ATTACHMENT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const MAX_ATTACHMENT_TEXT_CHARS = 20000;
const COMPOSER_ATTACHMENT_THUMBNAIL_WIDTH = 36;
const COMPOSER_ATTACHMENT_THUMBNAIL_HEIGHT = 28;
const COMPOSER_SUGGESTION_LIMIT = 8;
const PENDING_MESSAGE_COMPOSER_OVERLAP = 14;
const PENDING_MESSAGE_STACK_SPAN = 5;
const PENDING_MESSAGE_STACK_STEP = 4;
const KNOT_ICON_CURVES = [
    [15, 219.379, 56.5, 207.379, 186.6, 201.8, 431, 259],
    [431, 259, 736.5, 330.5, 706.5, 70.3797, 706.5, 70.3797],
    [706.5, 70.3797, 659.7, -11.2203, 510, 15.0463, 441, 38.3797],
    [441, 38.3797, 441, 38.3797, 376.641, 62.7237, 343, 89.8799],
    [343, 89.8799, 307.145, 118.823, 268.5, 181.38, 268.5, 181.38],
    [268.5, 181.38, 169.3, 339.38, 278.5, 394.667, 359.5, 398.5],
    [359.5, 398.5, 440.5, 402.333, 483, 301, 483, 301],
    [483, 301, 483, 301, 505.689, 221.851, 532.5, 181.38],
    [532.5, 181.38, 566.79, 129.62, 598.134, 103.051, 656.5, 81.8799],
    [656.5, 81.8799, 708.53, 63.0069, 742.856, 69.1365, 798, 73.8799],
    [798, 73.8799, 833.375, 76.9228, 887.5, 89.8799, 887.5, 89.8799],
];
const BASE_RESPONSE_SYSTEM_PROMPT = [
    'Complete the user\'s current request in one assistant response whenever possible.',
    'If more work remains, keep going within the available output budget instead of asking the user to say "continue".',
    'Ask a follow-up only when required information is missing or the user must choose between options.',
].join(' ');

const COMPOSER_REFERENCE_STYLES = {
    light: {
        skill: { background: '#d8ecff', foreground: '#1c71d8' },
        file: { background: '#dcf4e3', foreground: '#18794e' },
        command: { background: '#f8e5c2', foreground: '#8f5e00' },
    },
    dark: {
        skill: { background: '#1f3b55', foreground: '#99c1f1' },
        file: { background: '#1d4434', foreground: '#8ff0a4' },
        command: { background: '#4c3b1e', foreground: '#f8e45c' },
    },
};

function composerReferenceKindForTrigger(trigger) {
    return {
        '$': 'skill',
        '@': 'file',
        '#': 'command',
    }[trigger] ?? '';
}

function textBufferOffsetForStringIndex(text, index) {
    return [...String(text ?? '').slice(0, index)].length;
}

function composerReferenceRanges(text, references) {
    const ranges = [];

    for (const reference of references) {
        const token = String(reference?.insertText ?? '');

        if (!token)
            continue;

        let index = text.indexOf(token);

        while (index >= 0) {
            ranges.push({
                reference,
                startOffset: textBufferOffsetForStringIndex(text, index),
                endOffset: textBufferOffsetForStringIndex(text, index + token.length),
            });
            index = text.indexOf(token, index + token.length);
        }
    }

    return ranges;
}

function normalizeComposerReferences(references) {
    return Array.isArray(references)
        ? references.map((reference) => ({
            kind: String(reference?.kind ?? ''),
            value: String(reference?.value ?? ''),
            title: String(reference?.title ?? ''),
            insertText: String(reference?.insertText ?? ''),
        })).filter((reference) => reference.kind && reference.value && reference.insertText)
        : [];
}

function trimFixedNumber(value, fractionDigits) {
    return value.toFixed(fractionDigits).replace(/\.?0+$/, '');
}

function normalizeContextWindowTokens(value) {
    const tokens = Number(value);

    return Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
}

function formatCompactTokenCount(tokens) {
    const normalized = normalizeContextWindowTokens(tokens);

    if (normalized >= 1000000)
        return `${trimFixedNumber(normalized / 1000000, 2)}m`;

    if (normalized >= 1000)
        return `${trimFixedNumber(normalized / 1000, 1)}k`;

    return String(normalized);
}

function formatTokenCount(tokens) {
    return `${formatCompactTokenCount(tokens)} tokens`;
}

function formatContextUsagePercent(tokens, contextWindowTokens) {
    const normalizedContextWindowTokens = normalizeContextWindowTokens(contextWindowTokens);

    if (!normalizedContextWindowTokens)
        return '';

    const percentage = (Math.max(0, Number(tokens) || 0) / normalizedContextWindowTokens) * 100;

    if (percentage === 0)
        return '0%';

    if (percentage < 0.1)
        return '<0.1%';

    if (percentage < 10)
        return `${trimFixedNumber(percentage, 1)}%`;

    return `${Math.round(percentage)}%`;
}

function drawContextUsageChart(cr, width, height, fraction, color) {
    const size = Math.min(width, height);
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.max(1, (size / 2) - 2);
    const lineWidth = Math.max(2, size / 6);
    const clampedFraction = Math.min(1, Math.max(0, Number(fraction) || 0));

    cr.save();
    cr.setLineWidth(lineWidth);
    cr.setLineCap(Cairo.LineCap.ROUND);

    cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha * 0.18);
    cr.arc(centerX, centerY, radius, 0, Math.PI * 2);
    cr.stroke();

    if (clampedFraction > 0) {
        cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha);
        cr.arc(
            centerX,
            centerY,
            radius,
            -Math.PI / 2,
            (-Math.PI / 2) + (Math.PI * 2 * clampedFraction),
        );
        cr.stroke();
    }

    cr.restore();
}

let knotIconPath = null;

function cubicPoint(curve, t) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = curve;
    const inverse = 1 - t;
    const inverse2 = inverse * inverse;
    const t2 = t * t;

    return {
        x: inverse2 * inverse * x0 + 3 * inverse2 * t * x1 + 3 * inverse * t2 * x2 + t2 * t * x3,
        y: inverse2 * inverse * y0 + 3 * inverse2 * t * y1 + 3 * inverse * t2 * y2 + t2 * t * y3,
    };
}

function getKnotIconPath() {
    if (knotIconPath)
        return knotIconPath;

    const points = [];

    for (const curve of KNOT_ICON_CURVES) {
        if (points.length === 0)
            points.push({ x: curve[0], y: curve[1] });

        for (let step = 1; step <= KNOT_ICON_SAMPLE_STEPS; step++)
            points.push(cubicPoint(curve, step / KNOT_ICON_SAMPLE_STEPS));
    }

    let totalLength = 0;

    for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1];
        const current = points[index];

        totalLength += Math.hypot(current.x - previous.x, current.y - previous.y);
    }

    knotIconPath = { points, totalLength };
    return knotIconPath;
}

function mirrorProgress(value) {
    const phase = value % 2;
    return phase <= 1 ? phase : 2 - phase;
}

function drawKnotIconPath(cr, progress) {
    const { points, totalLength } = getKnotIconPath();
    const targetLength = Math.max(0, Math.min(1, progress)) * totalLength;

    if (points.length === 0 || targetLength <= 0)
        return;

    cr.moveTo(points[0].x, points[0].y);

    let walkedLength = 0;

    for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1];
        const current = points[index];
        const segmentLength = Math.hypot(current.x - previous.x, current.y - previous.y);

        if (walkedLength + segmentLength <= targetLength) {
            cr.lineTo(current.x, current.y);
            walkedLength += segmentLength;
            continue;
        }

        const remaining = targetLength - walkedLength;
        const ratio = segmentLength === 0 ? 0 : remaining / segmentLength;

        cr.lineTo(
            previous.x + (current.x - previous.x) * ratio,
            previous.y + (current.y - previous.y) * ratio,
        );
        break;
    }

    cr.stroke();
}

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isCancellableCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

function wasOperationCancelled(error, cancellable = null) {
    return isCancellableCancelled(cancellable) || isGioError(error, Gio.IOErrorEnum.CANCELLED);
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

    if (chunk.type === 'server_tool_results')
        return {
            type: 'server_tool_results',
            text: '',
            serverToolResults: Array.isArray(chunk.serverToolResults) ? chunk.serverToolResults : [],
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

function isAgentReasoningMessage(message) {
    return Boolean(message?.reasoning?.agentMode && getMessageReasoningContent(message));
}

function isImageAttachmentName(name) {
    const lowerName = String(name ?? '').toLowerCase();
    return IMAGE_ATTACHMENT_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

function isImageAttachment(attachment) {
    return attachment?.kind === 'image' || isImageAttachmentName(attachment?.name);
}

function imageAttachmentSummaryLine(attachment) {
    return `Image attachment: ${attachment.name}`;
}

function attachmentPathExists(attachment) {
    const path = String(attachment?.path ?? '').trim();
    return Boolean(path) && GLib.file_test(path, GLib.FileTest.EXISTS);
}

function createScaledImagePaintable(path, width, height) {
    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, width, height, true);
        return Gdk.Texture.new_for_pixbuf(pixbuf);
    } catch (error) {
        logError(error, `Failed to load image preview: ${path}`);
        return null;
    }
}

function displayBodyWithoutImageAttachmentLines(body, message) {
    const text = String(body ?? '');
    const imageSummaryLines = new Set((message?.attachments ?? [])
        .filter(isImageAttachment)
        .map(imageAttachmentSummaryLine));

    if (imageSummaryLines.size === 0)
        return text;

    return text
        .split('\n')
        .filter((line) => !imageSummaryLines.has(line.trim()))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
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
        this._providerConfigs = new ProviderConfigStore();
        this._tools = new ToolManager({
            searchConfig: () => this._providerConfigs.createWebSearchFallbackConfig(),
        });
        this._cron = new CronJobManager();
        this._mcp = new McpManager({ workspaceManager: this._workspace });
        this._pendingAttachments = [];
        this._composerReferences = [];
        this._composerSuggestionItems = [];
        this._activeComposerTrigger = null;
        this._dismissedComposerTrigger = '';
        this._pathCommandSuggestions = null;
        this._homeFileIndex = new HomeFileIndex({
            onChanged: () => {
                if (this._activeComposerTrigger?.trigger === '@')
                    this._refreshComposerSuggestions();
            },
        });
        this._cronJobIndex = new Map();
        this._cronLogSyncTimeoutId = 0;
        this._followLatestMessage = false;
        this._scrollToBottomSourceId = 0;
        this._scrollToBottomPasses = 0;
        this._scrollToBottomAnimationSourceId = 0;
        const { provider: defaultProvider, model: defaultModel } = this._providerConfigs.getActiveSelection();

        this._conversations = new ConversationManager({
            providerId: defaultProvider?.id ?? '',
            modelId: defaultModel?.id ?? '',
            thinkingLevel: this._appSettings.thinkingLevel,
            store: new ConversationFileStore(),
        });
        this._tools.registerTool(createImageGenerationTool(this._providerConfigs));
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
        this._activeTurnConversationId = null;
        this._pendingUserMessagesByConversation = new Map();
        this._lastAssistantMessageView = null;
        this.connect('close-request', () => {
            this._stopActiveConversation();
            this._stopCronLogSync();
            this._homeFileIndex.stop();

            if (this._composerStyleManagerSignalId) {
                Adw.StyleManager.get_default().disconnect(this._composerStyleManagerSignalId);
                this._composerStyleManagerSignalId = 0;
            }

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
            subtitle: '0 messages',
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
            if (keyval === Gdk.KEY_Escape && this._isComposerSuggestionPanelVisible()) {
                this._dismissComposerSuggestions();
                return true;
            }

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
            hexpand: true,
            vexpand: true,
        });

        this._chatSearch = new Gtk.SearchEntry({
            placeholder_text: 'Search chats',
            hexpand: true,
            margin_start: 6,
            margin_end: 6,
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

        const conversationListScroller = new Gtk.ScrolledWindow({
            child: this._conversationList,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        });
        conversationListScroller.add_css_class('cusco-conversation-list-scroller');

        sidebarContent.append(conversationListScroller);
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
            hexpand: true,
        });
        composerMetaRow.add_css_class('cusco-composer-meta');
        const composerMetaSpacer = new Gtk.Box({
            hexpand: true,
        });

        this._providerPicker = this._createProviderPicker();
        this._providerConfigButton = this._createProviderConfigButton();
        this._modelPicker = new Gtk.ComboBoxText();
        this._thinkingLevelPicker = new Gtk.ComboBoxText({
            tooltip_text: 'Thinking level',
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        this._populateProviderPicker();
        this._providerPicker.connect('changed', () => this._handleProviderChanged());
        this._modelPicker.connect('changed', () => this._handleModelChanged());
        this._thinkingLevelPicker.connect('changed', () => this._handleThinkingLevelChanged());
        this._chatOptionsMenuButton = this._createChatOptionsMenuButton();
        this._scrollToBottomButton = new Gtk.Button({
            icon_name: 'go-down-symbolic',
            tooltip_text: 'Scroll to latest message',
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        this._scrollToBottomButton.add_css_class('flat');
        this._scrollToBottomButton.add_css_class('circular');
        this._scrollToBottomButton.add_css_class('cusco-scroll-to-bottom-button');
        this._scrollToBottomButton.connect('clicked', () => this._scrollToBottom({ animate: true }));

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
        this._scroller.get_vadjustment().connect('changed', () => {
            if (this._followLatestMessage)
                this._scrollToBottom({ passes: 2 });

            this._syncScrollToBottomButton();
        });
        this._scroller.get_vadjustment().connect('value-changed', () => this._syncScrollToBottomButton());

        this._emptyConversationState = this._createEmptyConversationState();
        main.connect('get-child-position', (overlay, child, allocation) => {
            if (child !== this._emptyConversationState)
                return false;

            const overlayWidth = overlay.get_width();
            const overlayHeight = overlay.get_height();
            const frameWidth = Math.max(1, Math.round(overlayWidth * EMPTY_STATE_FRAME_WIDTH_RATIO));
            const frameHeight = Math.max(1, Math.round(frameWidth * EMPTY_STATE_FRAME_ASPECT_RATIO));

            allocation.width = frameWidth;
            allocation.height = frameHeight;
            allocation.x = Math.max(0, Math.round((overlayWidth - frameWidth) / 2));
            allocation.y = Math.max(
                0,
                Math.round((overlayHeight * (1 - EMPTY_STATE_VERTICAL_RATIO)) - (frameHeight / 2)),
            );
            return true;
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
        this._attachmentPreviewList = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
        });
        this._attachmentPreviewScroller = new Gtk.ScrolledWindow({
            child: this._attachmentPreviewList,
            hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: 42,
            max_content_height: 50,
            propagate_natural_height: true,
        });
        this._attachmentPreviewScroller.add_css_class('cusco-attachment-preview-scroller');
        this._removeAttachmentButton = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            tooltip_text: 'Clear attachments',
            valign: Gtk.Align.CENTER,
        });
        this._removeAttachmentButton.add_css_class('flat');
        this._removeAttachmentButton.add_css_class('circular');
        this._removeAttachmentButton.connect('clicked', () => this._clearPendingAttachments());
        this._attachmentRow.append(this._attachmentPreviewScroller);
        this._attachmentRow.append(this._removeAttachmentButton);
        this._pendingUserMessagesRow = this._createPendingUserMessagesRow();

        this._attachButton = new Gtk.Button({
            tooltip_text: 'Attach file or image',
            valign: Gtk.Align.CENTER,
        });
        this._attachButton.set_child(createBundledIcon(ATTACHMENT_ICON_FILE, 'mail-attachment-symbolic'));
        this._attachButton.add_css_class('flat');
        this._attachButton.add_css_class('circular');
        this._attachButton.connect('clicked', () => this._attachFileContext());

        this._promptMenuButton = this._createPromptMenuButton();
        this._promptMenuButton.set_valign(Gtk.Align.CENTER);
        this._promptMenuButton.add_css_class('flat');
        this._promptMenuButton.add_css_class('circular');

        composerMetaRow.append(this._providerPicker);
        composerMetaRow.append(this._providerConfigButton);
        composerMetaRow.append(this._modelPicker);
        composerMetaRow.append(this._thinkingLevelPicker);
        composerMetaRow.append(this._chatOptionsMenuButton);
        composerMetaRow.append(composerMetaSpacer);
        composerMetaRow.append(this._scrollToBottomButton);

        this._composerBuffer = new Gtk.TextBuffer();
        this._composerReferenceTags = new Map();

        for (const kind of ['skill', 'file', 'command']) {
            const tag = new Gtk.TextTag({
                name: `composer-reference-${kind}`,
                weight: Pango.Weight.BOLD,
            });
            this._composerBuffer.get_tag_table().add(tag);
            this._composerReferenceTags.set(kind, tag);
        }

        this._syncComposerReferenceTagStyles();
        this._composerStyleManagerSignalId = Adw.StyleManager.get_default().connect(
            'notify::dark',
            () => this._syncComposerReferenceTagStyles(),
        );
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

        const composerInlineControls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            halign: Gtk.Align.START,
            valign: Gtk.Align.END,
            margin_start: 8,
            margin_bottom: 5,
        });
        composerInlineControls.add_css_class('cusco-composer-inline-controls');

        this._composerUsageFraction = 0;
        this._composerUsageChart = new Gtk.DrawingArea({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            margin_start: 4,
        });
        this._composerUsageChart.set_size_request(18, 18);
        this._composerUsageChart.add_css_class('cusco-context-usage-chart');
        this._composerUsageChart.set_draw_func((widget, cr, drawWidth, drawHeight) => {
            drawContextUsageChart(cr, drawWidth, drawHeight, this._composerUsageFraction, widget.get_color());
        });
        this._composerUsagePopover = this._createComposerUsagePopover();
        this._composerUsagePopover.set_parent(this._composerUsageChart);
        const usageMotionController = new Gtk.EventControllerMotion();
        usageMotionController.connect('enter', () => this._composerUsagePopover?.popup());
        usageMotionController.connect('leave', () => this._composerUsagePopover?.popdown());
        this._composerUsageChart.add_controller(usageMotionController);
        composerInlineControls.append(this._attachButton);
        composerInlineControls.append(this._promptMenuButton);
        composerInlineControls.append(this._composerUsageChart);
        composerOverlay.add_overlay(composerInlineControls);

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
            const text = this._getComposerText().trim();
            const references = this._getComposerReferences();
            const hasAttachments = this._pendingAttachments.length > 0;

            if (!text && !hasAttachments)
                return;

            if (this._activeChatCancellable) {
                if (text) {
                    this._setComposerText('');
                    this._enqueuePendingUserMessage(text, references);
                } else if (hasAttachments) {
                    this._showToast('Attachments can be sent after the current response finishes.');
                }
                return;
            }

            this._setComposerText('');
            this._sendMessage(text, references).catch((error) => {
                logError(error, 'Failed to stream provider response');
                this._appendSystemError(getProviderErrorMessage(error));
            });
        };

        const composerKeyController = new Gtk.EventControllerKey();
        composerKeyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (this._handleComposerSuggestionKey(keyval))
                return true;

            if (this._deleteComposerReferenceAtCursor(keyval))
                return true;

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
        this._composerBuffer.connect('changed', () => {
            this._syncComposerPlaceholder();
            this._syncComposerUsageChart();
            this._syncComposerHint();
            this._syncComposerReferenceTags();
            this._refreshComposerSuggestions();
        });
        this._composerBuffer.connect('mark-set', (_buffer, _location, mark) => {
            if (mark.get_name() === 'insert')
                this._refreshComposerSuggestions();
        });
        this._syncComposerPlaceholder();
        this._syncComposerUsageChart();
        this._syncComposerHint();

        composerRow.append(composerOverlay);

        const composerSuggestionPanel = this._createComposerSuggestionPanel();
        const composerDeckLayout = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            hexpand: true,
        });
        const composerSpace = new Gtk.Box({ hexpand: true });
        this._composerDeckSizeGroup = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
        this._composerDeckSizeGroup.add_widget(composerRow);
        this._composerDeckSizeGroup.add_widget(composerSpace);
        composerDeckLayout.append(composerSuggestionPanel);
        composerDeckLayout.append(this._pendingUserMessagesRow);
        composerDeckLayout.append(composerSpace);

        const composerDeck = new Gtk.Overlay({
            child: composerDeckLayout,
            hexpand: true,
        });
        composerDeck.add_css_class('cusco-composer-deck');
        composerDeck.add_overlay(composerRow);
        composerDeck.set_measure_overlay(composerRow, false);
        composerDeck.connect('get-child-position', (overlay, child, allocation) => {
            if (child !== composerRow)
                return false;

            const hasPendingMessages = this._pendingUserMessagesRow.get_visible();
            const contentHeight = composerSuggestionPanel.get_height()
                + this._pendingUserMessagesRow.get_height();
            const overlap = hasPendingMessages ? PENDING_MESSAGE_COMPOSER_OVERLAP : 0;
            allocation.x = 0;
            allocation.y = Math.max(0, contentHeight - overlap);
            allocation.width = overlay.get_width();
            allocation.height = composerSpace.get_height() + overlap;
            return true;
        });

        composerShell.append(composerMetaRow);
        composerShell.append(this._attachmentRow);
        composerShell.append(composerDeck);

        main.set_child(this._scroller);
        main.add_overlay(this._emptyConversationState);
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

    _setComposerText(text, { preserveReferences = false } = {}) {
        if (!this._composerBuffer)
            return;

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

    _createComposerSuggestionPanel() {
        const panel = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_bottom: 6,
        });
        panel.add_css_class('cusco-composer-suggestions');

        this._composerSuggestionHeading = new Gtk.Label({
            xalign: 0,
            margin_start: 10,
            margin_end: 10,
            margin_top: 7,
        });
        this._composerSuggestionHeading.add_css_class('caption');
        this._composerSuggestionHeading.add_css_class('dim-label');
        panel.append(this._composerSuggestionHeading);

        this._composerSuggestionList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: true,
        });
        this._composerSuggestionList.add_css_class('boxed-list');
        this._composerSuggestionList.connect('row-activated', (_list, row) => {
            if (row?.composerSuggestion)
                this._insertComposerSuggestion(row.composerSuggestion);
        });

        this._composerSuggestionScroller = new Gtk.ScrolledWindow({
            child: this._composerSuggestionList,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            max_content_height: 310,
            propagate_natural_height: true,
        });
        panel.append(this._composerSuggestionScroller);

        this._composerSuggestionStatus = new Gtk.Label({
            xalign: 0,
            margin_start: 10,
            margin_end: 10,
            margin_top: 5,
            margin_bottom: 8,
            visible: false,
        });
        this._composerSuggestionStatus.add_css_class('dim-label');
        panel.append(this._composerSuggestionStatus);

        this._composerSuggestionRevealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_UP,
            transition_duration: 140,
            reveal_child: false,
        });
        this._composerSuggestionRevealer.set_child(panel);
        return this._composerSuggestionRevealer;
    }

    _syncComposerReferenceTagStyles() {
        if (!this._composerReferenceTags)
            return;

        const palette = Adw.StyleManager.get_default().get_dark()
            ? COMPOSER_REFERENCE_STYLES.dark
            : COMPOSER_REFERENCE_STYLES.light;

        for (const [kind, tag] of this._composerReferenceTags) {
            tag.set_property('background', palette[kind].background);
            tag.set_property('foreground', palette[kind].foreground);
        }
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
        return this._workspace.enabledSkills.map((skill) => ({
            kind: 'skill',
            value: skill.id,
            title: skill.name,
            subtitle: skill.description || skill.path,
            searchText: `${skill.name} ${skill.description ?? ''}`,
            insertText: `$${skill.name}`,
        }));
    }

    _itemsForComposerTrigger(trigger) {
        switch (trigger) {
        case '$':
            return this._skillSuggestionItems();
        case '@':
            this._homeFileIndex.start();
            return this._homeFileIndex.items;
        case '#':
            this._pathCommandSuggestions ??= listPathExecutables();
            return this._pathCommandSuggestions;
        default:
            return [];
        }
    }

    _composerTriggerKey(trigger) {
        return trigger
            ? `${trigger.trigger}:${trigger.startOffset}:${trigger.query}`
            : '';
    }

    _refreshComposerSuggestions() {
        if (this._updatingComposerReferences || !this._composerBuffer || !this._composerSuggestionRevealer)
            return;

        const text = this._getComposerText();
        const cursor = this._composerBuffer.get_iter_at_mark(this._composerBuffer.get_insert()).get_offset();
        const trigger = findComposerTrigger(text, cursor);
        const triggerKey = this._composerTriggerKey(trigger);

        if (!trigger || triggerKey === this._dismissedComposerTrigger) {
            this._activeComposerTrigger = null;
            this._hideComposerSuggestions();
            return;
        }

        this._dismissedComposerTrigger = '';
        this._activeComposerTrigger = trigger;
        const items = this._itemsForComposerTrigger(trigger.trigger);
        this._composerSuggestionItems = filterComposerSuggestions(
            items,
            trigger.query,
            COMPOSER_SUGGESTION_LIMIT,
        );
        this._renderComposerSuggestions();
    }

    _renderComposerSuggestions() {
        if (!this._composerSuggestionList || !this._activeComposerTrigger)
            return;

        this._clearBox(this._composerSuggestionList);
        const kind = composerReferenceKindForTrigger(this._activeComposerTrigger.trigger);
        const heading = {
            skill: 'Skills',
            file: 'Files in Home',
            command: 'Commands on PATH',
        }[kind];
        this._composerSuggestionHeading.set_label(
            this._activeComposerTrigger.query
                ? `${heading} matching “${this._activeComposerTrigger.query}”`
                : heading,
        );

        for (const item of this._composerSuggestionItems) {
            const row = new Gtk.ListBoxRow({
                activatable: true,
                selectable: true,
            });
            row.composerSuggestion = item;

            const content = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 10,
                margin_top: 7,
                margin_bottom: 7,
                margin_start: 9,
                margin_end: 9,
            });
            const prefix = new Gtk.Label({
                label: this._activeComposerTrigger.trigger,
                width_chars: 2,
                valign: Gtk.Align.CENTER,
            });
            prefix.add_css_class('title-4');
            prefix.add_css_class(`cusco-composer-reference-${kind}`);
            const labels = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 1,
                hexpand: true,
            });
            const title = new Gtk.Label({
                label: item.title,
                xalign: 0,
                ellipsize: Pango.EllipsizeMode.END,
            });
            const subtitle = new Gtk.Label({
                label: item.subtitle,
                xalign: 0,
                ellipsize: Pango.EllipsizeMode.MIDDLE,
            });
            subtitle.add_css_class('caption');
            subtitle.add_css_class('dim-label');
            labels.append(title);
            labels.append(subtitle);
            content.append(prefix);
            content.append(labels);
            row.set_child(content);
            this._composerSuggestionList.append(row);
        }

        const hasItems = this._composerSuggestionItems.length > 0;
        const isIndexingFiles = kind === 'file' && this._homeFileIndex.loading;
        this._composerSuggestionScroller.set_visible(hasItems);
        this._composerSuggestionStatus.set_visible(!hasItems || isIndexingFiles);
        this._composerSuggestionStatus.set_label(hasItems && isIndexingFiles
            ? 'More files are still being indexed…'
            : isIndexingFiles
                ? 'Searching your Home folder…'
                : `No matching ${kind}s`);
        this._composerSuggestionRevealer.set_reveal_child(true);

        if (hasItems)
            this._composerSuggestionList.select_row(this._composerSuggestionList.get_row_at_index(0));
    }

    _isComposerSuggestionPanelVisible() {
        return Boolean(this._composerSuggestionRevealer?.get_reveal_child());
    }

    _hideComposerSuggestions() {
        this._composerSuggestionRevealer?.set_reveal_child(false);
        this._composerSuggestionItems = [];
    }

    _dismissComposerSuggestions() {
        this._dismissedComposerTrigger = this._composerTriggerKey(this._activeComposerTrigger);
        this._activeComposerTrigger = null;
        this._hideComposerSuggestions();
        this.focusComposer();
    }

    _handleComposerSuggestionKey(keyval) {
        if (!this._isComposerSuggestionPanelVisible())
            return false;

        if (keyval === Gdk.KEY_Escape) {
            this._dismissComposerSuggestions();
            return true;
        }

        const isPrevious = keyval === Gdk.KEY_Up;
        const isNext = keyval === Gdk.KEY_Down;

        if ((isPrevious || isNext) && this._composerSuggestionItems.length > 0) {
            const selectedRow = this._composerSuggestionList.get_selected_row();
            const selectedIndex = selectedRow?.get_index() ?? 0;
            const delta = isPrevious ? -1 : 1;
            const nextIndex = (selectedIndex + delta + this._composerSuggestionItems.length)
                % this._composerSuggestionItems.length;
            this._composerSuggestionList.select_row(
                this._composerSuggestionList.get_row_at_index(nextIndex),
            );
            return true;
        }

        const isSelect = keyval === Gdk.KEY_Tab
            || keyval === Gdk.KEY_ISO_Left_Tab
            || keyval === Gdk.KEY_Return
            || keyval === Gdk.KEY_KP_Enter;

        if (isSelect) {
            const suggestion = this._composerSuggestionList.get_selected_row()?.composerSuggestion;

            if (!suggestion)
                return false;

            this._insertComposerSuggestion(suggestion);
            return true;
        }

        return false;
    }

    _insertComposerSuggestion(suggestion) {
        const trigger = this._activeComposerTrigger;

        if (!trigger || !suggestion?.insertText)
            return;

        const textCharacters = [...this._getComposerText()];
        const hasWhitespaceAfter = trigger.endOffset < textCharacters.length
            && /\s/u.test(textCharacters[trigger.endOffset]);
        const replacement = `${suggestion.insertText}${hasWhitespaceAfter ? '' : ' '}`;
        const replacementLength = [...replacement].length;
        this._updatingComposerReferences = true;
        this._composerBuffer.begin_user_action();
        this._composerBuffer.delete(
            this._composerBuffer.get_iter_at_offset(trigger.startOffset),
            this._composerBuffer.get_iter_at_offset(trigger.endOffset),
        );
        this._composerBuffer.insert(
            this._composerBuffer.get_iter_at_offset(trigger.startOffset),
            replacement,
            -1,
        );
        this._composerBuffer.place_cursor(
            this._composerBuffer.get_iter_at_offset(trigger.startOffset + replacementLength),
        );
        this._composerBuffer.end_user_action();

        const reference = {
            kind: suggestion.kind,
            value: suggestion.value,
            title: suggestion.title,
            insertText: suggestion.insertText,
        };
        const alreadyTracked = this._composerReferences.some((item) => (
            item.kind === reference.kind
            && item.value === reference.value
            && item.insertText === reference.insertText
        ));

        if (!alreadyTracked)
            this._composerReferences.push(reference);

        this._updatingComposerReferences = false;
        this._activeComposerTrigger = null;
        this._dismissedComposerTrigger = '';
        this._hideComposerSuggestions();
        this._syncComposerReferenceTags();
        this.focusComposer();
    }

    _deleteComposerReferenceAtCursor(keyval) {
        const isBackspace = keyval === Gdk.KEY_BackSpace;
        const isDelete = keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_KP_Delete;

        if ((!isBackspace && !isDelete) || !this._composerBuffer)
            return false;

        const [hasSelection] = this._composerBuffer.get_selection_bounds();

        if (hasSelection)
            return false;

        const text = this._getComposerText();
        const characters = [...text];
        const cursor = this._composerBuffer.get_iter_at_mark(this._composerBuffer.get_insert()).get_offset();
        const range = composerReferenceRanges(text, this._getComposerReferences()).find((candidate) => (
            isBackspace
                ? cursor > candidate.startOffset && cursor <= candidate.endOffset
                : cursor >= candidate.startOffset && cursor < candidate.endOffset
        ));

        if (!range)
            return false;

        let endOffset = range.endOffset;

        if (characters[endOffset] === ' ')
            endOffset += 1;

        this._updatingComposerReferences = true;
        this._composerBuffer.delete(
            this._composerBuffer.get_iter_at_offset(range.startOffset),
            this._composerBuffer.get_iter_at_offset(endOffset),
        );
        this._composerBuffer.place_cursor(this._composerBuffer.get_iter_at_offset(range.startOffset));
        this._updatingComposerReferences = false;
        this._syncComposerReferenceTags();
        this._refreshComposerSuggestions();
        return true;
    }

    _syncComposerPlaceholder() {
        if (!this._composerPlaceholder || !this._composerBuffer)
            return;

        this._composerPlaceholder.set_visible(this._composerBuffer.get_char_count() === 0);
    }

    _getUsageMessages(conversation, {
        pendingAssistantText = '',
        includeComposerDraft = false,
    } = {}) {
        const messages = [...(conversation?.messages ?? [])];

        if (pendingAssistantText)
            messages.push({ content: pendingAssistantText });

        if (includeComposerDraft) {
            const draft = this._getComposerText().trim();

            if (draft)
                messages.push({ content: draft });
        }

        return messages;
    }

    _getContextWindowTokens(conversation) {
        if (!conversation)
            return 0;

        const { model } = this._providerConfigs.resolve(conversation.providerId, conversation.modelId);

        return normalizeContextWindowTokens(model?.contextWindowTokens);
    }

    _createComposerUsagePopover() {
        const popover = new Gtk.Popover({
            position: Gtk.PositionType.TOP,
            autohide: false,
        });
        popover.add_css_class('cusco-context-usage-popover');
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 5,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });

        this._composerUsageTitleLabel = new Gtk.Label({
            label: 'Context window:',
            xalign: 0.5,
            halign: Gtk.Align.CENTER,
        });
        this._composerUsageTitleLabel.add_css_class('caption');
        this._composerUsageTitleLabel.add_css_class('dim-label');

        this._composerUsagePercentLabel = new Gtk.Label({
            label: '0% full',
            xalign: 0.5,
            halign: Gtk.Align.CENTER,
        });

        this._composerUsageDetailLabel = new Gtk.Label({
            label: '0 / unknown tokens used',
            xalign: 0.5,
            halign: Gtk.Align.CENTER,
        });
        this._composerUsageDetailLabel.add_css_class('caption');

        content.append(this._composerUsageTitleLabel);
        content.append(this._composerUsagePercentLabel);
        content.append(this._composerUsageDetailLabel);
        popover.set_child(content);
        return popover;
    }

    _syncComposerUsageChart() {
        if (!this._composerUsageChart)
            return;

        const conversation = this._conversations.activeConversation;
        const usage = estimateConversationUsage(this._getUsageMessages(conversation, {
            includeComposerDraft: true,
        }));
        const contextWindowTokens = this._getContextWindowTokens(conversation);
        this._composerUsageFraction = contextWindowTokens > 0
            ? usage.tokens / contextWindowTokens
            : 0;

        this._composerUsageChart.set_tooltip_text('');
        if (contextWindowTokens > 0) {
            this._composerUsagePercentLabel?.set_label(
                `${formatContextUsagePercent(usage.tokens, contextWindowTokens)} full`,
            );
            this._composerUsageDetailLabel?.set_label(
                `${formatCompactTokenCount(usage.tokens)} / ${
                    formatTokenCount(contextWindowTokens)
                } used`,
            );
        } else {
            this._composerUsagePercentLabel?.set_label('Unknown');
            this._composerUsageDetailLabel?.set_label(`${usage.tokens} est. tokens used`);
        }
        this._composerUsageChart.queue_draw();
    }

    _syncComposerHint(isBusy = false) {
        if (!this._composerHint)
            return;

        const sendShortcut = this._appSettings.sendWithEnter ? 'Enter' : 'Ctrl+Enter';
        this._composerHint.set_label(isBusy
            ? `${sendShortcut} queues · Esc to stop`
            : `${sendShortcut} ↵ to send`);
    }

    _createPendingUserMessagesRow() {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            visible: false,
        });
        row.add_css_class('cusco-pending-message-row');

        this._pendingUserMessagesList = new Gtk.Grid({
            row_homogeneous: true,
            hexpand: true,
        });
        this._pendingUserMessagesList.add_css_class('cusco-pending-message-stack');

        const scroller = new Gtk.ScrolledWindow({
            child: this._pendingUserMessagesList,
            hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            max_content_height: 112,
            propagate_natural_height: true,
        });
        scroller.add_css_class('cusco-pending-message-scroller');
        row.append(scroller);
        return row;
    }

    _pendingConversationId() {
        return this._activeTurnConversationId
            ?? this._conversations.activeConversation?.id
            ?? null;
    }

    _getPendingUserMessages(conversationId) {
        return this._pendingUserMessagesByConversation.get(conversationId) ?? [];
    }

    _enqueuePendingUserMessage(
        text,
        references = [],
        conversationId = this._pendingConversationId(),
    ) {
        const content = String(text ?? '').trim();

        if (!content || !conversationId)
            return null;

        const message = {
            id: GLib.uuid_string_random(),
            conversationId,
            content,
            references: normalizeComposerReferences(references),
            createdAt: new Date().toISOString(),
        };
        const messages = [...this._getPendingUserMessages(conversationId), message];
        this._pendingUserMessagesByConversation.set(conversationId, messages);
        this._renderPendingUserMessages();
        this._syncComposerHint(Boolean(this._activeChatCancellable));
        return message;
    }

    _removePendingUserMessage(conversationId, messageId) {
        const messages = this._getPendingUserMessages(conversationId)
            .filter((message) => message.id !== messageId);

        if (messages.length > 0)
            this._pendingUserMessagesByConversation.set(conversationId, messages);
        else
            this._pendingUserMessagesByConversation.delete(conversationId);

        this._renderPendingUserMessages();
        this.focusComposer();
    }

    _createPendingUserMessageCard(message) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });
        card.add_css_class('cusco-pending-message');
        card.set_tooltip_text(message.content);

        const status = new Gtk.Label({
            label: 'Queued',
            valign: Gtk.Align.CENTER,
        });
        status.add_css_class('caption');
        status.add_css_class('cusco-pending-message-status');

        const label = new Gtk.Label({
            label: message.content,
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            hexpand: true,
            max_width_chars: 76,
            valign: Gtk.Align.CENTER,
        });
        label.add_css_class('cusco-pending-message-text');

        const removeButton = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            tooltip_text: 'Remove queued message',
            valign: Gtk.Align.CENTER,
        });
        removeButton.add_css_class('flat');
        removeButton.add_css_class('circular');
        removeButton.connect('clicked', () => {
            this._removePendingUserMessage(message.conversationId, message.id);
        });

        card.append(status);
        card.append(label);
        card.append(removeButton);
        return card;
    }

    _renderPendingUserMessages(conversation = this._conversations.activeConversation) {
        if (!this._pendingUserMessagesRow || !this._pendingUserMessagesList)
            return;

        this._clearBox(this._pendingUserMessagesList);
        const messages = conversation?.id ? this._getPendingUserMessages(conversation.id) : [];

        messages.forEach((message, index) => {
            this._pendingUserMessagesList.attach(
                this._createPendingUserMessageCard(message),
                0,
                index * PENDING_MESSAGE_STACK_STEP,
                1,
                PENDING_MESSAGE_STACK_SPAN,
            );
        });

        this._pendingUserMessagesRow.set_visible(messages.length > 0);
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

    _showToast(title) {
        if (!this._toastOverlay)
            return;

        this._toastOverlay.add_toast(new Adw.Toast({
            title,
        }));
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
        const pendingMessages = [...this._getPendingUserMessages(conversationId)];

        if (pendingMessages.length === 0)
            return [];

        this._pendingUserMessagesByConversation.delete(conversationId);
        this._renderPendingUserMessages();

        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return [];

        const messages = [];

        for (const pendingMessage of pendingMessages) {
            const references = normalizeComposerReferences(pendingMessage.references);
            const attachments = this._createAttachmentsForComposerReferences(references);
            const userMessage = createMessage(
                'user',
                this._formatUserMessageContent(pendingMessage.content, attachments),
                {
                    attachments,
                    metadata: { composerReferences: references },
                },
            );

            this._conversations.appendMessage(conversation.id, userMessage);
            this._addMessageIfActiveConversation(conversation.id, userMessage);
            this._promptMemoryProposal(userMessage, conversation);
            messages.push(userMessage);
        }

        this._updateUsageDisplay(conversation);
        this._refreshConversationList();
        return messages;
    }

    _drainPendingUserMessagesForRuntime(conversation, runtimeMessages) {
        const messages = this._drainPendingUserMessages(conversation.id);

        for (const message of messages) {
            runtimeMessages.push({
                role: 'user',
                content: message.content,
                attachments: message.attachments ?? [],
            });
        }

        return messages;
    }

    _handleQueuedUserMessageError(error) {
        logError(error, 'Failed to send queued user message');
        this._appendSystemError(getProviderErrorMessage(error));
    }

    async _sendQueuedUserMessages(conversationId) {
        if (this._activeChatCancellable || this._getPendingUserMessages(conversationId).length === 0)
            return false;

        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation || !this._ensureConversationProviderAvailable(conversation))
            return false;

        const cancellable = this._beginActiveTurn(conversation.id);

        if (!cancellable)
            return false;

        let sentMessages = false;
        let shouldSendMore = false;

        try {
            const messages = this._drainPendingUserMessages(conversation.id);

            if (messages.length === 0)
                return false;

            sentMessages = true;

            if (isCancellableCancelled(cancellable))
                return true;

            await this._streamAssistantResponse(conversation.id, { cancellable });
            shouldSendMore = !isCancellableCancelled(cancellable);
        } finally {
            this._finishActiveTurn(cancellable);
        }

        if (shouldSendMore) {
            this._sendQueuedUserMessages(conversation.id).catch((error) => {
                this._handleQueuedUserMessageError(error);
            });
        }

        return sentMessages;
    }

    async _sendMessage(text, references = []) {
        const conversation = this._conversations.activeConversation ?? this._conversations.createConversation();

        if (!this._ensureConversationProviderAvailable(conversation))
            return;

        const cancellable = this._beginActiveTurn(conversation.id);

        if (!cancellable)
            return;

        const normalizedReferences = normalizeComposerReferences(references);
        const pendingAttachments = this._consumePendingAttachments();
        const attachments = this._createAttachmentsForComposerReferences(
            normalizedReferences,
            pendingAttachments,
        );
        const userMessage = createMessage(
            'user',
            this._formatUserMessageContent(text, attachments),
            {
                attachments,
                metadata: { composerReferences: normalizedReferences },
            },
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

            this._drainPendingUserMessages(conversation.id);
            await this._streamAssistantResponse(conversation.id, { cancellable });
        } finally {
            this._finishActiveTurn(cancellable);
        }

        if (!isCancellableCancelled(cancellable)) {
            this._sendQueuedUserMessages(conversation.id).catch((error) => {
                this._handleQueuedUserMessageError(error);
            });
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
            this._addMessageIfActiveConversation(conversationId, message);
            return 'blocked';
        }

        if (permissionDecision.requiresUserApproval && !await this._confirmToolPermission(request, cancellable)) {
            if (isCancellableCancelled(cancellable)) {
                this._appendToolCancellation(conversationId, request);
                return 'cancelled';
            }

            const message = createMessage('system', `${request.label} was not run because permission was denied.`);
            this._conversations.appendMessage(conversationId, message);
            this._addMessageIfActiveConversation(conversationId, message);
            return 'denied';
        }

        const runningTool = this._appendRunningToolMessage(conversationId, request);
        const conversation = this._conversations.getConversation(conversationId);

        try {
            const result = await this._tools.runRequest(request, {
                providerId: conversation?.providerId ?? '',
                timeoutSeconds: this._appSettings.responseTimeoutSeconds,
                cancellable,
                onOutput: (chunk) => this._appendToolOutputChunk(runningTool, chunk),
                requestSudoPassword: request.name === 'bash'
                    ? (command) => this._promptSudoPassword(command, cancellable)
                    : null,
            });
            const status = result.cancelled ? 'cancelled' : 'completed';
            this._completeRunningToolMessage(conversationId, runningTool, result, status);
            return status;
        } catch (error) {
            if (wasOperationCancelled(error, cancellable)) {
                this._completeRunningToolFailure(
                    conversationId,
                    runningTool,
                    request,
                    `${request.label} was stopped before it finished.`,
                    'cancelled',
                );
                return 'cancelled';
            }

            this._completeRunningToolFailure(
                conversationId,
                runningTool,
                request,
                error.userMessage ?? `Tool failed: ${error.message}`,
                'failed',
            );
            logError(error, 'Failed to run tool request');
            return 'failed';
        }
    }

    _appendRunningToolMessage(conversationId, request, options = {}) {
        const message = createMessage('system', '', {
            toolCall: createToolCallFromRequest(request, {
                status: 'running',
                agentMode: Boolean(options.agentMode),
            }),
        });

        this._conversations.appendMessage(conversationId, message);
        const view = this._addMessageIfActiveConversation(conversationId, message);
        this._updateUsageDisplay(this._conversations.getConversation(conversationId));
        return { message, view };
    }

    _appendToolOutputChunk(runningTool, chunk) {
        const message = runningTool?.message;
        const toolCall = message?.toolCall;

        if (!toolCall || toolCall.name !== 'bash')
            return;

        const text = typeof chunk === 'object' ? chunk.text : chunk;
        if (!text)
            return;

        toolCall.outputPreview = appendToolOutputPreview(toolCall.outputPreview, text);
        runningTool?.view?.append_tool_output?.(toolCall.outputPreview);
        this._scrollToBottom();
    }

    _updateRunningToolMessage(conversationId, runningTool, content, toolCall) {
        const message = runningTool?.message;

        if (!message)
            return null;

        message.content = content;
        message.toolCall = toolCall;
        const storedMessage = this._conversations.updateMessageToolCall(
            conversationId,
            message.id,
            toolCall,
            content,
        );

        runningTool?.view?.update_tool_message?.(message);
        this._updateUsageDisplay(this._conversations.getConversation(conversationId));
        return storedMessage;
    }

    _completeRunningToolMessage(conversationId, runningTool, result, status, options = {}) {
        const content = formatToolResultForTranscript(result);
        const toolCall = createToolCallFromResult(result, {
            status,
            agentMode: Boolean(options.agentMode),
            createdAt: runningTool?.message?.toolCall?.createdAt,
            outputPreview: runningTool?.message?.toolCall?.outputPreview,
        });

        return this._updateRunningToolMessage(conversationId, runningTool, content, toolCall);
    }

    _completeRunningToolFailure(conversationId, runningTool, request, reason, status = 'failed', options = {}) {
        const toolCall = createToolCallFromFailure(request, reason, {
            status,
            agentMode: Boolean(options.agentMode),
            createdAt: runningTool?.message?.toolCall?.createdAt,
            outputPreview: runningTool?.message?.toolCall?.outputPreview,
        });

        return this._updateRunningToolMessage(conversationId, runningTool, String(reason ?? ''), toolCall);
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
                    ? `Cusco will send this query to Brave Search:\n${request.input}`
                    : request.name === 'image_gen'
                        ? `Cusco will send this image prompt to the selected provider:\n${request.input}`
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

    _promptSudoPassword(command, cancellable = null) {
        return new Promise((resolve) => {
            if (isCancellableCancelled(cancellable)) {
                resolve(null);
                return;
            }

            const entry = new Gtk.PasswordEntry({
                placeholder_text: 'Password',
                show_peek_icon: true,
                hexpand: true,
            });
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 8,
            });
            const commandLabel = new Gtk.Label({
                label: String(command ?? ''),
                xalign: 0,
                selectable: true,
                wrap: true,
                max_width_chars: 72,
            });
            commandLabel.add_css_class('monospace');
            commandLabel.add_css_class('caption');
            box.append(commandLabel);
            box.append(entry);

            const dialog = new Adw.AlertDialog({
                heading: 'Sudo Password Required',
                body: 'Enter your sudo password to run this command. The password is not stored.',
            });
            dialog.set_extra_child(box);
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('run', 'Run');
            dialog.set_default_response('run');
            dialog.set_close_response('cancel');
            dialog.set_response_appearance('run', Adw.ResponseAppearance.SUGGESTED);
            dialog.choose(this, cancellable, (_dialog, result) => {
                try {
                    const response = dialog.choose_finish(result);
                    const password = entry.get_text();

                    resolve(response === 'run' && password ? password : null);
                } catch (error) {
                    if (!wasOperationCancelled(error, cancellable))
                        logError(error, 'Failed to resolve sudo password dialog');

                    resolve(null);
                }
            });

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                entry.grab_focus();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _activeProviderSupportsImageAttachments() {
        const providerId = this._conversations.activeConversation?.providerId
            ?? this._providerPicker?.get_active_id?.()
            ?? '';
        const provider = this._providerConfigs.getProvider(providerId);

        return provider?.supportsImageAttachments !== false;
    }

    _activeImageAttachmentUnsupportedMessage() {
        const providerId = this._conversations.activeConversation?.providerId
            ?? this._providerPicker?.get_active_id?.()
            ?? '';
        const provider = this._providerConfigs.getProvider(providerId);
        const name = provider?.name ?? 'The selected provider';

        return `${name} does not support image attachments.`;
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

                const isImage = isImageAttachmentName(GLib.path_get_basename(path));

                if (isImage && !this._activeProviderSupportsImageAttachments()) {
                    this._showToast(this._activeImageAttachmentUnsupportedMessage());
                    return;
                }

                this._pendingAttachments.push(this._createAttachmentFromPath(path));
                this._updateAttachmentLabel();
            } catch (error) {
                logError(error, 'Failed to attach file');
            }
        });
    }

    _createAttachmentFromPath(path) {
        const name = GLib.path_get_basename(path);

        if (isImageAttachmentName(name)) {
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
            content: text.slice(0, MAX_ATTACHMENT_TEXT_CHARS),
            truncated: text.length > MAX_ATTACHMENT_TEXT_CHARS,
        };
    }

    _createAttachmentsForComposerReferences(references, existingAttachments = []) {
        const attachments = existingAttachments.map((attachment) => ({ ...attachment }));
        const attachedPaths = new Set(attachments.map((attachment) => attachment.path).filter(Boolean));

        for (const reference of normalizeComposerReferences(references)) {
            if (reference.kind !== 'file' || attachedPaths.has(reference.value))
                continue;

            if (!GLib.file_test(reference.value, GLib.FileTest.EXISTS)) {
                this._showToast(`${reference.title || 'Referenced file'} no longer exists.`);
                continue;
            }

            if (isImageAttachmentName(reference.value) && !this._activeProviderSupportsImageAttachments()) {
                this._showToast(this._activeImageAttachmentUnsupportedMessage());
                continue;
            }

            try {
                attachments.push(this._createAttachmentFromPath(reference.value));
                attachedPaths.add(reference.value);
            } catch (error) {
                logError(error, `Failed to read referenced file ${reference.value}`);
                this._showToast(`Could not read ${reference.title || GLib.path_get_basename(reference.value)}.`);
            }
        }

        return attachments;
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

    _discardPendingImageAttachmentsIfUnsupportedProvider() {
        if (this._activeProviderSupportsImageAttachments())
            return;

        const nextAttachments = this._pendingAttachments.filter((attachment) => !isImageAttachment(attachment));

        if (nextAttachments.length === this._pendingAttachments.length)
            return;

        this._pendingAttachments = nextAttachments;
        this._updateAttachmentLabel();
        this._showToast(this._activeImageAttachmentUnsupportedMessage());
    }

    _removePendingAttachment(index) {
        this._pendingAttachments.splice(index, 1);
        this._updateAttachmentLabel();
        this.focusComposer();
    }

    _updateAttachmentLabel() {
        if (this._pendingAttachments.length === 0) {
            this._clearBox(this._attachmentPreviewList);
            this._attachmentRow.set_visible(false);
            return;
        }

        this._clearBox(this._attachmentPreviewList);
        this._pendingAttachments.forEach((attachment, index) => {
            this._attachmentPreviewList.append(this._createPendingAttachmentPreview(attachment, index));
        });
        this._attachmentRow.set_visible(true);
    }

    _createPendingAttachmentPreview(attachment, index) {
        return this._createAttachmentPreviewCard(attachment, {
            onRemove: () => this._removePendingAttachment(index),
            removeTooltip: `Remove ${attachment.name}`,
        });
    }

    _createAttachmentPreviewCard(attachment, options = {}) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });
        card.add_css_class('cusco-composer-attachment-preview');

        const attachmentPaintable = isImageAttachment(attachment) && attachmentPathExists(attachment)
            ? createScaledImagePaintable(
                attachment.path,
                COMPOSER_ATTACHMENT_THUMBNAIL_WIDTH,
                COMPOSER_ATTACHMENT_THUMBNAIL_HEIGHT,
            )
            : null;

        if (attachmentPaintable) {
            const picture = new Gtk.Picture({
                can_shrink: true,
                keep_aspect_ratio: true,
            });
            picture.set_content_fit(Gtk.ContentFit.COVER);
            picture.set_size_request(COMPOSER_ATTACHMENT_THUMBNAIL_WIDTH, COMPOSER_ATTACHMENT_THUMBNAIL_HEIGHT);
            picture.set_paintable(attachmentPaintable);
            picture.add_css_class('cusco-composer-attachment-thumbnail');
            card.append(picture);
        } else {
            const icon = new Gtk.Image({
                icon_name: isImageAttachment(attachment) ? 'image-missing-symbolic' : 'text-x-generic-symbolic',
                pixel_size: 22,
                valign: Gtk.Align.CENTER,
            });
            icon.add_css_class('cusco-composer-attachment-icon');
            card.append(icon);
        }

        const textBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            valign: Gtk.Align.CENTER,
        });
        const nameLabel = new Gtk.Label({
            label: attachment.name,
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 24,
        });
        const kindLabel = new Gtk.Label({
            label: isImageAttachment(attachment) ? 'Image' : 'File',
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 24,
        });
        kindLabel.add_css_class('caption');
        kindLabel.add_css_class('dim-label');
        textBox.append(nameLabel);
        textBox.append(kindLabel);
        card.append(textBox);

        if (options.onRemove) {
            const removeButton = new Gtk.Button({
                icon_name: 'window-close-symbolic',
                tooltip_text: options.removeTooltip ?? `Remove ${attachment.name}`,
                valign: Gtk.Align.CENTER,
            });
            removeButton.add_css_class('flat');
            removeButton.add_css_class('circular');
            removeButton.connect('clicked', options.onRemove);
            card.append(removeButton);
        }

        return card;
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

        return [text, attachmentText].filter(Boolean).join('\n\n');
    }

    async _streamAssistantResponse(conversationId, options = {}) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        const ownsActiveTurn = !options.cancellable;
        const cancellable = options.cancellable ?? this._beginActiveTurn(conversation.id);

        if (!cancellable)
            return;

        this._setFollowLatestMessage(true);
        let assistantView = null;
        let assistantViewState = null;
        let shouldSendQueued = false;
        this._startLongResponseNotification();

        try {
            this._injectMemoryContext(conversation);
            const activeSkills = this._injectSkillContext(conversation);

            if (conversation.agentModeEnabled)
                await this._mcp.refreshTools(this._tools, {
                    timeoutSeconds: this._appSettings.responseTimeoutSeconds,
                    cancellable,
                });

            await this._maybeAutoCompactConversation(conversation, activeSkills, cancellable);

            assistantView = this._createStreamingAssistantView(conversation);
            assistantViewState = { view: assistantView };
            assistantView.set_loading();

            const providerMessages = this._buildProviderMessages(conversation, activeSkills, {
                agentMode: Boolean(conversation.agentModeEnabled),
            });
            let assistantText;

            if (conversation.agentModeEnabled) {
                assistantText = await this._runAgentModeResponse(
                    conversation,
                    providerMessages,
                    assistantViewState,
                    cancellable,
                );
                assistantView = assistantViewState.view;
            } else {
                assistantText = await this._collectProviderResponseWithFallback(
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
            }

            if (isCancellableCancelled(cancellable)) {
                const hadContent = assistantView.hasContent();
                const hadToolResults = assistantView.hasToolResults();

                if (hadContent || hadToolResults)
                    assistantView.clear_status();
                else
                    assistantView.remove();

                this._appendStoppedMessage(
                    conversation.id,
                    hadContent
                        ? 'Response stopped. Partial assistant text was saved.'
                        : 'Response stopped before the assistant returned text.',
                );
                return;
            }

            assistantView.set_stream_text(assistantText, assistantText);
            assistantView.set_artifacts?.(this._materializeAssistantArtifacts(assistantText));
            this._refreshConversationList();
            this._renderActiveConversation();
            shouldSendQueued = ownsActiveTurn;
        } catch (error) {
            assistantView = assistantViewState?.view ?? assistantView;

            if (wasOperationCancelled(error, cancellable)) {
                const hadContent = assistantView?.hasContent?.() ?? false;
                const hadToolResults = assistantView?.hasToolResults?.() ?? false;

                if (hadContent || hadToolResults)
                    assistantView?.clear_status?.();
                else
                    assistantView?.remove?.();

                this._appendStoppedMessage(
                    conversation.id,
                    hadContent
                        ? 'Response stopped. Partial assistant text was saved.'
                        : 'Response stopped before the assistant returned text.',
                );
                return;
            }

            if (assistantView) {
                if (assistantView.hasContent() || assistantView.hasToolResults())
                    assistantView.clear_status();
                else
                    assistantView.remove();
            }

            throw error;
        } finally {
            this._stopLongResponseNotification();
            this._setFollowLatestMessage(false);

            if (ownsActiveTurn)
                this._finishActiveTurn(cancellable);
        }

        if (shouldSendQueued) {
            this._sendQueuedUserMessages(conversation.id).catch((error) => {
                this._handleQueuedUserMessageError(error);
            });
        }
    }

    async _collectProviderResponse(providerId, modelId, providerMessages, cancellable, onChunk = null, collectOptions = {}) {
        const activeProvider = this._providerConfigs.createProvider(providerId);
        const providerConfig = this._providerConfigs.resolve(providerId, modelId);
        let responseText = '';
        let reasoningText = '';
        let usage = null;
        const toolCalls = [];
        const serverToolResults = [];

        for await (const chunk of activeProvider.streamChat(providerMessages, {
            ...providerConfig,
            cancellable,
            timeoutSeconds: this._appSettings.responseTimeoutSeconds,
            maxOutputTokens: collectOptions.maxOutputTokens,
            thinkingLevel: this._resolveThinkingLevelForSelection(
                providerId,
                modelId,
                collectOptions.thinkingLevel
                    ?? this._conversations.activeConversation?.thinkingLevel
                    ?? this._appSettings.thinkingLevel,
            ),
            tools: collectOptions.tools ?? [],
        })) {
            const normalizedChunk = normalizeProviderChunk(chunk);

            if (normalizedChunk.type === 'usage')
                usage = normalizedChunk.usage;
            else if (normalizedChunk.type === 'reasoning')
                reasoningText += normalizedChunk.text;
            else if (normalizedChunk.type === 'tool_calls')
                toolCalls.push(...normalizedChunk.toolCalls);
            else if (normalizedChunk.type === 'server_tool_results')
                serverToolResults.push(...normalizedChunk.serverToolResults);
            else
                responseText += normalizedChunk.text;

            onChunk?.(responseText, normalizedChunk.text, {
                type: normalizedChunk.type,
                text: responseText,
                reasoning: reasoningText,
                usage,
                toolCalls,
                serverToolResults,
                serverToolResultChunk: normalizedChunk.serverToolResults ?? [],
            });
        }

        if (collectOptions.returnState)
            return {
                text: responseText,
                reasoning: reasoningText,
                usage,
                toolCalls,
                serverToolResults,
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

    _createAgentReasoningPayload(conversation, content, createdAt = null) {
        return {
            content: String(content ?? '').trim(),
            providerId: conversation.providerId,
            modelId: conversation.modelId,
            thinkingLevel: conversation.thinkingLevel ?? this._appSettings.thinkingLevel,
            agentMode: true,
            createdAt: createdAt ?? new Date().toISOString(),
        };
    }

    _appendOrUpdateAgentReasoningSegment(conversation, segment, content) {
        const reasoningContent = String(content ?? '').trim();

        if (!reasoningContent)
            return segment;

        if (!segment) {
            const message = createMessage('assistant', '', {
                reasoning: this._createAgentReasoningPayload(conversation, reasoningContent),
            });
            this._conversations.appendMessage(conversation.id, message);
            const view = this._addMessageIfActiveConversation(conversation.id, message);

            this._updateUsageDisplay(conversation);
            this._scrollToBottom();
            return { message, view };
        }

        const storedMessage = this._conversations.updateMessageReasoning(
            conversation.id,
            segment.message.id,
            this._createAgentReasoningPayload(
                conversation,
                reasoningContent,
                segment.message.reasoning?.createdAt,
            ),
        );

        segment.view?.update_reasoning_message?.(storedMessage);
        this._updateUsageDisplay(conversation);
        this._scrollToBottom();
        return {
            message: storedMessage,
            view: segment.view,
        };
    }

    async _runAgentModeResponse(conversation, providerMessages, assistantViewState, cancellable) {
        const runtimeMessages = providerMessages.map((message) => ({ ...message }));
        const getAssistantView = () => assistantViewState.view;
        const setAssistantStatus = (text) => {
            const view = getAssistantView();

            if (typeof view?.set_status === 'function')
                view.set_status(text);
            else
                view?.set_label?.(text);
        };
        const clearAssistantStatus = () => {
            const view = getAssistantView();

            if (typeof view?.clear_status === 'function')
                view.clear_status();
            else if (typeof view?.clear_loading === 'function')
                view.clear_loading();
        };
        const resetAssistantViewAfterPendingMessages = () => {
            const previousView = getAssistantView();

            if (previousView?.hasContent?.() || previousView?.hasToolResults?.())
                previousView.clear_status?.();
            else
                previousView?.remove?.();

            assistantViewState.view = this._createStreamingAssistantView(conversation);
        };

        for (let iteration = 0; iteration < DEFAULT_AGENT_MAX_ITERATIONS; iteration++) {
            if (isCancellableCancelled(cancellable))
                return '';

            const addedUserMessages = this._drainPendingUserMessagesForRuntime(conversation, runtimeMessages);

            if (addedUserMessages.length > 0)
                resetAssistantViewAfterPendingMessages();

            if (iteration === 0 || addedUserMessages.length > 0)
                setAssistantStatus('Agent is thinking...');
            else
                clearAssistantStatus();

            let reasoningSegment = null;
            const responseState = await this._collectProviderResponseWithFallback(
                conversation,
                runtimeMessages,
                cancellable,
                (text, _chunk, state) => {
                    if (state?.type === 'usage')
                        getAssistantView()?.set_usage?.(state.usage);

                    if (state?.type === 'reasoning') {
                        clearAssistantStatus();
                        reasoningSegment = this._appendOrUpdateAgentReasoningSegment(
                            conversation,
                            reasoningSegment,
                            state.reasoning,
                        );
                    }

                    if (state?.type === 'server_tool_results') {
                        this._appendProviderSearchResults(
                            conversation,
                            state.serverToolResultChunk,
                        );
                    }

                    if (state?.type !== 'usage'
                        && state?.type !== 'tool_calls'
                        && state?.type !== 'reasoning'
                        && state?.type !== 'server_tool_results') {
                        this._updateAgentModeAssistantView(conversation, getAssistantView(), text);
                    }
                },
                {
                    returnState: true,
                    tools: this._tools.listTools(),
                },
            );
            reasoningSegment = this._appendOrUpdateAgentReasoningSegment(
                conversation,
                reasoningSegment,
                responseState.reasoning,
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

                    clearAssistantStatus();
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

            clearAssistantStatus();
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
            `Agent stopped after ${DEFAULT_AGENT_MAX_ITERATIONS} tool-use iterations.`,
        );
        this._conversations.appendMessage(conversation.id, limitMessage);
        this._addMessageIfActiveConversation(conversation.id, limitMessage);

        return 'Agent stopped because it reached the tool-use limit. Review the tool results above or send a narrower request.';
    }

    _updateAgentModeAssistantView(conversation, assistantView, text) {
        let displayText;

        if (isPartialAgentToolCall(text)) {
            displayText = 'Agent is preparing a tool call...';
        } else {
            try {
                const toolCall = parseAgentToolCall(text);
                const tool = toolCall ? this._tools.getTool(toolCall.name) : null;
                displayText = toolCall
                    ? (tool ? `Agent requested ${tool.label}...` : 'Agent requested a tool...')
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

        if (this._activeChatCancellable)
            this._setComposerBusy(true);
    }

    _parseAgentToolCallForRuntime(responseText, conversation, runtimeMessages) {
        try {
            return parseAgentToolCall(responseText);
        } catch (error) {
            const reason = error.userMessage ?? error.message;
            const message = createMessage('system', reason);
            this._conversations.appendMessage(conversation.id, message);
            this._addMessageIfActiveConversation(conversation.id, message);
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
            this._addMessageIfActiveConversation(conversation.id, message);
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

        const runningTool = this._appendRunningToolMessage(conversation.id, request, {
            agentMode: true,
        });

        try {
            const result = await this._tools.runRequest(request, {
                providerId: conversation.providerId,
                timeoutSeconds: this._appSettings.responseTimeoutSeconds,
                cancellable,
                onOutput: (chunk) => this._appendToolOutputChunk(runningTool, chunk),
                requestSudoPassword: request.name === 'bash'
                    ? (command) => this._promptSudoPassword(command, cancellable)
                    : null,
            });
            const transcriptText = formatToolResultForTranscript(result);
            this._completeRunningToolMessage(
                conversation.id,
                runningTool,
                result,
                result.cancelled ? 'cancelled' : 'completed',
                { agentMode: true },
            );

            if (result.cancelled)
                return false;

            runtimeMessages.push(
                { role: 'assistant', content: responseText },
                { role: 'user', content: createAgentToolResultPrompt(request, transcriptText) },
            );
            return true;
        } catch (error) {
            if (wasOperationCancelled(error, cancellable)) {
                const reason = `${request.label} was stopped before it finished.`;
                this._completeRunningToolFailure(
                    conversation.id,
                    runningTool,
                    request,
                    reason,
                    'cancelled',
                    { agentMode: true },
                );
                runtimeMessages.push(
                    { role: 'assistant', content: responseText },
                    { role: 'user', content: createAgentToolFailurePrompt(request, reason) },
                );
                return false;
            }

            const reason = error.userMessage ?? `Tool failed: ${error.message}`;
            this._completeRunningToolFailure(
                conversation.id,
                runningTool,
                request,
                reason,
                'failed',
                { agentMode: true },
            );
            runtimeMessages.push(
                { role: 'assistant', content: responseText },
                { role: 'user', content: createAgentToolFailurePrompt(request, reason) },
            );
            logError(error, 'Failed to run Agent tool request');
            return false;
        }
    }

    _appendProviderSearchResults(conversation, serverToolResults) {
        for (const searchResult of serverToolResults ?? []) {
            const isXSearch = searchResult?.name === 'x_search';
            const request = {
                name: isXSearch ? 'x_search' : 'search',
                label: searchResult?.label ?? (isXSearch ? 'X Search' : 'Web Search'),
                input: String(searchResult?.query ?? '').trim() || 'Provider-managed search',
                permissionPolicy: 'allow',
                requiresPermission: false,
            };
            const runningTool = this._appendRunningToolMessage(conversation.id, request, {
                agentMode: true,
            });
            const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
            const result = {
                ...request,
                query: request.input,
                results,
                providerId: searchResult?.providerId ?? conversation.providerId,
                providerName: searchResult?.providerName ?? '',
                output: `${results.length} cited result${results.length === 1 ? '' : 's'} returned.`,
            };

            this._completeRunningToolMessage(
                conversation.id,
                runningTool,
                result,
                'completed',
                { agentMode: true },
            );
        }

        this._scrollToBottom();
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
        this._addMessageIfActiveConversation(conversation.id, message);
        this._updateUsageDisplay(conversation);
        runtimeMessages.push(
            { role: 'assistant', content: responseText },
            { role: 'user', content: createAgentToolFailurePrompt(request, reason) },
        );
    }

    _beginActiveTurn(conversationId = null, cancellable = new Gio.Cancellable()) {
        if (this._activeChatCancellable)
            return null;

        this._activeChatCancellable = cancellable;
        this._activeTurnConversationId = conversationId
            ?? this._conversations.activeConversation?.id
            ?? null;
        this._setComposerBusy(true);
        return cancellable;
    }

    _finishActiveTurn(cancellable) {
        if (this._activeChatCancellable === cancellable) {
            this._activeChatCancellable = null;
            this._activeTurnConversationId = null;
        }

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

    _isActiveConversationId(conversationId) {
        return this._conversations.activeConversation?.id === conversationId;
    }

    _addMessageIfActiveConversation(conversationId, message) {
        if (!this._isActiveConversationId(conversationId))
            return null;

        return this._addMessage(message.content, message.role, message);
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

    _materializeAssistantArtifacts(text) {
        try {
            return extractArtifactsFromMarkdown(text, {
                generatedBy: 'assistant',
            });
        } catch (error) {
            logError(error, 'Failed to materialize assistant artifacts');
            return [];
        }
    }

    _createStreamingAssistantView(conversation) {
        let view = null;
        let assistantMessage = null;
        let currentText = '';
        let currentReasoning = '';
        let currentUsage = null;

        const ensureView = () => {
            if (!this._isActiveConversationId(conversation.id))
                return null;

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
            ensureView()?.set_label(displayText);
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
            ensureView()?.set_reasoning(currentReasoning);
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
        const updatePersistentArtifacts = (artifacts) => {
            const message = ensureMessage(currentText);
            const storedMessage = this._conversations.updateMessageArtifacts(conversation.id, message.id, artifacts);

            assistantMessage = storedMessage;
        };

        return {
            set_label: (text) => updatePersistentText(text, text),
            set_stream_text: updatePersistentText,
            set_reasoning: updatePersistentReasoning,
            set_usage: updatePersistentUsage,
            set_artifacts: updatePersistentArtifacts,
            set_loading: () => ensureView()?.set_loading(),
            set_status: (text) => ensureView()?.set_status(text),
            clear_status: () => view?.clear_loading?.(),
            remove: () => view?.remove?.(),
            hasContent: () => currentText.length > 0 || currentReasoning.length > 0 || Boolean(currentUsage),
            hasToolResults: () => view?.has_tool_results?.() ?? false,
        };
    }

    _startLongResponseNotification() {
        this._stopLongResponseNotification();
        this._longResponseNotificationId = `long-response-${GLib.uuid_string_random()}`;
        this._longResponseNotificationSent = false;
        this._longResponseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_RESPONSE_NOTIFICATION_DELAY_MS, () => {
            if (this._shouldSendLongResponseNotification()) {
                const notification = new Gio.Notification();
                notification.set_title('Cusco is still responding');
                notification.set_body('The current response is taking longer than usual.');
                this.get_application()?.send_notification(this._longResponseNotificationId, notification);
                this._longResponseNotificationSent = true;
            }

            this._longResponseTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _shouldSendLongResponseNotification() {
        return !this.is_active();
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

        this._memories.recordMemoryUse(memories.map((memory) => memory.id), {
            conversationId: conversation.id,
            messageId: '',
        });
    }

    _injectSkillContext(conversation) {
        const skills = this._workspace.getSkillsForConversation(conversation);
        const loadedIds = new Set(skills.map((skill) => skill.id));
        const currentTurnUserMessages = [];

        for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
            const message = conversation.messages[index];

            if (message.role === 'assistant')
                break;

            if (message.role === 'user')
                currentTurnUserMessages.push(message);
        }

        const references = currentTurnUserMessages.flatMap((message) => (
            normalizeComposerReferences(message.metadata?.composerReferences)
        ));

        for (const reference of references) {
            if (reference.kind !== 'skill' || loadedIds.has(reference.value))
                continue;

            const record = this._workspace.getSkill(reference.value);

            if (!record?.enabled || record.loadError)
                continue;

            try {
                const skill = this._workspace.loadSkill(reference.value);

                if (skill?.content && !skill.loadError) {
                    skills.push(skill);
                    loadedIds.add(skill.id);
                }
            } catch (error) {
                logError(error, `Failed to load referenced skill ${reference.value}`);
            }
        }

        return skills;
    }

    _buildProviderMessages(conversation, skills, options = {}) {
        const systemMessages = [{
            role: 'system',
            content: BASE_RESPONSE_SYSTEM_PROMPT,
        }];

        if (options.agentMode) {
            const nativeSearchTools = this._providerConfigs.getNativeSearchTools(
                conversation.providerId,
                conversation.modelId,
            );
            const cuscoTools = nativeSearchTools.length > 0
                ? this._tools.listTools().filter((tool) => tool.name !== 'search')
                : this._tools.listTools();

            systemMessages.push({
                role: 'system',
                content: buildAgentModeSystemPrompt(cuscoTools, { nativeSearchTools }),
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

    async _maybeAutoCompactConversation(conversation, skills, cancellable) {
        const contextWindowTokens = this._getContextWindowTokens(conversation);

        if (!contextWindowTokens)
            return false;

        const providerMessages = this._buildProviderMessages(conversation, skills, {
            agentMode: Boolean(conversation.agentModeEnabled),
        });
        const usageState = getContextUsageState(providerMessages, contextWindowTokens);

        if (!usageState.shouldCompact)
            return false;

        const compaction = prepareContextCompaction(conversation.messages, contextWindowTokens);

        if (!compaction)
            return false;

        this._showToast('Compacting context...');
        const summary = await this._generateContextCompactionSummary(conversation, compaction, cancellable);
        const nextMessages = buildCompactedMessageList(summary, compaction, {
            providerId: conversation.providerId,
            modelId: conversation.modelId,
        });

        this._conversations.replaceMessages(conversation.id, nextMessages);
        if (this._isActiveConversationId(conversation.id))
            this._renderActiveConversation();
        else
            this._refreshConversationList();

        this._showToast('Context compacted');
        return true;
    }

    async _generateContextCompactionSummary(conversation, compaction, cancellable) {
        const prompt = buildCompactionPrompt(compaction);
        const messages = [
            createMessage(
                'system',
                'Create concise, factual continuation summaries for long AI chat sessions.',
            ),
            createMessage('user', prompt),
        ];
        const summary = String(await this._collectProviderResponse(
            conversation.providerId,
            conversation.modelId,
            messages,
            cancellable,
            null,
            {
                maxOutputTokens: AUTO_COMPACTION_MAX_SUMMARY_OUTPUT_TOKENS,
                thinkingLevel: 'off',
                tools: [],
            },
        )).trim();

        if (!summary) {
            const error = new Error('Context compaction returned an empty summary.');
            error.userMessage = 'Context compaction failed before sending.';
            throw error;
        }

        return summary;
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
        if (!hasEnabledProviders)
            this._thinkingLevelPicker?.set_visible(false);
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
            this._thinkingLevelPicker.set_visible(false);
            this._thinkingLevelPicker.set_sensitive(false);
            return;
        }

        const levels = this._providerConfigs.getThinkingLevels(conversation.providerId, conversation.modelId);

        if (levels.length === 0) {
            this._thinkingLevelPicker.set_visible(false);
            this._thinkingLevelPicker.set_tooltip_text('Thinking is not supported by this provider and model.');
            this._thinkingLevelPicker.set_sensitive(false);
            return;
        }

        for (const level of levels)
            this._thinkingLevelPicker.append(level, getThinkingLevelLabel(level));

        const currentLevel = normalizeThinkingLevel(conversation.thinkingLevel ?? this._appSettings.thinkingLevel);
        const selectedLevel = levels.includes(currentLevel)
            ? currentLevel
            : this._providerConfigs.getDefaultThinkingLevel(
                conversation.providerId,
                conversation.modelId,
                currentLevel,
            );

        this._thinkingLevelPicker.set_active_id(selectedLevel);
        this._thinkingLevelPicker.set_tooltip_text('Thinking level for this chat');
        this._thinkingLevelPicker.set_visible(true);
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
            tooltip_text: 'Chat options',
            valign: Gtk.Align.CENTER,
            icon_name: 'pan-down-symbolic',
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

        this._memoryToggleButton = new Gtk.Switch({
            tooltip_text: 'Use memories for this chat',
            valign: Gtk.Align.CENTER,
        });
        this._memoryToggleButton.connect('notify::active', () => this._handleMemoryToggleChanged());

        this._agentModeToggleButton = new Gtk.Switch({
            tooltip_text: 'Agent',
            valign: Gtk.Align.CENTER,
        });
        this._agentModeToggleButton.connect('notify::active', () => this._handleAgentModeToggleChanged());

        this._skillsToggleButton = new Gtk.Switch({
            tooltip_text: 'Use enabled skills for this chat',
            valign: Gtk.Align.CENTER,
        });
        this._skillsToggleButton.connect('notify::active', () => this._handleSkillsToggleChanged());

        content.append(createLabeledControlRow('Memory', this._memoryToggleButton));
        content.append(createLabeledControlRow('Agent', this._agentModeToggleButton));
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

        this._setComposerText(nextText, { preserveReferences: true });
        this._composerBuffer.place_cursor(this._composerBuffer.get_iter_at_offset(nextCursorPosition));
        this.focusComposer();
    }

    _syncProviderControls(conversation) {
        if (!conversation) {
            this._populateThinkingLevelPicker(null);
            return;
        }

        this._isUpdatingProviderControls = true;
        this._providerPicker.set_active_id(conversation.providerId);
        this._populateModelPicker(conversation.providerId, conversation.modelId);
        this._populateThinkingLevelPicker(conversation);
        this._memoryToggleButton.set_active(conversation.memoryEnabled !== false);
        this._agentModeToggleButton.set_active(Boolean(conversation.agentModeEnabled));
        this._skillsToggleButton.set_active(this._workspace.getSkillsForConversation(conversation).length > 0);
        this._skillsToggleButton.set_sensitive(this._workspace.enabledSkills.length > 0);
        this._isUpdatingProviderControls = false;
        this._discardPendingImageAttachmentsIfUnsupportedProvider();
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

        return this._providerConfigs.getDefaultThinkingLevel(providerId, modelId, normalizedLevel);
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
        this._discardPendingImageAttachmentsIfUnsupportedProvider();
        this._updateUsageDisplay(conversation);
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
        this._updateUsageDisplay(conversation);
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
                    conversation.agentModeEnabled ? 'Agent' : '',
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
            tooltip_text: 'Chat actions',
            valign: Gtk.Align.CENTER,
        });
        menuButton.set_child(createBundledIcon(MORE_VERTICAL_ICON_FILE, 'view-more-symbolic'));
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
        this._syncEmptyConversationState(conversation);
        this._renderPendingUserMessages(conversation);

        for (const message of conversation?.messages ?? [])
            this._addMessage(message.content, message.role, message);

        this._updateUsageDisplay(conversation);
        this._scrollToBottom();
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
        this._syncComposerUsageChart();
        this._syncComposerHint(Boolean(this._activeChatCancellable));
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
        this._settingsButton.set_sensitive(true);
    }

    _messageContentOptions(options = {}) {
        return {
            codeTheme: this._appSettings.codeTheme,
            ...options,
        };
    }

    _createEmptyConversationState() {
        const revealer = new Gtk.Revealer({
            halign: Gtk.Align.START,
            valign: Gtk.Align.START,
            transition_type: Gtk.RevealerTransitionType.CROSSFADE,
            transition_duration: EMPTY_STATE_FADE_DURATION_MS,
            reveal_child: false,
            visible: false,
            can_target: false,
        });
        revealer.add_css_class('cusco-empty-conversation-state');

        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
            can_target: false,
        });

        const frame = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
        });
        frame.add_css_class('cusco-empty-photo-frame');

        const lip = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
        });
        lip.add_css_class('cusco-empty-photo-lip');

        const mat = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
        });
        mat.add_css_class('cusco-empty-photo-mat');

        this._emptyConversationPicture = new Gtk.Picture({
            hexpand: true,
            vexpand: true,
            can_shrink: true,
            content_fit: Gtk.ContentFit.COVER,
        });
        this._emptyConversationPicture.add_css_class('cusco-empty-photo');

        mat.append(this._emptyConversationPicture);
        lip.append(mat);
        frame.append(lip);
        container.append(frame);
        revealer.set_child(container);

        const styleManager = Adw.StyleManager.get_default();
        this._emptyConversationThemeHandlerId = styleManager.connect('notify::dark', () => {
            this._updateEmptyConversationImage();
        });
        this._updateEmptyConversationImage();

        return revealer;
    }

    _syncEmptyConversationState(conversation = this._conversations.activeConversation) {
        if (!this._emptyConversationState)
            return;

        const isEmpty = (conversation?.messages?.length ?? 0) === 0;

        if (isEmpty)
            this._showEmptyConversationState();
        else
            this._hideEmptyConversationState();
    }

    _showEmptyConversationState() {
        if (!this._emptyConversationState)
            return;

        if (this._emptyConversationFadeTimeoutId) {
            GLib.source_remove(this._emptyConversationFadeTimeoutId);
            this._emptyConversationFadeTimeoutId = 0;
        }

        this._updateEmptyConversationImage();
        this._emptyConversationState.set_visible(true);
        this._emptyConversationState.set_reveal_child(true);
    }

    _hideEmptyConversationState() {
        if (!this._emptyConversationState)
            return;

        if (this._emptyConversationFadeTimeoutId) {
            GLib.source_remove(this._emptyConversationFadeTimeoutId);
            this._emptyConversationFadeTimeoutId = 0;
        }

        if (!this._emptyConversationState.get_visible()) {
            this._emptyConversationState.set_reveal_child(false);
            return;
        }

        this._emptyConversationState.set_reveal_child(false);
        this._emptyConversationFadeTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            EMPTY_STATE_FADE_DURATION_MS,
            () => {
                this._emptyConversationFadeTimeoutId = 0;

                if (!this._emptyConversationState?.get_reveal_child?.())
                    this._emptyConversationState?.set_visible(false);

                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _updateEmptyConversationImage() {
        if (!this._emptyConversationPicture)
            return;

        const styleManager = Adw.StyleManager.get_default();
        const filename = styleManager.get_dark() ? EMPTY_STATE_IMAGE_DARK : EMPTY_STATE_IMAGE_LIGHT;
        const path = getBundledImagePath(filename);

        if (!path) {
            this._emptyConversationPicture.set_visible(false);
            return;
        }

        this._emptyConversationPicture.set_filename(path);
        this._emptyConversationPicture.set_visible(true);
    }

    _createKnotIcon(options = {}) {
        const {
            width = 30,
            height = 14,
            animate = true,
        } = options;
        const shouldAnimate = animate && !this._appSettings.reducedMotionEnabled;
        const startTime = GLib.get_monotonic_time();
        const icon = new Gtk.DrawingArea({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });

        icon.set_size_request(width, height);
        icon.add_css_class('cusco-knot-icon');
        icon.set_draw_func((widget, cr, drawWidth, drawHeight) => {
            const color = widget.get_color();
            const padding = 1;
            const scale = Math.min(
                (drawWidth - padding * 2) / KNOT_ICON_VIEWBOX_WIDTH,
                (drawHeight - padding * 2) / KNOT_ICON_VIEWBOX_HEIGHT,
            );

            if (!Number.isFinite(scale) || scale <= 0)
                return;

            const elapsedSeconds = (GLib.get_monotonic_time() - startTime) / 1000000;
            const progress = shouldAnimate
                ? mirrorProgress(elapsedSeconds / KNOT_ICON_ANIMATION_SECONDS)
                : 1;

            cr.save();
            cr.translate(
                (drawWidth - KNOT_ICON_VIEWBOX_WIDTH * scale) / 2,
                (drawHeight - KNOT_ICON_VIEWBOX_HEIGHT * scale) / 2,
            );
            cr.scale(scale, scale);
            cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha);
            cr.setLineWidth(KNOT_ICON_STROKE_WIDTH);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            drawKnotIconPath(cr, progress);
            cr.restore();
        });

        if (shouldAnimate) {
            icon.add_tick_callback((widget) => {
                widget.queue_draw();
                return GLib.SOURCE_CONTINUE;
            });
        }

        return icon;
    }

    _createKnotStatusRow(text = '', options = {}) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: options.compact ? 6 : 8,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        const label = new Gtk.Label({
            label: String(text ?? ''),
            xalign: 0,
            valign: Gtk.Align.CENTER,
            visible: Boolean(text),
        });

        row.add_css_class('cusco-knot-status');
        row.append(this._createKnotIcon({
            width: options.compact ? 22 : 32,
            height: options.compact ? 10 : 15,
            animate: options.animate !== false,
        }));
        row.append(label);
        row.updateStatusText = (nextText) => {
            const normalizedText = String(nextText ?? '');

            label.set_label(normalizedText);
            label.set_visible(Boolean(normalizedText));
        };

        return row;
    }

    _createThinkingLabelWidget(isActive) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        const label = new Gtk.Label({
            label: isActive ? 'Thinking' : 'Reasoning',
            xalign: 0,
            valign: Gtk.Align.CENTER,
        });

        if (isActive)
            row.append(this._createKnotIcon({ width: 22, height: 10 }));

        row.append(label);
        return row;
    }

    _createReasoningExpander(content, options = {}) {
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
        });
        const revealer = new Gtk.Revealer({
            child: content,
            reveal_child: false,
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
        });
        const headerButton = new Gtk.Button({
            halign: Gtk.Align.START,
        });
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        const chevron = new Gtk.Image({
            icon_name: 'pan-end-symbolic',
            pixel_size: 14,
            valign: Gtk.Align.CENTER,
        });

        container.add_css_class('cusco-reasoning');
        headerButton.add_css_class('flat');
        headerButton.add_css_class('cusco-reasoning-header');
        chevron.add_css_class('cusco-reasoning-toggle-icon');

        header.append(this._createThinkingLabelWidget(options.isActive));
        header.append(chevron);
        headerButton.set_child(header);

        const updateExpandedState = (expanded) => {
            headerButton.set_tooltip_text(expanded ? 'Collapse reasoning' : 'Expand reasoning');

            if (expanded)
                chevron.add_css_class('cusco-reasoning-toggle-icon-expanded');
            else
                chevron.remove_css_class('cusco-reasoning-toggle-icon-expanded');
        };

        headerButton.connect('clicked', () => {
            const expanded = !revealer.get_reveal_child();

            revealer.set_reveal_child(expanded);
            updateExpandedState(expanded);
        });
        updateExpandedState(false);

        container.append(headerButton);
        container.append(revealer);
        return container;
    }

    _createAgentReasoningSegment(message) {
        const content = createMessageContent(
            getMessageReasoningContent(message) || ' ',
            this._messageContentOptions({
                role: 'assistant',
                hexpand: true,
                codeMinWidth: 380,
            }),
        );
        const expander = this._createReasoningExpander(content);

        expander.updateReasoningMessage = (nextMessage) => {
            content.updateContent(getMessageReasoningContent(nextMessage) || ' ');
        };

        return expander;
    }

    _createBashOutputPreview(initialOutput = '') {
        const buffer = new Gtk.TextBuffer();
        const view = new Gtk.TextView({
            buffer,
            editable: false,
            cursor_visible: false,
            monospace: true,
            hexpand: true,
        });
        view.set_wrap_mode(Gtk.WrapMode.NONE);
        view.add_css_class('cusco-tool-output-preview-text');

        const scroller = new Gtk.ScrolledWindow({
            child: view,
            hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: 58,
            max_content_height: 58,
            propagate_natural_height: false,
        });
        let autoScroll = true;
        let updatingScroll = false;

        scroller.add_css_class('cusco-tool-output-preview');
        scroller.get_vadjustment().connect('value-changed', (adjustment) => {
            if (updatingScroll)
                return;

            autoScroll = adjustment.get_value() >= adjustment.get_upper() - adjustment.get_page_size() - 2;
        });

        scroller.updateOutputPreview = (output) => {
            const text = latestOutputLines(output);
            const adjustment = scroller.get_vadjustment();
            const shouldScroll = autoScroll
                || adjustment.get_value() >= adjustment.get_upper() - adjustment.get_page_size() - 2;

            buffer.set_text(text, -1);

            if (!shouldScroll)
                return;

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                updatingScroll = true;
                adjustment.set_value(Math.max(adjustment.get_lower(), adjustment.get_upper() - adjustment.get_page_size()));
                updatingScroll = false;
                return GLib.SOURCE_REMOVE;
            });
        };
        scroller.updateOutputPreview(initialOutput);
        return scroller;
    }

    _createToolImagePreview() {
        const frame = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            halign: Gtk.Align.START,
        });
        frame.add_css_class('cusco-tool-image-preview');
        frame.set_visible(false);

        frame.updateImage = (toolCall = {}) => {
            this._clearBox(frame);

            const artifact = (toolCall.artifacts ?? []).find((item) => item?.kind === 'image')
                ?? (String(toolCall.imagePath ?? '').trim()
                    ? {
                        kind: 'image',
                        title: 'Generated image',
                        mimeType: toolCall.mimeType ?? 'image/png',
                        path: toolCall.imagePath,
                        sourceBlockIndex: -1,
                        sourceLanguage: '',
                        createdAt: toolCall.completedAt ?? toolCall.createdAt ?? new Date().toISOString(),
                        generatedBy: 'image_gen',
                    }
                    : null);
            const imagePath = String(toolCall.imagePath ?? '').trim();

            if (!artifact || (!imagePath && !artifact.path)) {
                frame.set_visible(false);
                return;
            }

            frame.append(createArtifactCard(artifact, {
                parentWindow: this,
                codeTheme: this._appSettings.codeTheme,
                codeMinWidth: 360,
            }));
            frame.set_visible(true);
        };

        return frame;
    }

    _createToolResultExpander(message, options = {}) {
        let currentMessage = message;
        let previousStatus = '';
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
        });
        const textBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        const titleRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
        });
        const actionLabel = new Gtk.Label({
            xalign: 0,
            valign: Gtk.Align.CENTER,
            ellipsize: Pango.EllipsizeMode.END,
        });
        const statusPill = new Gtk.Label({
            xalign: 0.5,
            valign: Gtk.Align.CENTER,
        });
        const targetLabel = new Gtk.Label({
            xalign: 0,
            valign: Gtk.Align.CENTER,
            ellipsize: Pango.EllipsizeMode.END,
            hexpand: true,
            max_width_chars: 76,
        });
        const detailLabel = new Gtk.Label({
            xalign: 0,
            valign: Gtk.Align.CENTER,
            ellipsize: Pango.EllipsizeMode.END,
        });
        const bodyContent = createMessageContent(message.content || ' ', this._messageContentOptions({
            role: 'system',
            hexpand: true,
            codeMinWidth: 380,
        }));
        const revealer = new Gtk.Revealer({
            child: bodyContent,
            reveal_child: false,
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
        });
        const headerButton = new Gtk.Button({
            halign: Gtk.Align.START,
        });
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });
        const chevron = new Gtk.Image({
            icon_name: 'pan-end-symbolic',
            pixel_size: 14,
            valign: Gtk.Align.CENTER,
        });
        const outputPreview = this._createBashOutputPreview('');
        const imagePreview = this._createToolImagePreview();

        container.add_css_class('cusco-tool-result');
        actionLabel.add_css_class('cusco-tool-result-action');
        targetLabel.add_css_class('cusco-tool-result-target');
        detailLabel.add_css_class('caption');
        detailLabel.add_css_class('dim-label');
        statusPill.add_css_class('cusco-tool-result-status');
        chevron.add_css_class('cusco-tool-result-toggle-icon');
        outputPreview.set_visible(false);

        if (!options.embedded) {
            container.set_size_request(460, -1);
            bodyContent.add_css_class('cusco-message-bubble');
            bodyContent.add_css_class('cusco-message-assistant');
        }

        headerButton.add_css_class('flat');
        headerButton.add_css_class('cusco-tool-result-header');

        titleRow.append(actionLabel);
        titleRow.append(statusPill);
        textBox.append(titleRow);
        textBox.append(targetLabel);
        textBox.append(detailLabel);
        header.append(textBox);
        header.append(chevron);
        headerButton.set_child(header);
        headerButton.connect('clicked', () => {
            const expanded = !revealer.get_reveal_child();

            revealer.set_reveal_child(expanded);
            headerButton.set_tooltip_text(
                `${expanded ? 'Collapse' : 'Expand'} ${currentMessage.toolCall?.label ?? 'tool'} result`,
            );

            if (expanded)
                chevron.add_css_class('cusco-tool-result-toggle-icon-expanded');
            else
                chevron.remove_css_class('cusco-tool-result-toggle-icon-expanded');
        });

        const setStatusClass = (status) => {
            if (previousStatus)
                statusPill.remove_css_class(`cusco-tool-result-status-${previousStatus}`);

            previousStatus = status;
            statusPill.add_css_class(`cusco-tool-result-status-${status}`);
        };
        const updateFromMessage = () => {
            const display = normalizeToolCallDisplay(currentMessage.toolCall);
            const target = display.target || display.label;
            const detail = display.detail;

            setStatusClass(display.status);
            actionLabel.set_label(display.action);
            statusPill.set_label(display.statusLabel);
            targetLabel.set_label(target);
            targetLabel.set_visible(Boolean(target));
            detailLabel.set_label(detail);
            detailLabel.set_visible(Boolean(detail));
            bodyContent.updateContent(currentMessage.content || ' ');
            outputPreview.updateOutputPreview(display.outputPreview);
            outputPreview.set_visible(display.isBash && Boolean(display.outputPreview));
            imagePreview.updateImage(currentMessage.toolCall);
            headerButton.set_tooltip_text(
                `${revealer.get_reveal_child() ? 'Collapse' : 'Expand'} ${display.label} result`,
            );
        };

        container.append(headerButton);
        container.append(outputPreview);
        container.append(imagePreview);
        container.append(revealer);
        container.updateToolMessage = (nextMessage) => {
            currentMessage = nextMessage;
            updateFromMessage();
        };
        container.appendToolOutput = (output) => {
            if (currentMessage.toolCall)
                currentMessage.toolCall.outputPreview = output;

            outputPreview.updateOutputPreview(output);
            outputPreview.set_visible(Boolean(output));
        };

        updateFromMessage();
        return container;
    }

    _createMessageImageAttachmentPreviews(message, role) {
        const imageAttachments = (message?.attachments ?? []).filter(isImageAttachment);

        if (imageAttachments.length === 0)
            return null;

        const list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            halign: role === 'user' ? Gtk.Align.END : Gtk.Align.START,
        });
        list.add_css_class('cusco-message-image-attachments');

        imageAttachments.forEach((attachment) => {
            list.append(this._createMessageImageAttachmentPreview(attachment));
        });

        return list;
    }

    _createMessageImageAttachmentPreview(attachment) {
        return this._createAttachmentPreviewCard(attachment);
    }

    _addMessage(body, kind, message = null) {
        if (isAgentReasoningMessage(message) && this._lastAssistantMessageView?.append_reasoning_segment) {
            const reasoningView = this._lastAssistantMessageView.append_reasoning_segment(message);
            this._scrollToBottom();
            return reasoningView ?? { set_label: () => {} };
        }

        if (message?.toolCall?.agentMode && this._lastAssistantMessageView?.append_tool_result) {
            const toolView = this._lastAssistantMessageView.append_tool_result(message);
            this._scrollToBottom();
            return toolView ?? { set_label: () => {} };
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
        const isStreamingAssistant = kind === 'assistant' && !message;
        let reasoningContent = null;
        let reasoningExpander = null;

        if (kind === 'assistant') {
            reasoningContent = createMessageContent(reasoningText || ' ', this._messageContentOptions({
                role: 'assistant',
                hexpand: true,
                codeMinWidth: 380,
            }));
            reasoningContent.add_css_class('cusco-message-bubble');
            reasoningContent.add_css_class('cusco-message-assistant');
            reasoningExpander = this._createReasoningExpander(reasoningContent, {
                isActive: isStreamingAssistant,
            });
            reasoningExpander.set_visible(Boolean(reasoningText));
            wrapper.append(reasoningExpander);
        }

        const bubble = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: Boolean(kind !== 'user'),
        });
        bubble.add_css_class('cusco-message-bubble');
        bubble.add_css_class(kind === 'user' ? 'cusco-message-user' : 'cusco-message-assistant');

        const imageAttachmentPreviews = this._createMessageImageAttachmentPreviews(message, kind);
        const displayBody = displayBodyWithoutImageAttachmentLines(body, message);
        const bodyContent = createMessageContent(displayBody || ' ', this._messageContentOptions({
            role: kind,
            artifacts: message?.artifacts ?? [],
            parentWindow: this,
        }));
        let currentBodyText = String(displayBody ?? '');
        let loadingRow = null;
        let hasToolResults = false;

        if ((isStreamingAssistant || imageAttachmentPreviews) && !currentBodyText)
            bodyContent.set_visible(false);

        const clearLoading = () => {
            if (!loadingRow)
                return;

            bubble.remove(loadingRow);
            loadingRow = null;

            if (!currentBodyText)
                bodyContent.set_visible(false);
        };
        const showLoading = (text = '') => {
            if (!loadingRow) {
                loadingRow = this._createKnotStatusRow(text);
                bubble.prepend(loadingRow);
            } else {
                loadingRow.updateStatusText?.(text);
            }

            bodyContent.set_visible(false);
        };
        const updateBodyContent = (text) => {
            const nextText = String(text ?? '');

            if (!nextText && loadingRow)
                return;

            currentBodyText = nextText;
            clearLoading();
            bodyContent.set_visible(true);
            bodyContent.updateContent(nextText);
        };

        let agentActivityBox = null;
        const ensureAgentActivityBox = () => {
            if (!agentActivityBox) {
                agentActivityBox = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    spacing: 4,
                    hexpand: true,
                });
                bubble.prepend(agentActivityBox);
            }

            return agentActivityBox;
        };
        const appendReasoningSegment = (reasoningMessage) => {
            hasToolResults = true;

            const reasoningWidget = this._createAgentReasoningSegment(reasoningMessage);
            ensureAgentActivityBox().append(reasoningWidget);
            return {
                update_reasoning_message: (nextMessage) => {
                    reasoningWidget.updateReasoningMessage?.(nextMessage);
                },
            };
        };
        const appendToolResult = (toolMessage) => {
            hasToolResults = true;

            const toolWidget = this._createToolResultExpander(toolMessage, { embedded: true });
            ensureAgentActivityBox().append(toolWidget);
            return {
                update_tool_message: (nextMessage) => toolWidget.updateToolMessage?.(nextMessage),
                append_tool_output: (output) => toolWidget.appendToolOutput?.(output),
            };
        };

        if (imageAttachmentPreviews && kind === 'user')
            wrapper.append(imageAttachmentPreviews);

        bubble.append(bodyContent);

        if (imageAttachmentPreviews && kind !== 'user')
            bubble.append(imageAttachmentPreviews);

        if (currentBodyText || isStreamingAssistant || kind !== 'user')
            wrapper.append(bubble);

        if (message?.id && kind !== 'system')
            wrapper.append(this._createMessageActions(message));

        this._appendMessageWidget(wrapper);
        this._scrollToBottom();

        let messageView = null;
        messageView = {
            set_label: updateBodyContent,
            set_loading: showLoading,
            set_status: showLoading,
            clear_loading: clearLoading,
            set_reasoning: (text) => {
                if (!reasoningContent || !reasoningExpander)
                    return;

                const nextText = String(text ?? '').trim();
                reasoningContent.updateContent(nextText || ' ');
                reasoningExpander.set_visible(Boolean(nextText));
            },
            append_tool_result: appendToolResult,
            append_reasoning_segment: appendReasoningSegment,
            has_tool_results: () => hasToolResults,
            remove: () => {
                if (wrapper.get_parent())
                    this._messages.remove(wrapper);

                if (this._lastAssistantMessageView === messageView)
                    this._lastAssistantMessageView = null;
            },
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
        const toolWidget = this._createToolResultExpander(message);
        wrapper.append(toolWidget);
        this._appendMessageWidget(wrapper);
        this._lastAssistantMessageView = null;
        this._scrollToBottom();

        return {
            set_label: () => {},
            update_tool_message: (nextMessage) => toolWidget.updateToolMessage?.(nextMessage),
            append_tool_output: (output) => toolWidget.appendToolOutput?.(output),
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
        this._hideEmptyConversationState();

        if (this._messageBottomSpacer?.get_parent?.() === this._messages)
            this._messages.remove(this._messageBottomSpacer);

        this._messages.append(widget);
        this._appendMessageBottomSpacer();
    }

    _setFollowLatestMessage(enabled) {
        this._followLatestMessage = Boolean(enabled);
        this._scrollToBottom({ passes: enabled ? 3 : 2 });
    }

    _stopScrollToBottomAnimation() {
        if (!this._scrollToBottomAnimationSourceId)
            return;

        GLib.source_remove(this._scrollToBottomAnimationSourceId);
        this._scrollToBottomAnimationSourceId = 0;
    }

    _getScrollToBottomValue() {
        if (!this._scroller)
            return 0;

        const adjustment = this._scroller.get_vadjustment();
        return Math.max(0, adjustment.get_upper() - adjustment.get_page_size());
    }

    _animateScrollToBottom() {
        if (!this._scroller || this._appSettings.reducedMotionEnabled) {
            this._scrollToBottom({ passes: 2 });
            return;
        }

        this._stopScrollToBottomAnimation();

        const adjustment = this._scroller.get_vadjustment();
        const startValue = adjustment.get_value();
        const startTime = GLib.get_monotonic_time();

        if (Math.abs(this._getScrollToBottomValue() - startValue) < 1) {
            adjustment.set_value(this._getScrollToBottomValue());
            this._syncScrollToBottomButton();
            return;
        }

        this._scrollToBottomAnimationSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SCROLL_TO_BOTTOM_ANIMATION_INTERVAL_MS,
            () => {
                const elapsedMs = (GLib.get_monotonic_time() - startTime) / 1000;
                const progress = Math.min(1, elapsedMs / SCROLL_TO_BOTTOM_ANIMATION_MS);
                const easedProgress = 1 - Math.pow(1 - progress, 3);
                const endValue = this._getScrollToBottomValue();

                adjustment.set_value(startValue + ((endValue - startValue) * easedProgress));
                this._syncScrollToBottomButton();

                if (progress < 1)
                    return GLib.SOURCE_CONTINUE;

                adjustment.set_value(this._getScrollToBottomValue());
                this._scrollToBottomAnimationSourceId = 0;
                this._syncScrollToBottomButton();
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _queueScrollToBottomPass() {
        if (this._scrollToBottomSourceId)
            return;

        this._scrollToBottomSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollToBottomSourceId = 0;

            if (!this._scroller) {
                this._scrollToBottomPasses = 0;
                return GLib.SOURCE_REMOVE;
            }

            const adjustment = this._scroller.get_vadjustment();
            adjustment.set_value(this._getScrollToBottomValue());
            this._scrollToBottomPasses = Math.max(0, this._scrollToBottomPasses - 1);
            this._syncScrollToBottomButton();

            if (this._scrollToBottomPasses > 0)
                this._queueScrollToBottomPass();

            return GLib.SOURCE_REMOVE;
        });
    }

    _scrollToBottom(options = {}) {
        if (!this._scroller)
            return;

        if (options.animate && !this._followLatestMessage) {
            this._animateScrollToBottom();
            return;
        }

        this._stopScrollToBottomAnimation();
        const passes = Math.max(1, Math.round(options.passes ?? (this._followLatestMessage ? 3 : 1)));
        this._scrollToBottomPasses = Math.max(this._scrollToBottomPasses, passes);
        this._queueScrollToBottomPass();
    }

    _syncScrollToBottomButton() {
        if (!this._scrollToBottomButton || !this._scroller)
            return;

        const adjustment = this._scroller.get_vadjustment();
        const pageSize = adjustment.get_page_size();
        const maxValue = Math.max(0, adjustment.get_upper() - pageSize);
        const distanceToBottom = Math.max(0, maxValue - adjustment.get_value());
        const shouldShow = !this._followLatestMessage && pageSize > 0 && distanceToBottom > pageSize;

        this._scrollToBottomButton.set_visible(shouldShow);
    }
});
