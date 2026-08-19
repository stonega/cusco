import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    shouldAutoSendQueuedMessages,
} from './presentation.js';
import { normalizeComposerReferences } from '../composer/presentation.js';
import { createMessage } from '../providers/provider.js';

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isCancellableCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
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

export class TurnSubmission {
    constructor({
        conversations,
        conversationsPendingDeletion,
        composerDraftsByConversation,
        pendingUserMessagesByConversation,
        turns,
        getPendingConversationSendSourceId,
        setPendingConversationSendSourceId,
        getPendingAttachments,
        addMessage,
        addMessageIfActiveConversation,
        appendStoppedMessage,
        appendSystemError,
        applyComposerDraft,
        beginActiveTurn,
        createAttachmentsForComposerReferences,
        createConversationWithDefaults,
        ensureConversationProviderAvailable,
        ensureTurnSessionHooks,
        finishActiveTurn,
        focusComposer,
        formatUserMessageContent,
        getComposerText,
        getPendingUserMessages,
        isActiveConversationId,
        isConversationBusy,
        promptMemoryProposal,
        refreshConversationList,
        renderPendingUserMessages,
        runRequestedTool,
        runUserPromptHooks,
        scrollToBottom,
        streamAssistantResponse,
        syncEmptyConversationState,
        updateAttachmentLabel,
        updateUsageDisplay,
    }) {
        this._conversations = conversations;
        this._conversationsPendingDeletion = conversationsPendingDeletion;
        this._composerDraftsByConversation = composerDraftsByConversation;
        this._pendingUserMessagesByConversation = pendingUserMessagesByConversation;
        this._activeTurnsByConversation = turns;
        this._getPendingConversationSendSourceId = getPendingConversationSendSourceId;
        this._setPendingConversationSendSourceId = setPendingConversationSendSourceId;
        this._getPendingAttachments = getPendingAttachments;
        this._addMessage = addMessage;
        this._addMessageIfActiveConversation = addMessageIfActiveConversation;
        this._appendStoppedMessage = appendStoppedMessage;
        this._appendSystemError = appendSystemError;
        this._applyComposerDraft = applyComposerDraft;
        this._beginActiveTurn = beginActiveTurn;
        this._createAttachmentsForComposerReferences = createAttachmentsForComposerReferences;
        this._createConversationWithDefaults = createConversationWithDefaults;
        this._ensureConversationProviderAvailable = ensureConversationProviderAvailable;
        this._ensureTurnSessionHooks = ensureTurnSessionHooks;
        this._finishActiveTurn = finishActiveTurn;
        this.focusComposer = focusComposer;
        this._formatUserMessageContent = formatUserMessageContent;
        this._getComposerText = getComposerText;
        this._getPendingUserMessages = getPendingUserMessages;
        this._isActiveConversationId = isActiveConversationId;
        this._isConversationBusy = isConversationBusy;
        this._promptMemoryProposal = promptMemoryProposal;
        this._refreshConversationList = refreshConversationList;
        this._renderPendingUserMessages = renderPendingUserMessages;
        this._runRequestedTool = runRequestedTool;
        this._runUserPromptHooks = runUserPromptHooks;
        this._scrollToBottom = scrollToBottom;
        this._streamAssistantResponse = streamAssistantResponse;
        this._syncEmptyConversationState = syncEmptyConversationState;
        this._updateAttachmentLabel = updateAttachmentLabel;
        this._updateUsageDisplay = updateUsageDisplay;

        Object.defineProperty(this, '_pendingConversationSendSourceId', {
            configurable: true,
            get: getPendingConversationSendSourceId,
            set: setPendingConversationSendSourceId,
        });
        Object.defineProperty(this, '_pendingAttachments', {
            configurable: true,
            get: getPendingAttachments,
        });
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
        const runtime = this._activeTurnsByConversation.get(conversationId);

        for (const pendingMessage of pendingMessages) {
            if (runtime && pendingMessage.hookTurnId !== runtime.turnId)
                runtime.hookContexts.push(...(pendingMessage.hookContexts ?? []));

            const references = normalizeComposerReferences(pendingMessage.references);
            const attachments = this._createAttachmentsForComposerReferences(references);
            const userMessage = createMessage(
                'user',
                this._formatUserMessageContent(pendingMessage.content, attachments),
                {
                    attachments,
                    metadata: {
                        composerReferences: references,
                        composerText: pendingMessage.content,
                    },
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

    _handleQueuedUserMessageError(error, conversationId = null) {
        logError(error, 'Failed to send queued user message');
        this._appendSystemError(getProviderErrorMessage(error), conversationId);
    }

    async _preparePendingUserMessageHooks(conversation, cancellable) {
        const pendingMessages = [...this._getPendingUserMessages(conversation.id)];
        const runtime = this._activeTurnsByConversation.get(conversation.id);
        let changed = false;

        if (!runtime)
            return;

        for (const pendingMessage of pendingMessages) {
            if (pendingMessage.hookTurnId)
                continue;

            const hookContextStart = runtime.hookContexts.length;
            const allowed = await this._runUserPromptHooks(
                conversation,
                pendingMessage.content,
                cancellable,
            );

            if (!allowed) {
                const remainingMessages = this._getPendingUserMessages(conversation.id)
                    .filter((message) => message.id !== pendingMessage.id);

                if (remainingMessages.length > 0)
                    this._pendingUserMessagesByConversation.set(conversation.id, remainingMessages);
                else
                    this._pendingUserMessagesByConversation.delete(conversation.id);
                changed = true;
                continue;
            }

            pendingMessage.hookContexts = runtime.hookContexts.slice(hookContextStart);
            pendingMessage.hookTurnId = runtime.turnId;
            changed = true;
        }

        if (changed)
            this._renderPendingUserMessages();
    }

    async _sendQueuedUserMessages(conversationId) {
        if (this._conversationsPendingDeletion?.has(conversationId)
            || this._isConversationBusy(conversationId)
            || this._getPendingUserMessages(conversationId).length === 0) {
            return false;
        }

        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation || !this._ensureConversationProviderAvailable(conversation))
            return false;

        const cancellable = this._beginActiveTurn(conversation.id);

        if (!cancellable)
            return false;

        let sentMessages = false;
        let shouldSendMore = false;
        let presentationFinished = null;

        try {
            await this._preparePendingUserMessageHooks(conversation, cancellable);
            const messages = this._drainPendingUserMessages(conversation.id);

            if (messages.length === 0)
                return false;

            sentMessages = true;

            if (isCancellableCancelled(cancellable))
                return true;

            const responseResult = await this._streamAssistantResponse(conversation.id, {
                cancellable,
                onPresentationSettling: (promise) => {
                    presentationFinished = promise;
                },
            });
            presentationFinished ??= responseResult?.presentationFinished ?? null;
            shouldSendMore = shouldAutoSendQueuedMessages({
                cancelled: isCancellableCancelled(cancellable),
                stoppedBeforeAssistantText: responseResult?.stoppedBeforeAssistantText,
            });
        } finally {
            this._finishActiveTurn(cancellable, {
                deferActiveConversationRender: Boolean(presentationFinished),
            });
        }

        if (shouldSendMore) {
            this._sendQueuedUserMessages(conversation.id).catch((error) => {
                this._handleQueuedUserMessageError(error, conversation.id);
            });
        }

        return sentMessages;
    }

    _schedulePendingConversationSend() {
        if (this._pendingConversationSendSourceId)
            return;

        this._pendingConversationSendSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pendingConversationSendSourceId = 0;

            for (const [conversationId, messages] of this._pendingUserMessagesByConversation) {
                if (messages.length === 0
                    || !this._conversations.getConversation(conversationId)
                    || this._conversationsPendingDeletion?.has(conversationId)
                    || this._isConversationBusy(conversationId)) {
                    continue;
                }

                this._sendQueuedUserMessages(conversationId).catch((error) => {
                    this._handleQueuedUserMessageError(error, conversationId);
                });
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    async _sendMessage(text, references = [], pendingAttachments = []) {
        const conversation = this._conversations.activeConversation
            ?? this._createConversationWithDefaults();
        const submissionDraft = {
            text,
            references: normalizeComposerReferences(references),
            attachments: pendingAttachments.map((attachment) => ({ ...attachment })),
        };
        const restoreComposerDraft = () => {
            if (!this._isActiveConversationId(conversation.id)) {
                this._composerDraftsByConversation.set(conversation.id, submissionDraft);
                return;
            }

            if (this._getComposerText().trim() || this._pendingAttachments.length > 0) {
                const existingPaths = new Set(this._pendingAttachments.map((attachment) => attachment.path));

                for (const attachment of submissionDraft.attachments) {
                    if (!existingPaths.has(attachment.path))
                        this._pendingAttachments.push({ ...attachment });
                }
                this._updateAttachmentLabel();
                return;
            }

            this._applyComposerDraft(submissionDraft);
            this.focusComposer();
        };

        // The submit handler has already cleared the composer. Yield before
        // provider validation and provisional message construction so GTK can
        // paint the empty input immediately.
        await waitForUiPresentation();

        if (!this._ensureConversationProviderAvailable(conversation)) {
            restoreComposerDraft();
            return;
        }

        const cancellable = this._beginActiveTurn(conversation.id, null, {
            refreshConversationList: false,
        });

        if (!cancellable) {
            restoreComposerDraft();
            return;
        }

        let shouldSendQueued = false;
        let userMessageCommitted = false;
        let presentationFinished = null;
        const provisionalAttachments = pendingAttachments.map((attachment) => ({ ...attachment }));
        const provisionalContent = this._formatUserMessageContent(text, provisionalAttachments);
        const provisionalView = this._addMessage(
            provisionalContent,
            'user',
            {
                role: 'user',
                content: provisionalContent,
                attachments: provisionalAttachments,
            },
            { preserveLastAssistantMessageView: true },
        );
        let provisionalVisible = true;
        const removeProvisionalMessage = () => {
            if (!provisionalVisible)
                return;

            provisionalVisible = false;
            provisionalView?.remove?.();

            if (this._isActiveConversationId(conversation.id)) {
                this._syncEmptyConversationState(conversation);
                this._scrollToBottom();
            }
        };
        try {
            // Let GTK paint the provisional row before hook discovery, sidebar
            // rebuilding, transcript persistence, or provider work can run.
            await waitForUiPresentation();
            this._refreshConversationList();

            if (isCancellableCancelled(cancellable)) {
                removeProvisionalMessage();
                restoreComposerDraft();
                return;
            }

            if (!await this._ensureTurnSessionHooks(conversation, cancellable)) {
                removeProvisionalMessage();
                restoreComposerDraft();
                return;
            }

            if (!await this._runUserPromptHooks(conversation, text, cancellable)) {
                removeProvisionalMessage();
                restoreComposerDraft();
                return;
            }

            const normalizedReferences = normalizeComposerReferences(references);
            const attachments = this._createAttachmentsForComposerReferences(
                normalizedReferences,
                pendingAttachments,
            );
            const userMessage = createMessage(
                'user',
                this._formatUserMessageContent(text, attachments),
                {
                    attachments,
                    metadata: {
                        composerReferences: normalizedReferences,
                        composerText: text,
                    },
                },
            );
            this._conversations.appendMessage(conversation.id, userMessage);
            userMessageCommitted = true;
            removeProvisionalMessage();
            this._addMessageIfActiveConversation(conversation.id, userMessage);
            this._promptMemoryProposal(userMessage, conversation);

            const toolStatus = await this._runRequestedTool(text, conversation.id, cancellable);
            this._refreshConversationList();

            if (isCancellableCancelled(cancellable)) {
                if (toolStatus !== 'cancelled')
                    this._appendStoppedMessage(conversation.id, 'Response stopped before the provider request started.');

                return;
            }

            this._drainPendingUserMessages(conversation.id);
            const responseResult = await this._streamAssistantResponse(conversation.id, {
                cancellable,
                onPresentationSettling: (promise) => {
                    presentationFinished = promise;
                },
            });
            presentationFinished ??= responseResult?.presentationFinished ?? null;
            shouldSendQueued = shouldAutoSendQueuedMessages({
                cancelled: isCancellableCancelled(cancellable),
                stoppedBeforeAssistantText: responseResult?.stoppedBeforeAssistantText,
            });
        } catch (error) {
            removeProvisionalMessage();

            if (!userMessageCommitted)
                restoreComposerDraft();

            throw error;
        } finally {
            this._finishActiveTurn(cancellable, {
                deferActiveConversationRender: Boolean(presentationFinished),
            });
        }

        if (shouldSendQueued) {
            this._sendQueuedUserMessages(conversation.id).catch((error) => {
                this._handleQueuedUserMessageError(error, conversation.id);
            });
        }
    }

}
