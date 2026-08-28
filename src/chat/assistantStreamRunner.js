import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const MAX_STOP_HOOK_CONTINUATIONS = 3;

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isCancellableCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

function wasOperationCancelled(error, cancellable = null) {
    return isCancellableCancelled(cancellable) || isGioError(error, Gio.IOErrorEnum.CANCELLED);
}

export class AssistantStreamRunner {
    constructor({
        appSettings,
        conversations,
        connectors = null,
        hooks,
        mcp,
        tools,
        appendHookNotice,
        applyHookResult,
        beginActiveTurn,
        buildProviderMessages,
        collectProviderResponseWithFallback,
        createStreamingAssistantView,
        ensureTurnSessionHooks,
        finishActiveTurn,
        handleQueuedUserMessageError,
        injectMemoryContext,
        injectSkillContext,
        isActiveConversationId,
        isConversationBusy,
        materializeAssistantArtifacts,
        maybeAutoCompactConversation,
        refreshConversationList,
        renderActiveConversation,
        runAgentModeResponse,
        scheduleUsageDisplayUpdate,
        scrollToBottom,
        sendQueuedUserMessages,
        setFollowLatestMessage,
        startLongResponseNotification,
        stopLongResponseNotification,
        turnHookContext,
        updateUsageDisplay,
    }) {
        this._appSettings = appSettings;
        this._conversations = conversations;
        this._connectors = connectors;
        this._hooks = hooks;
        this._mcp = mcp;
        this._tools = tools;
        this._appendHookNotice = appendHookNotice;
        this._applyHookResult = applyHookResult;
        this._beginActiveTurn = beginActiveTurn;
        this._buildProviderMessages = buildProviderMessages;
        this._collectProviderResponseWithFallback = collectProviderResponseWithFallback;
        this._createStreamingAssistantView = createStreamingAssistantView;
        this._ensureTurnSessionHooks = ensureTurnSessionHooks;
        this._finishActiveTurn = finishActiveTurn;
        this._handleQueuedUserMessageError = handleQueuedUserMessageError;
        this._injectMemoryContext = injectMemoryContext;
        this._injectSkillContext = injectSkillContext;
        this._isActiveConversationId = isActiveConversationId;
        this._isConversationBusy = isConversationBusy;
        this._materializeAssistantArtifacts = materializeAssistantArtifacts;
        this._maybeAutoCompactConversation = maybeAutoCompactConversation;
        this._refreshConversationList = refreshConversationList;
        this._renderActiveConversation = renderActiveConversation;
        this._runAgentModeResponse = runAgentModeResponse;
        this._scheduleUsageDisplayUpdate = scheduleUsageDisplayUpdate;
        this._scrollToBottom = scrollToBottom;
        this._sendQueuedUserMessages = sendQueuedUserMessages;
        this._setFollowLatestMessage = setFollowLatestMessage;
        this._startLongResponseNotification = startLongResponseNotification;
        this._stopLongResponseNotification = stopLongResponseNotification;
        this._turnHookContext = turnHookContext;
        this._updateUsageDisplay = updateUsageDisplay;
    }

    _finalizeCancelledAssistantResponse(conversation, assistantView) {
        const hadContent = assistantView?.hasContent?.() ?? false;
        const hadToolResults = assistantView?.hasToolResults?.() ?? false;

        if (hadContent || hadToolResults)
            assistantView?.clear_status?.();
        else
            assistantView?.remove?.();

        if (hadContent) {
            assistantView?.persist?.();
            this._updateUsageDisplay(conversation);
            this._refreshConversationList();
        }

        return !hadContent;
    }

    async _streamAssistantResponse(conversationId, options = {}) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        const ownsActiveTurn = !options.cancellable;
        const cancellable = options.cancellable ?? this._beginActiveTurn(conversation.id);

        if (!cancellable)
            return;

