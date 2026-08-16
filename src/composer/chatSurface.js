import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { drawContextUsageChart } from '../chat/composerUsage.js';
import { normalizeComposerReferences } from './presentation.js';
import { ModelPicker } from '../providers/modelPicker.js';
import { createBundledIcon } from '../bundledIcons.js';

const ATTACHMENT_ICON_FILE = 'attachment-symbolic.svg';
const EMPTY_STATE_FRAME_WIDTH_RATIO = 1 / 3;
const EMPTY_STATE_FRAME_ASPECT_RATIO = 176 / 236;
const EMPTY_STATE_VERTICAL_RATIO = 0.618;
const PENDING_MESSAGE_COMPOSER_OVERLAP = 14;

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
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

function waitForUiPresentation() {
    return new Promise((resolve) => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export class ChatSurfaceBuilder {
    constructor({
        appSettings,
        conversations,
        composerDraftsByConversation,
        getState,
        setState,
        activeQuestionSessionForConversation,
        appendSystemError,
        attachFileContext,
        consumePendingAttachments,
        createChatOptionsMenuButton,
        createComposerSuggestionPanel,
        createComposerUsagePopover,
        createConversationView,
        createEmptyConversationState,
        createPendingUserMessagesRow,
        createPromptMenuButton,
        createProviderConfigButton,
        createProviderPicker,
        deleteComposerReferenceAtCursor,
        enqueuePendingUserMessageWithHooks,
        getComposerReferences,
        getComposerText,
        handleComposerHistoryKey,
        handleComposerReadlineKey,
        handleComposerSuggestionKey,
        handleModelChanged,
        handleProviderChanged,
        handleThinkingLevelChanged,
        isConversationBusy,
        pasteClipboardContentIfAvailable,
        populateProviderPicker,
        scheduleComposerSuggestionRefresh,
        scheduleComposerUsageChartSync,
        scrollToBottom,
        sendMessage,
        setComposerText,
        showToast,
        submitAgentQuestionAnswer,
        syncComposerHint,
        syncComposerPlaceholder,
        syncComposerReferenceTagStyles,
        syncComposerReferenceTags,
        syncComposerUsageChart,
        syncScrollToBottomButton,
        syncUserMessageReferenceStyles,
    }) {
        this._appSettings = appSettings;
        this._conversations = conversations;
        this._composerDraftsByConversation = composerDraftsByConversation;
        this._activeQuestionSessionForConversation = activeQuestionSessionForConversation;
        this._appendSystemError = appendSystemError;
        this._attachFileContext = attachFileContext;
        this._consumePendingAttachments = consumePendingAttachments;
        this._createChatOptionsMenuButton = createChatOptionsMenuButton;
        this._createComposerSuggestionPanel = createComposerSuggestionPanel;
        this._createComposerUsagePopover = createComposerUsagePopover;
        this._createConversationView = createConversationView;
        this._createEmptyConversationState = createEmptyConversationState;
        this._createPendingUserMessagesRow = createPendingUserMessagesRow;
        this._createPromptMenuButton = createPromptMenuButton;
        this._createProviderConfigButton = createProviderConfigButton;
        this._createProviderPicker = createProviderPicker;
        this._deleteComposerReferenceAtCursor = deleteComposerReferenceAtCursor;
        this._enqueuePendingUserMessageWithHooks = enqueuePendingUserMessageWithHooks;
        this._getComposerReferences = getComposerReferences;
        this._getComposerText = getComposerText;
        this._handleComposerHistoryKey = handleComposerHistoryKey;
        this._handleComposerReadlineKey = handleComposerReadlineKey;
        this._handleComposerSuggestionKey = handleComposerSuggestionKey;
        this._handleModelChanged = handleModelChanged;
        this._handleProviderChanged = handleProviderChanged;
        this._handleThinkingLevelChanged = handleThinkingLevelChanged;
        this._isConversationBusy = isConversationBusy;
        this._pasteClipboardContentIfAvailable = pasteClipboardContentIfAvailable;
        this._populateProviderPicker = populateProviderPicker;
        this._scheduleComposerSuggestionRefresh = scheduleComposerSuggestionRefresh;
        this._scheduleComposerUsageChartSync = scheduleComposerUsageChartSync;
        this._scrollToBottom = scrollToBottom;
        this._sendMessage = sendMessage;
        this._setComposerText = setComposerText;
        this._showToast = showToast;
        this._submitAgentQuestionAnswer = submitAgentQuestionAnswer;
        this._syncComposerHint = syncComposerHint;
        this._syncComposerPlaceholder = syncComposerPlaceholder;
        this._syncComposerReferenceTagStyles = syncComposerReferenceTagStyles;
        this._syncComposerReferenceTags = syncComposerReferenceTags;
        this._syncComposerUsageChart = syncComposerUsageChart;
        this._syncScrollToBottomButton = syncScrollToBottomButton;
        this._syncUserMessageReferenceStyles = syncUserMessageReferenceStyles;

        for (const name of [
            '_agentQuestionHeader',
            '_agentQuestionOptions',
            '_agentQuestionPanel',
            '_agentQuestionProgress',
            '_agentQuestionPrompt',
            '_attachButton',
            '_attachmentPreviewList',
            '_attachmentPreviewScroller',
            '_attachmentRow',
            '_chatOptionsMenuButton',
            '_composer',
            '_composerBuffer',
            '_composerDeckSizeGroup',
            '_composerHint',
            '_composerInlineControls',
            '_composerMetaRow',
            '_composerPlaceholder',
            '_composerReferenceTags',
            '_composerReferences',
            '_composerScroller',
            '_composerStyleManagerSignalId',
            '_composerUsageChart',
            '_composerUsageFraction',
            '_composerUsagePopover',
            '_conversationLoadingView',
            '_conversationStack',
            '_emptyConversationState',
            '_initialConversationView',
            '_messageBottomSpacer',
            '_messages',
            '_modelPicker',
            '_pendingAttachments',
            '_pendingUserMessagesRow',
            '_promptMenuButton',
            '_providerConfigButton',
            '_providerPicker',
            '_scrollController',
            '_scrollToBottomButton',
            '_scroller',
            '_thinkingLevelPicker',
        ]) {
            Object.defineProperty(this, name, {
                configurable: true,
                get: () => getState(name),
                set: (value) => setState(name, value),
            });
        }
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
        this._composerMetaRow = composerMetaRow;
        const composerMetaSpacer = new Gtk.Box({
            hexpand: true,
        });

        this._agentQuestionPanel = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
            visible: false,
        });
        this._agentQuestionPanel.add_css_class('cusco-agent-question-panel');
        const agentQuestionHeading = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            hexpand: true,
        });
        this._agentQuestionHeader = new Gtk.Label({
            label: 'Question',
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        });
        this._agentQuestionHeader.add_css_class('caption');
        this._agentQuestionHeader.add_css_class('dim-label');
        this._agentQuestionProgress = new Gtk.Label({
            xalign: 1,
        });
        this._agentQuestionProgress.add_css_class('caption');
        this._agentQuestionProgress.add_css_class('dim-label');
        this._agentQuestionPrompt = new Gtk.Label({
            xalign: 0,
            hexpand: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
        });
        this._agentQuestionPrompt.add_css_class('cusco-agent-question-prompt');
        this._agentQuestionOptions = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            column_spacing: 6,
            row_spacing: 6,
            homogeneous: true,
            max_children_per_line: 2,
            min_children_per_line: 1,
            hexpand: true,
        });
        this._agentQuestionOptions.add_css_class('cusco-agent-question-options');
        agentQuestionHeading.append(this._agentQuestionHeader);
        agentQuestionHeading.append(this._agentQuestionProgress);
        this._agentQuestionPanel.append(agentQuestionHeading);
        this._agentQuestionPanel.append(this._agentQuestionPrompt);
        this._agentQuestionPanel.append(this._agentQuestionOptions);

        this._providerPicker = this._createProviderPicker();
        this._providerConfigButton = this._createProviderConfigButton();
        this._modelPicker = new ModelPicker();
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

        const initialConversationView = this._createConversationView();
        this._messages = initialConversationView.messages;
        this._messageBottomSpacer = initialConversationView.bottomSpacer;
        this._initialConversationView = initialConversationView;

        this._conversationStack = new Gtk.Stack({
            hexpand: true,
            vexpand: true,
            hhomogeneous: false,
            vhomogeneous: false,
        });
        this._conversationStack.add_child(this._messages);

        this._conversationLoadingView = new Gtk.Box({
            hexpand: true,
            vexpand: true,
        });
        this._conversationStack.add_child(this._conversationLoadingView);
        this._conversationStack.set_visible_child(this._messages);

        this._scroller = new Gtk.ScrolledWindow({
            child: this._conversationStack,
            hexpand: true,
            vexpand: true,
        });
        this._scroller.get_vadjustment().connect('changed', () => {
            if (this._scrollController.followLatest)
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
        this._attachmentRow.append(this._attachmentPreviewScroller);
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

        for (const kind of ['skill', 'file', 'command', 'artifact']) {
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
            () => {
                this._syncComposerReferenceTagStyles();
                this._syncUserMessageReferenceStyles();
            },
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
        this._composer.connect('paste-clipboard', () => {
            if (!this._pasteClipboardContentIfAvailable())
                return;

            GObject.signal_stop_emission_by_name(this._composer, 'paste-clipboard');
        });

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
        this._composerInlineControls = composerInlineControls;

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
            const conversationId = this._conversations.activeConversation?.id ?? null;
            const questionSession = this._activeQuestionSessionForConversation(conversationId);

            if (questionSession) {
                if (text)
                    this._submitAgentQuestionAnswer(text);
                return;
            }

            const references = this._getComposerReferences();
            const hasAttachments = this._pendingAttachments.length > 0;

            if (!text && !hasAttachments)
                return;

            if (this._isConversationBusy(conversationId)) {
                if (text) {
                    const restoreQueuedText = () => {
                        if (this._conversations.activeConversation?.id !== conversationId) {
                            const draft = this._composerDraftsByConversation.get(conversationId) ?? {};

                            if (!String(draft.text ?? '').trim()) {
                                this._composerDraftsByConversation.set(conversationId, {
                                    ...draft,
                                    text,
                                    references: normalizeComposerReferences(references),
                                });
                            }
                            return;
                        }

                        if (this._getComposerText().trim())
                            return;

                        this._composerReferences = normalizeComposerReferences(references);
                        this._setComposerText(text, { preserveReferences: true });
                    };

                    this._setComposerText('');
                    this._composerDraftsByConversation.delete(conversationId);
                    waitForUiPresentation()
                        .then(() => this._enqueuePendingUserMessageWithHooks(
                            text,
                            references,
                            conversationId,
                        ))
                        .then((message) => {
                            if (!message)
                                restoreQueuedText();
                        })
                        .catch((error) => {
                            restoreQueuedText();
                            logError(error, 'Failed to run queued prompt hooks');
                            this._showToast('The queued message could not be checked by hooks.');
                        });
                } else if (hasAttachments) {
                    this._showToast('Attachments can be sent after the current response finishes.');
                }
                return;
            }

            const pendingAttachments = this._consumePendingAttachments();
            this._setComposerText('');
            this._composerDraftsByConversation.delete(conversationId);
            this._sendMessage(text, references, pendingAttachments).catch((error) => {
                logError(error, 'Failed to stream provider response');
                this._appendSystemError(getProviderErrorMessage(error), conversationId);
            });
        };

        const composerKeyController = new Gtk.EventControllerKey();
        composerKeyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (this._handleComposerSuggestionKey(keyval))
                return true;

            if (this._handleComposerHistoryKey(keyval, state))
                return true;

            if (this._deleteComposerReferenceAtCursor(keyval))
                return true;

            if (this._handleComposerReadlineKey(keyval, state))
                return true;

            const isEnter = keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter;
            const shiftPressed = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
            const controlPressed = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;

            if (isEnter
                && !shiftPressed
                && (this._activeQuestionSessionForConversation(
                    this._conversations.activeConversation?.id,
                ) || this._appSettings.sendWithEnter || controlPressed)) {
                sendMessage();
                return true;
            }

            return false;
        });
        this._composer.add_controller(composerKeyController);
        this._composerBuffer.connect('changed', () => {
            this._syncComposerPlaceholder();
            this._scheduleComposerUsageChartSync();
            this._syncComposerHint();
            this._syncComposerReferenceTags();
            this._scheduleComposerSuggestionRefresh();
        });
        this._composerBuffer.connect('mark-set', (_buffer, _location, mark) => {
            if (mark.get_name() === 'insert')
                this._scheduleComposerSuggestionRefresh();
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
        composerShell.append(this._agentQuestionPanel);
        composerShell.append(this._attachmentRow);
        composerShell.append(composerDeck);

        main.set_child(this._scroller);
        main.add_overlay(this._emptyConversationState);
        main.add_overlay(composerShell);

        return main;
    }

}
