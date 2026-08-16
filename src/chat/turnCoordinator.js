import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

function isCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

export class TurnCoordinator {
    constructor({
        computerUse,
        conversations,
        pendingDeletion,
        turns = new Map(),
        finishPrecedingAssistant,
        refreshConversationList,
        renderActiveConversation,
        schedulePendingConversationSend,
        setComposerBusy,
        stopLongResponseNotification,
    }) {
        this._computerUse = computerUse;
        this._conversations = conversations;
        this._pendingDeletion = pendingDeletion;
        this.turns = turns;
        this._finishPrecedingAssistant = finishPrecedingAssistant;
        this._refreshConversationList = refreshConversationList;
        this._renderActiveConversation = renderActiveConversation;
        this._schedulePendingConversationSend = schedulePendingConversationSend;
        this._setComposerBusy = setComposerBusy;
        this._stopLongResponseNotification = stopLongResponseNotification;
    }

    begin(conversationId = null, cancellable = null, options = {}) {
        cancellable ??= new Gio.Cancellable();
        const resolvedConversationId = conversationId
            ?? this._conversations.activeConversation?.id
            ?? null;

        if (!resolvedConversationId
            || this._pendingDeletion?.has(resolvedConversationId)
            || this.isBusy(resolvedConversationId)) {
            return null;
        }

        // A new turn establishes a new visual ordering boundary. Flush any
        // presentation tail from the preceding response so the new user row
        // cannot appear beneath an assistant message that is still revealing.
        this._finishPrecedingAssistant(resolvedConversationId);

        let resolveFinished;
        const finished = new Promise((resolve) => {
            resolveFinished = resolve;
        });

        this.turns.set(resolvedConversationId, {
            cancellable,
            turnId: GLib.uuid_string_random(),
            hookContexts: [],
            longResponseNotificationSent: false,
            longResponseTimeoutId: 0,
            finished,
            resolveFinished,
        });
        this._syncComposerBusy();
        if (options.refreshConversationList !== false)
            this._refreshConversationList();
        return cancellable;
    }

    finish(cancellable, options = {}) {
        this._computerUse.finishTurn(cancellable);
        const runtimeEntry = this.entryForCancellable(cancellable);
        const finishedConversationId = runtimeEntry?.[0] ?? null;
        const runtime = runtimeEntry?.[1] ?? null;

        if (finishedConversationId)
            this.turns.delete(finishedConversationId);
        runtime?.resolveFinished?.();

        this._syncComposerBusy();
        this._refreshConversationList();

        if (finishedConversationId
            && this.isActiveConversation(finishedConversationId)
            && options.hasConversationStack
            && !options.deferActiveConversationRender) {
            this._renderActiveConversation({ forceRebuild: true });
        }

        this._schedulePendingConversationSend();
    }

    stopActive() {
        return this.stop(this._conversations.activeConversation?.id ?? null);
    }

    stop(conversationId) {
        const cancellable = this.turns.get(conversationId)?.cancellable ?? null;

        if (!cancellable)
            return false;

        if (!isCancelled(cancellable))
            cancellable.cancel();

        return true;
    }

    stopAll() {
        for (const runtime of this.turns.values()) {
            this._stopLongResponseNotification(runtime.cancellable);
            if (!isCancelled(runtime.cancellable))
                runtime.cancellable.cancel();
        }
    }

    entryForCancellable(cancellable) {
        for (const entry of this.turns.entries()) {
            const [, runtime] = entry;

            if (runtime.cancellable === cancellable)
                return entry;
        }

        return null;
    }

    hookContexts(conversationId) {
        return this.turns.get(conversationId)?.hookContexts ?? [];
    }

    isActiveConversation(conversationId) {
        return this._conversations.activeConversation?.id === conversationId;
    }

    isBusy(conversationId) {
        return Boolean(conversationId && this.turns.has(conversationId));
    }

    isUsingComputer(conversationId) {
        const cancellable = this.turns.get(conversationId)?.cancellable ?? null;
        return this._computerUse.isTurnActive(cancellable);
    }

    _syncComposerBusy() {
        this._setComposerBusy(this.isBusy(this._conversations.activeConversation?.id));
    }
}
