import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { AgentActivityPresenter } from './agentActivityPresenter.js';
import { EmptyConversationPresenter } from './emptyConversationPresenter.js';
import { hideBinaryAttachmentData } from './attachments.js';
import { messageRunDurationLabel } from './presentation.js';
import {
    copyTextToClipboard,
    createMessageContent,
} from './messageView.js';
import { AnimatedMessageActions } from './streamAnimation.js';
import {
    isWelcomeMessage,
    welcomeStreamFrame,
} from './welcome.js';
import {
    displayBodyWithoutImageAttachmentLines,
    isImageAttachment,
} from '../composer/attachmentPresentation.js';
import { normalizeComposerReferences } from '../composer/presentation.js';
import { createBundledIcon } from '../bundledIcons.js';
import {
    attachAssistantActivityToAssistant,
    queueAssistantReasoningMessage,
    toolCallBelongsToFollowingAssistant,
} from '../tools/display.js';

const GIT_BRANCH_ICON_FILE = 'git-branch-symbolic.svg';
const WELCOME_STREAM_INTERVAL_MS = 24;
const WELCOME_STREAM_CHARACTERS_PER_TICK = 4;

function getMessageReasoningContent(message) {
    if (typeof message?.reasoning === 'string')
        return message.reasoning.trim();

    return String(message?.reasoning?.content ?? '').trim();
}

function isAgentReasoningMessage(message) {
    return Boolean(message?.reasoning?.agentMode && getMessageReasoningContent(message));
}

export function createMessageWrapper(kind) {
    const isAssistant = kind === 'assistant';
    const halign = isAssistant
        ? Gtk.Align.FILL
        : kind === 'user'
            ? Gtk.Align.END
            : Gtk.Align.START;
    const wrapper = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_top: 4,
        margin_bottom: 4,
        hexpand: isAssistant,
        halign,
    });

    return wrapper;
}

export class MessagePresenter {
    constructor({
        appSettings,
        artifacts,
        artifactRenderers,
        conversations,
        getParentWindow,
        getState,
        setState,
        appendMessageWidget,
        clearBox,
        composerReferenceStyles,
        confirmOpenArtifactLink,
        createAttachmentPreviewCard,
        editMessage,
        exportArtifact,
        openArtifactWorkspace,
        openImageViewer,
        regenerateFromMessage,
        retryFromMessage,
        branchFromMessage,
        scrollToBottom,
        showToast,
        streamPresentationPreferences,
    }) {
        this._appSettings = appSettings;
        this._artifacts = artifacts;
        this._artifactRenderers = artifactRenderers;
        this._conversations = conversations;
        this._getParentWindow = getParentWindow;
        this._appendMessageWidget = appendMessageWidget;
        this._clearBox = clearBox;
        this._composerReferenceStyles = composerReferenceStyles;
        this._confirmOpenArtifactLink = confirmOpenArtifactLink;
        this._createAttachmentPreviewCard = createAttachmentPreviewCard;
        this._editMessage = editMessage;
        this._exportArtifact = exportArtifact;
        this._openArtifactWorkspace = openArtifactWorkspace;
        this._openImageViewer = openImageViewer;
        this._regenerateFromMessage = regenerateFromMessage;
        this._retryFromMessage = retryFromMessage;
        this._branchFromMessage = branchFromMessage;
        this._scrollToBottom = scrollToBottom;
        this._showToast = showToast;
        this._streamPresentationPreferences = streamPresentationPreferences;
        this._emptyConversationPresenter = new EmptyConversationPresenter({
            appSettings,
            getState,
            setState,
        });
        this._agentActivityPresenter = new AgentActivityPresenter({
            appSettings,
            getParentWindow,
            clearBox,
            messageContentOptions: (options) => this._messageContentOptions(options),
        });

        for (const name of [
            '_animatedWelcomeMessageIds',
            '_conversationLoadingView',
            '_conversationStack',
            '_emptyConversationFadeTimeoutId',
            '_emptyConversationPicture',
            '_emptyConversationState',
            '_emptyConversationThemeHandlerId',
            '_lastAssistantMessageView',
            '_pendingAssistantActivityEntries',
            '_userMessageReferenceContents',
            '_welcomeStreamSourceIds',
        ]) {
            Object.defineProperty(this, name, {
                configurable: true,
                get: () => getState(name),
                set: (value) => setState(name, value),
            });
        }
    }

