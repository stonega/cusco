function isCancellableCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

export class AgentQuestionSessions {
    constructor({
        getActiveConversationId,
        captureDraft,
        onActivate,
        onDeactivate,
        onShowQuestion,
        onSetComposerText,
        onFocusComposer,
        sessions = new Map(),
    }) {
        this._getActiveConversationId = getActiveConversationId;
        this._captureDraft = captureDraft;
        this._onActivate = onActivate;
        this._onDeactivate = onDeactivate;
        this._onShowQuestion = onShowQuestion;
        this._onSetComposerText = onSetComposerText;
        this._onFocusComposer = onFocusComposer;
        this.sessions = sessions;
    }

    request(questions, options = {}) {
        const cancellable = options.cancellable ?? null;
        const conversationId = String(options.conversationId ?? '').trim()
            || this._getActiveConversationId()
            || null;

        if (!conversationId) {
            const error = new Error('Ask User needs an owning chat.');
            error.userMessage = error.message;
            throw error;
        }

        if (this.sessions.has(conversationId)) {
            const error = new Error('This chat already has an agent question waiting for an answer.');
            error.userMessage = error.message;
            throw error;
        }

        if (isCancellableCancelled(cancellable)) {
            return Promise.resolve({
                answers: null,
                cancelled: true,
            });
        }

        return new Promise((resolve, reject) => {
            const session = {
                questions,
                index: 0,
                answers: {},
                resolve,
                cancellable,
                cancelSignalId: 0,
                conversationId,
                draft: null,
                uiActive: false,
            };

            this.sessions.set(conversationId, session);

            if (cancellable) {
                try {
                    session.cancelSignalId = cancellable.connect(() => {
                        session.cancelSignalId = 0;
                        this.finish(null, {
                            cancelled: true,
                            conversationId,
                        });
                    });
                } catch (error) {
                    this.sessions.delete(conversationId);
                    reject(error);
                    return;
                }

                if (this.sessions.get(conversationId) !== session)
                    return;
            }

            this.sync();
        });
    }

    sessionFor(conversationId) {
        return conversationId ? this.sessions.get(conversationId) ?? null : null;
    }

    activate(session) {
        if (!session || session.uiActive)
            return;

        session.draft ??= this._captureDraft();
        session.uiActive = true;
        this._onActivate(session);
    }

    deactivate(session, { restoreDraft = true } = {}) {
        if (!session?.uiActive)
            return;

        session.uiActive = false;
        this._onDeactivate(session, { restoreDraft });
    }

    sync() {
        const activeConversationId = this._getActiveConversationId();

        for (const session of this.sessions.values()) {
            if (session.conversationId === activeConversationId)
                this.activate(session);
            else
                this.deactivate(session, { restoreDraft: false });
        }
    }

    submit(answer) {
        const session = this.sessionFor(this._getActiveConversationId());
        const question = session?.questions?.[session.index];
        const value = String(answer ?? '').trim();

        if (!session || !question || !value)
            return false;

        session.answers[question.id] = value;
        session.index += 1;

        if (session.index >= session.questions.length) {
            this.finish(
                { ...session.answers },
                { conversationId: session.conversationId },
            );
            return true;
        }

        this._onSetComposerText('');
        this._onShowQuestion();
        return true;
    }

    finish(answers, {
        cancelled = false,
        conversationId = this._getActiveConversationId(),
    } = {}) {
        const session = this.sessionFor(conversationId);

        if (!session)
            return false;

        if (session.cancellable && session.cancelSignalId) {
            try {
                session.cancellable.disconnect(session.cancelSignalId);
            } catch (_error) {
                // The cancellation signal may already be disconnecting during shutdown.
            }
        }

        this.deactivate(session);
        this.sessions.delete(session.conversationId);
        if (session.conversationId === this._getActiveConversationId())
            this._onFocusComposer();
        session.resolve({
            answers: answers ?? null,
            cancelled,
        });
        return true;
    }
}