        if (this._isActiveConversationId(conversation.id))
            this._setFollowLatestMessage(true);
        const responseStartedAt = options.responseStartedAt ?? GLib.get_monotonic_time();
        let assistantView = options.assistantView ?? this._createStreamingAssistantView(conversation, {
            workingStartedAt: responseStartedAt,
        });
        let assistantViewState = {
            view: assistantView,
            workingStartedAt: responseStartedAt,
        };
        let shouldSendQueued = false;
        let stoppedBeforeAssistantText = false;
        let presentationFinished = null;

        if (conversation.agentModeEnabled && typeof assistantView?.set_status === 'function')
            assistantView.set_status('Agent is thinking...');
        else
            assistantView?.set_loading?.();

        this._startLongResponseNotification(cancellable);

        try {
            if (!await this._ensureTurnSessionHooks(conversation, cancellable)) {
                stoppedBeforeAssistantText = true;
                assistantView?.remove?.();
                assistantView = null;
                assistantViewState.view = null;
                return { stoppedBeforeAssistantText };
            }

            this._injectMemoryContext(conversation);
            const activeSkills = this._injectSkillContext(conversation);

            if (conversation.agentModeEnabled) {
                const toolRefreshes = [this._mcp.refreshTools(this._tools, {
                    timeoutSeconds: this._appSettings.responseTimeoutSeconds,
                    cancellable,
                })];

                if (typeof this._connectors?.refreshTools === 'function') {
                    toolRefreshes.push(this._connectors.refreshTools(this._tools, {
                        timeoutSeconds: this._appSettings.responseTimeoutSeconds,
                        cancellable,
                    }));
                }

                await Promise.all(toolRefreshes);
            }

            const compactionStatus = await this._maybeAutoCompactConversation(
                conversation,
                activeSkills,
                cancellable,
            );

            if (compactionStatus === 'stopped') {
                stoppedBeforeAssistantText = true;
                assistantView?.remove?.();
                assistantView = null;
                assistantViewState.view = null;
                return { stoppedBeforeAssistantText };
            }

            let providerMessages = this._buildProviderMessages(conversation, activeSkills, {
                agentMode: Boolean(conversation.agentModeEnabled),
            });
            let assistantText;
            let stopHookActive = false;

            for (let continuation = 0; ; continuation += 1) {
                assistantView = assistantViewState.view;

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
                            const currentView = assistantViewState.view;

                            if (state?.type === 'status') {
                                currentView.set_status(state.status);
                                this._scrollToBottom();
                                return;
                            }

                            if (state?.type === 'usage')
                                currentView.set_usage(state.usage);

                            if (state?.type === 'reasoning')
                                currentView.set_reasoning(state.reasoning);

                            if (state?.type === 'provider_context')
                                currentView.set_provider_context?.(state.providerParts);

                            if (state?.type === 'text')
                                currentView.set_label(text);

                            this._scheduleUsageDisplayUpdate(conversation);
                            this._scrollToBottom();
                        },
                    );
                }

                if (isCancellableCancelled(cancellable))
                    break;

                const stopResult = await this._hooks.dispatch(
                    'Stop',
                    this._turnHookContext(conversation),
                    {
                        cancellable,
                        eventInput: {
                            stop_hook_active: stopHookActive,
                            last_assistant_message: assistantText || null,
                        },
                    },
                );
                this._applyHookResult(conversation, stopResult);

                if (!stopResult.shouldContinue)
                    break;

                if (continuation >= MAX_STOP_HOOK_CONTINUATIONS) {
                    this._appendHookNotice(
                        conversation,
                        `Stop hooks reached Cusco's ${MAX_STOP_HOOK_CONTINUATIONS}-continuation safety limit.`,
                    );
                    break;
                }

                const continuationPrompt = stopResult.continuationReasons.join('\n\n');
                const promptResult = await this._hooks.dispatch(
                    'UserPromptSubmit',
                    this._turnHookContext(conversation),
                    {
                        cancellable,
                        eventInput: { prompt: continuationPrompt },
                    },
                );
                this._applyHookResult(conversation, promptResult);

                if (promptResult.blocked || promptResult.continue === false) {
                    this._appendHookNotice(
                        conversation,
                        promptResult.reason
                            || promptResult.stopReason
                            || 'A hook blocked the Stop continuation prompt.',
                    );
                    break;
                }

                assistantView.set_stream_text(assistantText, assistantText);
                assistantView.set_artifacts?.(
                    this._materializeAssistantArtifacts(assistantText, conversation.id),
                );
                assistantView.persist?.();
                await assistantView.finish_stream?.();
                assistantView.finish_working?.();
                this._appendHookNotice(
                    conversation,
                    `A Stop hook requested another response pass: ${continuationPrompt}`,
                );
                providerMessages = [
                    ...this._buildProviderMessages(conversation, activeSkills, {
                        agentMode: Boolean(conversation.agentModeEnabled),
                    }),
                    {
                        role: 'user',
                        content: continuationPrompt,
                    },
                ];
                assistantView = this._createStreamingAssistantView(conversation, {
                    workingStartedAt: responseStartedAt,
                });
                assistantViewState.view = assistantView;
                assistantView.set_loading();
                stopHookActive = true;
            }

            if (isCancellableCancelled(cancellable)) {
                stoppedBeforeAssistantText = this._finalizeCancelledAssistantResponse(
                    conversation,
                    assistantView,
                );
                shouldSendQueued = ownsActiveTurn && stoppedBeforeAssistantText;
            } else {
                assistantView.set_stream_text(assistantText, assistantText);
                assistantView.set_artifacts?.(this._materializeAssistantArtifacts(assistantText, conversation.id));
                if (conversation.agentModeEnabled) {
                    assistantView.set_run_duration?.(
                        Math.max(0, Math.round((GLib.get_monotonic_time() - responseStartedAt) / 1000)),
                    );
                }
                assistantView.persist?.();
                this._refreshConversationList();
                shouldSendQueued = ownsActiveTurn;
            }
        } catch (error) {
            assistantView = assistantViewState?.view ?? assistantView;

            if (wasOperationCancelled(error, cancellable)) {
                stoppedBeforeAssistantText = this._finalizeCancelledAssistantResponse(
                    conversation,
                    assistantView,
                );
                shouldSendQueued = ownsActiveTurn && stoppedBeforeAssistantText;
            } else {
                if (assistantView) {
                    const hadContent = assistantView.hasContent();

                    if (hadContent || assistantView.hasToolResults())
                        assistantView.clear_status();
                    else
                        assistantView.remove();

                    if (hadContent) {
                        assistantView.persist?.();
                        this._updateUsageDisplay(conversation);
                        this._refreshConversationList();
                    }
                }

                throw error;
            }
        } finally {
            const finalAssistantView = assistantViewState?.view ?? assistantView;
            const presentationPromise = finalAssistantView?.finish_stream?.({
                flush: isCancellableCancelled(cancellable),
            });
            presentationFinished = presentationPromise
                ? Promise.resolve(presentationPromise).catch((error) => {
                    logError(error, 'Failed to finish streaming message presentation');
                })
                : null;
            options.onPresentationSettling?.(presentationFinished);
            finalAssistantView?.finish_working?.();
            this._stopLongResponseNotification(cancellable);
            if (this._isActiveConversationId(conversation.id))
                this._setFollowLatestMessage(false);

            if (ownsActiveTurn) {
                this._finishActiveTurn(cancellable, {
                    deferActiveConversationRender: Boolean(presentationFinished),
                });
            }

            presentationFinished?.then(() => {
                // A borrowed turn is released by TurnSubmission after this
                // async method returns. Rebuild on the next main-loop turn so
                // even an already-settled presentation cannot race that
                // cleanup and replace a still-revealing message with its
                // canonical transcript row.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (this._isActiveConversationId(conversation.id)
                        && !this._isConversationBusy(conversation.id)) {
                        this._renderActiveConversation({ forceRebuild: true });
                        this._setFollowLatestMessage(false);
                    }

                    return GLib.SOURCE_REMOVE;
                });
            });
        }

        if (shouldSendQueued) {
            this._sendQueuedUserMessages(conversation.id).catch((error) => {
                this._handleQueuedUserMessageError(error, conversation.id);
            });
        }

        return { stoppedBeforeAssistantText, presentationFinished };
    }

}