    _messageContentOptions(options = {}) {
        return {
            codeTheme: this._appSettings.codeTheme,
            artifactManager: this._artifacts,
            artifactRegistry: this._artifactRenderers,
            onOpenArtifact: (reference) => this._openArtifactWorkspace(reference),
            onExportArtifact: (reference) => this._exportArtifact(reference),
            onOpenImage: (image) => this._openImageViewer(image),
            onExternalLink: (uri) => this._confirmOpenArtifactLink(uri),
            onArtifactTerminated: () => this._showToast('The artifact preview stopped unexpectedly.'),
            ...this._streamPresentationPreferences(),
            onStreamFrame: () => this._scrollToBottom(),
            ...options,
        };
    }

    _createEmptyConversationState() {
        return this._emptyConversationPresenter._createEmptyConversationState();
    }

    _syncEmptyConversationState(conversation = this._conversations.activeConversation) {
        return this._emptyConversationPresenter._syncEmptyConversationState(conversation);
    }

    _showConversationLoadingState() {
        return this._emptyConversationPresenter._showConversationLoadingState();
    }

    _showEmptyConversationState() {
        return this._emptyConversationPresenter._showEmptyConversationState();
    }

    _hideEmptyConversationState() {
        return this._emptyConversationPresenter._hideEmptyConversationState();
    }

    _updateEmptyConversationImage() {
        return this._emptyConversationPresenter._updateEmptyConversationImage();
    }

    _createKnotIcon(options = {}) {
        return this._agentActivityPresenter._createKnotIcon(options);
    }

    _createTextShimmerController(label) {
        return this._agentActivityPresenter._createTextShimmerController(label);
    }

    _createAgentWorkingRow(startedAt = GLib.get_monotonic_time()) {
        return this._agentActivityPresenter._createAgentWorkingRow(startedAt);
    }

    _createAgentCompletedRow(label) {
        return this._agentActivityPresenter._createAgentCompletedRow(label);
    }

    _createKnotStatusRow(text = '', options = {}) {
        return this._agentActivityPresenter._createKnotStatusRow(text, options);
    }

    _createThinkingLabelWidget(isActive) {
        return this._agentActivityPresenter._createThinkingLabelWidget(isActive);
    }

    _createReasoningExpander(contentOrFactory, options = {}) {
        return this._agentActivityPresenter._createReasoningExpander(contentOrFactory, options);
    }

    _createAgentReasoningSegment(message, options = {}) {
        return this._agentActivityPresenter._createAgentReasoningSegment(message, options);
    }

    _createBashOutputPreview(initialOutput = '') {
        return this._agentActivityPresenter._createBashOutputPreview(initialOutput);
    }

    _createToolArtifactPreviews() {
        return this._agentActivityPresenter._createToolArtifactPreviews();
    }

    _createToolResultExpander(message, options = {}) {
        return this._agentActivityPresenter._createToolResultExpander(message, options);
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

    _shouldAnimateWelcomeMessage(message) {
        if (!isWelcomeMessage(message)
            || !message?.id
            || this._animatedWelcomeMessageIds.has(message.id)) {
            return false;
        }

        const settings = Gtk.Settings.get_default();

        try {
            return settings?.get_property('gtk-enable-animations') !== false;
        } catch (_error) {
            return true;
        }
    }

    _startWelcomeMessageStream(messageView, content) {
        const characterCount = [...String(content ?? '')].length;

        if (characterCount === 0)
            return;

        let visibleCharacters = 0;
        let sourceId = 0;
        const revealNextFrame = () => {
            visibleCharacters = Math.min(
                characterCount,
                visibleCharacters + WELCOME_STREAM_CHARACTERS_PER_TICK,
            );
            messageView.set_label(welcomeStreamFrame(content, visibleCharacters));

            if (visibleCharacters < characterCount)
                return GLib.SOURCE_CONTINUE;

            messageView.finish_stream?.();
            this._welcomeStreamSourceIds.delete(sourceId);
            return GLib.SOURCE_REMOVE;
        };

        revealNextFrame();

        if (visibleCharacters >= characterCount)
            return;

        sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            WELCOME_STREAM_INTERVAL_MS,
            revealNextFrame,
        );
        this._welcomeStreamSourceIds.add(sourceId);
    }

