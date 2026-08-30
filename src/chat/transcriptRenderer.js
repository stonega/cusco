import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { normalizeConversationMessageStartIndex } from './presentation.js';

const CONVERSATION_RENDER_BATCH_BUDGET_US = 8000;
const CONVERSATION_MESSAGE_PAGE_SIZE = 32;
const MAX_CACHED_CONVERSATION_VIEWS = 4;

export class TranscriptRenderer {
    constructor({
        appSettings,
        conversations,
        viewCache = new Map(),
        messageStartIndexes = new Map(),
        renderedConversationId = null,
        getConversationStack,
        getCurrentViewState,
        setCurrentViewState,
        takeInitialConversationView,
        prepareConversation,
        renderPendingUserMessages,
        syncEmptyConversationState,
        showConversationLoadingState,
        isActiveConversationId,
        isConversationBusy,
        setComposerBusy,
        setFollowLatestMessage,
        addMessage,
        updateUsageDisplay,
        scrollToBottom,
        onStateChanged = () => {},
    }) {
        this._appSettings = appSettings;
        this._conversations = conversations;
        this.viewCache = viewCache;
        this.messageStartIndexes = messageStartIndexes;
        this.renderedConversationId = renderedConversationId;
        this._getConversationStack = getConversationStack;
        this._getCurrentViewState = getCurrentViewState;
        this._setCurrentViewState = setCurrentViewState;
        this._takeInitialConversationView = takeInitialConversationView;
        this._prepareConversation = prepareConversation;
        this._renderPendingUserMessages = renderPendingUserMessages;
        this._syncEmptyConversationState = syncEmptyConversationState;
        this._showConversationLoadingState = showConversationLoadingState;
        this._isActiveConversationId = isActiveConversationId;
        this._isConversationBusy = isConversationBusy;
        this._setComposerBusy = setComposerBusy;
        this._setFollowLatestMessage = setFollowLatestMessage;
        this._addMessage = addMessage;
        this._updateUsageDisplay = updateUsageDisplay;
        this._scrollToBottom = scrollToBottom;
        this._onStateChanged = onStateChanged;
        this._renderSourceId = 0;
        this._pendingView = null;
        this.isBatchRendering = false;
    }