    _addMessage(body, kind, message = null, options = {}) {
        if (isAgentReasoningMessage(message)) {
            const reasoningView = this._lastAssistantMessageView?.append_reasoning_segment
                ? this._lastAssistantMessageView.append_reasoning_segment(message, {
                    loading: options.reasoningLoading === true,
                })
                : queueAssistantReasoningMessage(this._pendingAssistantActivityEntries, message);
            this._scrollToBottom();
            return reasoningView ?? { set_label: () => {} };
        }

        if (message?.toolCall?.agentMode && this._lastAssistantMessageView?.append_tool_result) {
            const toolView = this._lastAssistantMessageView.append_tool_result(message);
            this._scrollToBottom();
            return toolView ?? { set_label: () => {} };
        }

        if (message?.toolCall) {
            const toolView = this._addToolMessage(message);

            if (toolCallBelongsToFollowingAssistant(message.toolCall) || message.toolCall.agentMode) {
                this._pendingAssistantActivityEntries.push({
                    kind: 'tool',
                    message,
                    view: toolView,
                });
            }

            return toolView;
        }

        const wrapper = createMessageWrapper(kind);
        const reasoningText = kind === 'assistant'
            ? getMessageReasoningContent(message)
            : '';
        const completedRunDuration = kind === 'assistant'
            ? messageRunDurationLabel(message)
            : '';
        const isStreamingAssistant = kind === 'assistant' && !message;
        let actionStreamPreferences = isStreamingAssistant
            ? this._streamPresentationPreferences()
            : {};
        let reasoningContent = null;
        let reasoningExpander = null;
        let reasoningBodyText = reasoningText || ' ';

        if (kind === 'assistant' && (reasoningText || isStreamingAssistant)) {
            const createReasoningContent = () => {
                reasoningContent = createMessageContent(reasoningBodyText, this._messageContentOptions({
                    role: 'assistant',
                    hexpand: true,
                    codeMinWidth: 380,
                    selectable: !isStreamingAssistant,
                    streaming: isStreamingAssistant,
                }));
                reasoningContent.add_css_class('cusco-message-bubble');
                reasoningContent.add_css_class('cusco-message-assistant');
                return reasoningContent;
            };

            reasoningExpander = this._createReasoningExpander(createReasoningContent, {
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
        const displayBody = hideBinaryAttachmentData(
            displayBodyWithoutImageAttachmentLines(body, message),
            message?.attachments,
        );
        const animateWelcomeMessage = this._shouldAnimateWelcomeMessage(message);

        if (animateWelcomeMessage)
            this._animatedWelcomeMessageIds.add(message.id);

        const initialDisplayBody = animateWelcomeMessage ? '' : displayBody;
        const messageReferences = kind === 'user'
            ? normalizeComposerReferences(message?.metadata?.composerReferences)
            : [];
        const bodyContent = createMessageContent(initialDisplayBody || ' ', this._messageContentOptions({
            role: kind,
            artifacts: message?.artifacts ?? [],
            parentWindow: this._getParentWindow(),
            references: messageReferences,
            referenceStyles: this._composerReferenceStyles(),
            selectable: !isStreamingAssistant && !animateWelcomeMessage,
            streaming: isStreamingAssistant,
        }));

        if (messageReferences.length > 0)
            this._userMessageReferenceContents.add(bodyContent);
        let currentBodyText = String(initialDisplayBody ?? '');
        let loadingRow = null;
        let workingRow = null;
        let workingCompletionLabel = '';
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
            bodyContent.updateContent(nextText, {
                defer: isStreamingAssistant || animateWelcomeMessage,
            });
        };
        const startWorking = (startedAt) => {
            if (!isStreamingAssistant || workingRow)
                return;

            workingRow = workingCompletionLabel
                ? this._createAgentCompletedRow(workingCompletionLabel)
                : this._createAgentWorkingRow(startedAt);
            bubble.append(workingRow);
        };
        const setRunDuration = (durationMilliseconds) => {
            const nextLabel = messageRunDurationLabel({
                metadata: { agentRunDurationMs: durationMilliseconds },
            });

            if (!isStreamingAssistant || !nextLabel)
                return;

            workingCompletionLabel = nextLabel;

            if (!workingRow) {
                workingRow = this._createAgentCompletedRow(nextLabel);
                bubble.append(workingRow);
                return;
            }

            workingRow.complete?.(nextLabel);
        };
        const finishWorking = () => {
            if (!workingRow)
                return;

            workingRow.stop?.();

            // Keep the settled footer rooted until the canonical transcript
            // row replaces this streaming view in the same layout position.
            if (workingCompletionLabel)
                return;

            bubble.remove(workingRow);
            workingRow = null;
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
        const appendReasoningSegment = (reasoningMessage, segmentOptions = {}) => {
            hasToolResults = true;

            const reasoningWidget = this._createAgentReasoningSegment(
                reasoningMessage,
                segmentOptions,
            );
            ensureAgentActivityBox().append(reasoningWidget);
            reasoningWidget.startReasoningLoading?.();
            return {
                update_reasoning_message: (nextMessage) => {
                    reasoningWidget.updateReasoningMessage?.(nextMessage);
                },
                finish_reasoning_loading: () => {
                    reasoningWidget.finishReasoningLoading?.();
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

        if (completedRunDuration)
            bubble.append(this._createAgentCompletedRow(completedRunDuration));

        if (currentBodyText || isStreamingAssistant || kind !== 'user')
            wrapper.append(bubble);

        let actions = null;
        const configureActionAnimation = () => {
            actions?.configureStreamAnimation?.({
                style: actionStreamPreferences.streamAnimationStyle,
                motionEnabled: actionStreamPreferences.motionEnabled,
                durationMs: actionStreamPreferences.streamAnimationDurationMs,
            });
        };
        const showActions = (actionMessage) => {
            if (actions || !actionMessage?.id || kind === 'system')
                return;

            actions = this._createMessageActions(actionMessage);
            configureActionAnimation();
            wrapper.append(actions);

            if (isStreamingAssistant)
                actions.startEntranceAnimation?.();

            if (wrapper.get_parent())
                this._scrollToBottom();
        };

        showActions(message);

        this._appendMessageWidget(wrapper);
        this._scrollToBottom();

        let messageView = null;
        messageView = {
            set_label: updateBodyContent,
            set_loading: showLoading,
            set_status: showLoading,
            clear_loading: clearLoading,
            start_working: startWorking,
            set_run_duration: setRunDuration,
            finish_working: finishWorking,
            finish_stream: (finishOptions = {}) => {
                const {
                    onContentRevealed,
                    ...presentationOptions
                } = finishOptions;

                return Promise.all([
                    bodyContent.finishStreaming?.({
                        selectable: true,
                        ...presentationOptions,
                        onContentRevealed,
                    }),
                    reasoningContent?.finishStreaming?.({
                        selectable: true,
                        ...presentationOptions,
                    }),
                    reasoningExpander?.finishPreviewAnimation?.(presentationOptions),
                ]);
            },
            show_actions: showActions,
            set_stream_preferences: (streamOptions) => {
                actionStreamPreferences = {
                    ...actionStreamPreferences,
                    ...streamOptions,
                };
                bodyContent.setStreamPreferences?.(streamOptions);
                reasoningContent?.setStreamPreferences?.(streamOptions);
                reasoningExpander?.setStreamPreferences?.(streamOptions);
                configureActionAnimation();
            },
            set_reasoning: (text) => {
                if (!reasoningExpander)
                    return;

                const nextText = String(text ?? '').trim();
                reasoningBodyText = nextText || ' ';
                reasoningExpander.set_visible(Boolean(nextText));

                if (nextText) {
                    reasoningExpander.updatePreview?.(nextText);
                    if (!isStreamingAssistant) {
                        reasoningContent = reasoningExpander.ensureContent();
                        reasoningContent?.updateContent(reasoningBodyText, { defer: false });
                    }
                }
            },
            append_tool_result: appendToolResult,
            append_reasoning_segment: appendReasoningSegment,
            has_tool_results: () => hasToolResults,
            remove: () => {
                finishWorking();
                const parent = wrapper.get_parent();

                if (typeof parent?.remove === 'function')
                    parent.remove(wrapper);

                if (this._lastAssistantMessageView === messageView)
                    this._lastAssistantMessageView = null;
            },
        };

        if (kind === 'assistant') {
            this._lastAssistantMessageView = messageView;
            attachAssistantActivityToAssistant(
                this._pendingAssistantActivityEntries,
                messageView,
            );
        } else if (!options.preserveLastAssistantMessageView) {
            this._lastAssistantMessageView = null;
        }

        if (animateWelcomeMessage)
            this._startWelcomeMessageStream(messageView, displayBody);

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
            remove: () => {
                const parent = wrapper.get_parent();

                if (typeof parent?.remove === 'function')
                    parent.remove(wrapper);
            },
        };
    }

    _createMessageActions(message) {
        const actions = new AnimatedMessageActions({
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
        } else if (message.role === 'assistant' && !isWelcomeMessage(message)) {
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

}