    createConversationView() {
        const messages = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 8,
            margin_start: 26,
            margin_end: 26,
        });
        const bottomSpacer = new Gtk.Box();

        bottomSpacer.set_size_request(-1, 260);
        bottomSpacer.add_css_class('cusco-message-bottom-spacer');
        messages.append(bottomSpacer);

        return {
            messages,
            bottomSpacer,
            conversationId: null,
            fingerprint: '',
            lastAssistantMessageView: null,
            pendingAssistantActivityEntries: [],
            referenceContents: new Set(),
        };
    }

    conversationViewFingerprint(conversation) {
        if (!conversation)
            return '';

        return [
            conversation.updatedAt ?? '',
            conversation.messageCount ?? conversation.messages?.length ?? 0,
            this._appSettings.codeTheme,
            Adw.StyleManager.get_default().get_dark() ? 'dark' : 'light',
        ].join('\u0000');
    }

    normalizeMessageStartIndex(conversation, requestedStartIndex) {
        return normalizeConversationMessageStartIndex(
            conversation?.messages,
            requestedStartIndex,
        );
    }

    messageStartIndex(conversation) {
        if (!conversation?.id)
            return 0;

        const defaultStartIndex = Math.max(
            0,
            conversation.messages.length - CONVERSATION_MESSAGE_PAGE_SIZE,
        );
        const storedStartIndex = this.messageStartIndexes.get(conversation.id);
        const requestedStartIndex = Number.isFinite(storedStartIndex)
            && storedStartIndex < conversation.messages.length
            ? storedStartIndex
            : defaultStartIndex;

        return this.normalizeMessageStartIndex(conversation, requestedStartIndex);
    }

    createLoadEarlierMessagesRow(conversation, startIndex) {
        const button = new Gtk.Button({
            label: `Show ${startIndex} earlier message${startIndex === 1 ? '' : 's'}`,
            halign: Gtk.Align.CENTER,
            margin_top: 8,
            margin_bottom: 4,
        });

        button.add_css_class('flat');
        button.connect('clicked', () => {
            if (!this._isActiveConversationId(conversation.id))
                return;

            const nextStartIndex = this.normalizeMessageStartIndex(
                conversation,
                Math.max(0, startIndex - CONVERSATION_MESSAGE_PAGE_SIZE),
            );

            this.messageStartIndexes.set(conversation.id, nextStartIndex);
            this._showConversationLoadingState();
            this.renderActiveConversation({
                forceRebuild: true,
                incremental: true,
            });
        });
        return button;
    }

    getCachedConversationView(conversation) {
        if (!conversation?.id)
            return null;

        const entry = this.viewCache.get(conversation.id);
        return entry && (
            entry.fingerprint === this.conversationViewFingerprint(conversation)
            || this._isConversationBusy(conversation.id)
        )
            ? entry
            : null;
    }

    captureCurrentConversationView() {
        const current = this._getCurrentViewState();
        const entry = this.viewCache.get(this.renderedConversationId);

        if (!entry || entry.messages !== current.messages)
            return;

        entry.lastAssistantMessageView = current.lastAssistantMessageView;
        entry.pendingAssistantActivityEntries = current.pendingAssistantActivityEntries;
        entry.referenceContents = current.referenceContents;
    }

    finalizeCurrentConversationView(conversation) {
        if (!conversation?.id || conversation.id !== this.renderedConversationId)
            return false;

        const current = this._getCurrentViewState();
        const entry = this.viewCache.get(conversation.id);

        if (!entry || entry.messages !== current.messages)
            return false;

        this.captureCurrentConversationView();
        entry.fingerprint = this.conversationViewFingerprint(conversation);
        this.touchConversationView(entry);
        this._syncEmptyConversationState(conversation);
        this._updateUsageDisplay(conversation);
        this._scrollToBottom();
        return true;
    }

    activateConversationView(entry, { reveal = true } = {}) {
        this._setCurrentViewState({
            messages: entry.messages,
            bottomSpacer: entry.bottomSpacer,
            lastAssistantMessageView: entry.lastAssistantMessageView,
            pendingAssistantActivityEntries: entry.pendingAssistantActivityEntries ?? [],
            referenceContents: entry.referenceContents,
        });
        this.renderedConversationId = entry.conversationId;
        this._notifyStateChanged();

        if (reveal)
            this._getConversationStack().set_visible_child(entry.messages);
    }

    touchConversationView(entry) {
        this.viewCache.delete(entry.conversationId);
        this.viewCache.set(entry.conversationId, entry);
    }

    removeConversationView(entry) {
        if (!entry || entry.messages === this._getCurrentViewState().messages)
            return;

        const stack = this._getConversationStack();
        if (entry.messages.get_parent() === stack)
            stack.remove(entry.messages);
    }

    trimConversationViewCache() {
        let attemptsRemaining = this.viewCache.size;

        while (this.viewCache.size > MAX_CACHED_CONVERSATION_VIEWS
            && attemptsRemaining > 0) {
            const oldest = this.viewCache.entries().next().value;

            if (!oldest)
                return;

            const [conversationId, entry] = oldest;

            if (conversationId === this.renderedConversationId
                || this._isConversationBusy(conversationId)) {
                this.touchConversationView(entry);
                attemptsRemaining -= 1;
                continue;
            }

            this.viewCache.delete(conversationId);
            this.removeConversationView(entry);
        }
    }

    cancelScheduledConversationRender() {
        if (this._renderSourceId) {
            GLib.source_remove(this._renderSourceId);
            this._renderSourceId = 0;
        }

        const stack = this._getConversationStack();
        if (this._pendingView?.messages.get_parent() === stack)
            stack.remove(this._pendingView.messages);

        this._pendingView = null;
        this.isBatchRendering = false;
        this._notifyStateChanged();
    }

    scheduleActiveConversationRender(conversation) {
        this.cancelScheduledConversationRender();
        this._showConversationLoadingState();
        const conversationId = conversation?.id ?? null;

        this._renderSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._renderSourceId = 0;

            if ((this._conversations.activeConversation?.id ?? null) === conversationId)
                this.renderActiveConversation({ incremental: true });

            return GLib.SOURCE_REMOVE;
        });
    }

    finishConversationViewRender(conversation, entry, staleEntry) {
        const current = this._getCurrentViewState();
        entry.lastAssistantMessageView = current.lastAssistantMessageView;
        entry.pendingAssistantActivityEntries = current.pendingAssistantActivityEntries;
        entry.referenceContents = current.referenceContents;

        if (conversation?.id) {
            this.viewCache.set(conversation.id, entry);
            this.touchConversationView(entry);
        }

        this._getConversationStack().set_visible_child(entry.messages);
        this._syncEmptyConversationState(conversation);

        if (staleEntry && staleEntry !== entry)
            this.removeConversationView(staleEntry);

        this.trimConversationViewCache();
        this._updateUsageDisplay(conversation);
        this._scrollToBottom();
    }

    renderConversationMessagesIncrementally(conversation, entry, staleEntry, messages) {
        const conversationId = conversation?.id ?? null;
        let messageIndex = 0;

        this._pendingView = entry;
        this.isBatchRendering = true;
        this._notifyStateChanged();

        const renderBatch = () => {
            this._renderSourceId = 0;

            if ((this._conversations.activeConversation?.id ?? null) !== conversationId) {
                this.cancelScheduledConversationRender();
                return GLib.SOURCE_REMOVE;
            }

            const startedAt = GLib.get_monotonic_time();

            do {
                const message = messages[messageIndex];
                this._addMessage(message.content, message.role, message);
                messageIndex += 1;
            } while (messageIndex < messages.length
                && GLib.get_monotonic_time() - startedAt < CONVERSATION_RENDER_BATCH_BUDGET_US);

            if (messageIndex < messages.length) {
                this._renderSourceId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, renderBatch);
                return GLib.SOURCE_REMOVE;
            }

            this._pendingView = null;
            this.isBatchRendering = false;
            this._notifyStateChanged();
            this.finishConversationViewRender(conversation, entry, staleEntry);
            return GLib.SOURCE_REMOVE;
        };

        if (messages.length === 0) {
            this._pendingView = null;
            this.isBatchRendering = false;
            this._notifyStateChanged();
            this.finishConversationViewRender(conversation, entry, staleEntry);
            return;
        }

        this._renderSourceId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, renderBatch);
    }

    renderActiveConversation(options = {}) {
        const conversation = this._conversations.activeConversation;

        if ((conversation?.id ?? null) !== this.renderedConversationId)
            this._setFollowLatestMessage(false);

        this._prepareConversation(conversation);
        this._setComposerBusy(this._isConversationBusy(conversation?.id));

        if (options.finalizeCurrentView && this.finalizeCurrentConversationView(conversation))
            return;

        const cachedEntry = options.forceRebuild
            ? null
            : this.getCachedConversationView(conversation);

        if (options.deferIfUncached && conversation && !cachedEntry) {
            this.scheduleActiveConversationRender(conversation);
            return;
        }

        this.cancelScheduledConversationRender();
        this.captureCurrentConversationView();
        this._renderPendingUserMessages(conversation);

        if (cachedEntry) {
            this._syncEmptyConversationState(conversation);
            this.touchConversationView(cachedEntry);
            this.activateConversationView(cachedEntry);
            this._updateUsageDisplay(conversation);
            this._scrollToBottom();
            return;
        }

        if (options.incremental)
            this._showConversationLoadingState();
        else
            this._syncEmptyConversationState(conversation);

        const staleEntry = conversation?.id
            ? this.viewCache.get(conversation.id)
            : null;
        let entry = this._takeInitialConversationView();

        if (!entry) {
            entry = this.createConversationView();
            this._getConversationStack().add_child(entry.messages);
        }

        entry.conversationId = conversation?.id ?? null;
        entry.fingerprint = this.conversationViewFingerprint(conversation);
        entry.lastAssistantMessageView = null;
        entry.pendingAssistantActivityEntries = [];
        entry.referenceContents = new Set();
        this.activateConversationView(entry, { reveal: false });
        const messageStartIndex = this.messageStartIndex(conversation);
        const messagesToRender = (conversation?.messages ?? []).slice(messageStartIndex);

        if (messageStartIndex > 0)
            entry.messages.prepend(this.createLoadEarlierMessagesRow(conversation, messageStartIndex));

        if (options.incremental) {
            this.renderConversationMessagesIncrementally(
                conversation,
                entry,
                staleEntry,
                messagesToRender,
            );
            return;
        }

        for (const message of messagesToRender)
            this._addMessage(message.content, message.role, message);

        this.finishConversationViewRender(conversation, entry, staleEntry);
    }

    _notifyStateChanged() {
        this._onStateChanged({
            isBatchRendering: this.isBatchRendering,
            renderedConversationId: this.renderedConversationId,
            renderSourceId: this._renderSourceId,
        });
    }
}
