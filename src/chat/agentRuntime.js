import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    createAgentToolFailurePrompt,
    createAgentToolRuntimeMessages,
    createNativeToolIntegrityFailureResults,
    createNativeToolRuntimeBatch,
    decideNativeToolIntegrityRecovery,
    DEFAULT_AGENT_MAX_ITERATIONS,
    isPartialAgentToolCall,
    parseAgentToolCall,
    pruneComputerUseObservationImages,
} from './agentMode.js';
import { isComputerUseError } from '../computerUse/protocol.js';
import { createMessage } from '../providers/provider.js';
import { formatToolResultForTranscript } from '../tools/tools.js';

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isCancellableCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

function wasOperationCancelled(error, cancellable = null) {
    return isCancellableCancelled(cancellable) || isGioError(error, Gio.IOErrorEnum.CANCELLED);
}

function toolResultStatus(result) {
    if (result?.cancelled)
        return 'cancelled';
    if (result?.failed)
        return 'failed';
    return 'completed';
}

export class AgentRuntime {
    constructor({
        appSettings,
        conversations,
        tools,
        activeTurnHookContexts,
        addMessageIfActiveConversation,
        appendRunningToolMessage,
        appendToolOutputChunk,
        authorizeToolRequestWithHooks,
        collectProviderResponseWithFallback,
        completeRunningToolFailure,
        completeRunningToolMessage,
        confirmToolPermission,
        createStreamingAssistantView,
        drainPendingUserMessagesForRuntime,
        isActiveConversationId,
        isConversationBusy,
        promptSudoPassword,
        runPostToolUseHooks,
        scheduleUsageDisplayUpdate,
        scrollToBottom,
        setComposerBusy,
        setToolHookProviderOverride,
        updateUsageDisplay,
    }) {
        this._appSettings = appSettings;
        this._conversations = conversations;
        this._tools = tools;
        this._activeTurnHookContexts = activeTurnHookContexts;
        this._addMessageIfActiveConversation = addMessageIfActiveConversation;
        this._appendRunningToolMessage = appendRunningToolMessage;
        this._appendToolOutputChunk = appendToolOutputChunk;
        this._authorizeToolRequestWithHooks = authorizeToolRequestWithHooks;
        this._collectProviderResponseWithFallback = collectProviderResponseWithFallback;
        this._completeRunningToolFailure = completeRunningToolFailure;
        this._completeRunningToolMessage = completeRunningToolMessage;
        this._confirmToolPermission = confirmToolPermission;
        this._createStreamingAssistantView = createStreamingAssistantView;
        this._drainPendingUserMessagesForRuntime = drainPendingUserMessagesForRuntime;
        this._isActiveConversationId = isActiveConversationId;
        this._isConversationBusy = isConversationBusy;
        this._promptSudoPassword = promptSudoPassword;
        this._runPostToolUseHooks = runPostToolUseHooks;
        this._scheduleUsageDisplayUpdate = scheduleUsageDisplayUpdate;
        this._scrollToBottom = scrollToBottom;
        this._setComposerBusy = setComposerBusy;
        this._setToolHookProviderOverride = setToolHookProviderOverride;
        this._updateUsageDisplay = updateUsageDisplay;
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
            this._conversations.appendMessage(conversation.id, message, { persist: false });
            const view = this._addMessageIfActiveConversation(conversation.id, message, {
                reasoningLoading: true,
            });

            this._scheduleUsageDisplayUpdate(conversation);
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
            { persist: false },
        );

        segment.view?.update_reasoning_message?.(storedMessage);
        this._scheduleUsageDisplayUpdate(conversation);
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

            previousView?.finish_working?.();
            assistantViewState.view = this._createStreamingAssistantView(conversation, {
                workingStartedAt: assistantViewState.workingStartedAt,
            });
        };

        let ordinaryIterations = 0;
        let integrityRecoveryUsed = false;
        let pendingIntegrityRecovery = false;

        while (ordinaryIterations < DEFAULT_AGENT_MAX_ITERATIONS || pendingIntegrityRecovery) {
            const isIntegrityRecovery = pendingIntegrityRecovery;
            pendingIntegrityRecovery = false;

            if (!isIntegrityRecovery)
                ordinaryIterations += 1;

            if (isCancellableCancelled(cancellable))
                return '';

            const addedUserMessages = this._drainPendingUserMessagesForRuntime(conversation, runtimeMessages);

            if (addedUserMessages.length > 0)
                resetAssistantViewAfterPendingMessages();

            if (ordinaryIterations === 1 || addedUserMessages.length > 0)
                setAssistantStatus('Agent is thinking...');
            else
                clearAssistantStatus();

            let reasoningSegment = null;
            let responseState;

            try {
                responseState = await this._collectProviderResponseWithFallback(
                    conversation,
                    runtimeMessages,
                    cancellable,
                    (text, _chunk, state) => {
                        if (state?.type === 'status') {
                            setAssistantStatus(state.status);
                            this._scrollToBottom();
                            return;
                        }

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

                        if (state?.type === 'provider_context')
                            getAssistantView()?.set_provider_context?.(state.providerParts);

                        if (state?.type !== 'usage'
                            && state?.type !== 'tool_calls'
                            && state?.type !== 'reasoning'
                            && state?.type !== 'server_tool_results'
                            && state?.type !== 'provider_context') {
                            this._updateAgentModeAssistantView(
                                conversation,
                                getAssistantView(),
                                text,
                            );
                        }
                    },
                    {
                        returnState: true,
                        tools: this._tools.listTools(),
                    },
                );
            } finally {
                reasoningSegment?.view?.finish_reasoning_loading?.();
            }

            reasoningSegment = this._appendOrUpdateAgentReasoningSegment(
                conversation,
                reasoningSegment,
                responseState.reasoning,
            );
            reasoningSegment?.view?.finish_reasoning_loading?.();
            const responseText = responseState.text;

            if (isCancellableCancelled(cancellable))
                return responseText;

            if (responseState.toolCalls.length > 0) {
                let ranAnyTool = false;
                const nativeRuntimeStart = runtimeMessages.length;
                const runtimeNativeToolCalls = responseState.toolCalls.map((nativeToolCall) => ({
                    ...nativeToolCall,
                    id: String(nativeToolCall.id ?? '').trim()
                        || `cusco_${GLib.uuid_string_random().replaceAll('-', '')}`,
                }));
                const integrityDecision = decideNativeToolIntegrityRecovery(
                    runtimeNativeToolCalls,
                    responseState.toolCallIntegrity,
                    { recoveryUsed: integrityRecoveryUsed },
                );

                if (integrityDecision.action === 'stop') {
                    const message = createMessage('system', integrityDecision.userMessage);
                    this._conversations.appendMessage(conversation.id, message);
                    this._addMessageIfActiveConversation(conversation.id, message);
                    return integrityDecision.userMessage;
                }

                if (integrityDecision.action === 'retry') {
                    const failureResults = createNativeToolIntegrityFailureResults(
                        runtimeNativeToolCalls,
                        integrityDecision.integrity,
                    );
                    runtimeMessages.push(...createNativeToolRuntimeBatch(
                        responseText,
                        runtimeNativeToolCalls,
                        failureResults,
                        {
                            providerParts: responseState.providerParts,
                            reasoning: responseState.reasoning,
                        },
                    ));
                    integrityRecoveryUsed = true;
                    pendingIntegrityRecovery = true;
                    setAssistantStatus('Agent is retrying an incomplete tool call...');
                    continue;
                }

                for (const runtimeNativeToolCall of runtimeNativeToolCalls) {
                    const runtimeToolCallText = responseText;
                    const request = this._createAgentToolRequest(
                        runtimeNativeToolCall,
                        runtimeToolCallText,
                        conversation,
                        runtimeMessages,
                        runtimeNativeToolCall,
                    );

                    if (!request) {
                        ranAnyTool = true;
                        continue;
                    }

                    clearAssistantStatus();
                    ranAnyTool = await this._runAgentToolRequest(
                        request,
                        runtimeToolCallText,
                        conversation,
                        runtimeMessages,
                        cancellable,
                        runtimeNativeToolCall,
                    ) || ranAnyTool;
                }

                const nativeRuntimeMessages = runtimeMessages.splice(nativeRuntimeStart);
                runtimeMessages.push(...createNativeToolRuntimeBatch(
                    responseText,
                    runtimeNativeToolCalls,
                    nativeRuntimeMessages,
                    {
                        providerParts: responseState.providerParts,
                        reasoning: responseState.reasoning,
                    },
                ));

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

        this._scheduleUsageDisplayUpdate(conversation);
        this._scrollToBottom();

        if (this._isActiveConversationId(conversation.id)
            && this._isConversationBusy(conversation.id)) {
            this._setComposerBusy(true);
        }
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

    _createAgentToolRequest(
        toolCall,
        responseText,
        conversation,
        runtimeMessages,
        nativeToolCall = null,
    ) {
        try {
            return this._tools.createRequest(toolCall.name, toolCall.input);
        } catch (error) {
            const reason = error.userMessage ?? error.message;
            const message = createMessage('system', reason);
            this._conversations.appendMessage(conversation.id, message);
            this._addMessageIfActiveConversation(conversation.id, message);
            runtimeMessages.push(...createAgentToolRuntimeMessages(
                toolCall,
                responseText,
                reason,
                { failed: true, nativeToolCall },
            ));
            return null;
        }
    }

    async _runAgentToolRequest(
        request,
        responseText,
        conversation,
        runtimeMessages,
        cancellable = null,
        nativeToolCall = null,
    ) {
        const hookContexts = this._activeTurnHookContexts(conversation.id);
        let hookContextStart = hookContexts.length;
        const appendHookContextToRuntime = () => {
            const contexts = hookContexts.slice(hookContextStart);
            hookContextStart = hookContexts.length;

            if (contexts.length > 0) {
                runtimeMessages.push({
                    role: 'system',
                    content: contexts.join('\n\n'),
                });
            }
        };

        if (isCancellableCancelled(cancellable)) {
            this._appendAgentToolCancellation(
                request,
                responseText,
                conversation,
                runtimeMessages,
                nativeToolCall,
            );
            return false;
        }

        const authorization = await this._authorizeToolRequestWithHooks(
            request,
            conversation,
            cancellable,
        );
        request = authorization.request;
        appendHookContextToRuntime();

        if (authorization.status === 'deny') {
            const reason = authorization.reason;
            this._appendAgentToolFailure(
                request,
                responseText,
                conversation,
                runtimeMessages,
                reason,
                'failed',
                nativeToolCall,
            );
            return Boolean(nativeToolCall);
        }

        if (authorization.requiresUserApproval && !await this._confirmToolPermission(request, cancellable)) {
            if (isCancellableCancelled(cancellable)) {
                this._appendAgentToolCancellation(
                    request,
                    responseText,
                    conversation,
                    runtimeMessages,
                    nativeToolCall,
                );
                return false;
            }

            const reason = `${request.label} was not run because permission was denied.`;
            this._appendAgentToolFailure(
                request,
                responseText,
                conversation,
                runtimeMessages,
                reason,
                'failed',
                nativeToolCall,
            );
            return Boolean(nativeToolCall);
        }

        const runningTool = this._appendRunningToolMessage(conversation.id, request, {
            agentMode: true,
        });

        try {
            const result = await this._tools.runRequest(request, {
                conversationId: conversation.id,
                providerId: conversation.providerId,
                timeoutSeconds: request.name === 'bash'
                    ? undefined
                    : this._appSettings.responseTimeoutSeconds,
                cancellable,
                onOutput: (chunk) => this._appendToolOutputChunk(runningTool, chunk),
                requestSudoPassword: request.name === 'bash'
                    ? (command) => this._promptSudoPassword(command, cancellable)
                    : null,
            });
            this._completeRunningToolMessage(
                conversation.id,
                runningTool,
                result,
                toolResultStatus(result),
                { agentMode: true },
            );
            const postHookResult = await this._runPostToolUseHooks(
                request,
                conversation,
                result,
                cancellable,
            );
            appendHookContextToRuntime();
            this._setToolHookProviderOverride(conversation.id, runningTool, postHookResult);
            const transcriptText = postHookResult.stopNormalProcessing
                ? postHookResult.feedback
                : formatToolResultForTranscript(result);

            if (result.cancelled)
                return false;

            if (result.imagePath
                && (request.name === 'computer_observe'
                    || request.name === 'computer_observe_region'
                    || request.name === 'computer_step')) {
                pruneComputerUseObservationImages(runtimeMessages);
            }

            const modelImagePath = result.modelImagePath ?? result.imagePath;
            const attachments = modelImagePath
                ? [{
                    kind: 'image',
                    path: modelImagePath,
                    name: GLib.path_get_basename(modelImagePath),
                    mimeType: result.mimeType ?? 'image/png',
                }]
                : [];

            runtimeMessages.push(...createAgentToolRuntimeMessages(
                request,
                responseText,
                transcriptText,
                { attachments, nativeToolCall },
            ));
            return true;
        } catch (error) {
            const postHookResult = await this._runPostToolUseHooks(request, conversation, {
                error: error.userMessage ?? error.message,
                cancelled: wasOperationCancelled(error, cancellable),
            }, cancellable);
            appendHookContextToRuntime();

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
                this._setToolHookProviderOverride(conversation.id, runningTool, postHookResult);
                runtimeMessages.push(...createAgentToolRuntimeMessages(
                    request,
                    responseText,
                    postHookResult.stopNormalProcessing
                        ? postHookResult.feedback || reason
                        : reason,
                    { failed: true, nativeToolCall },
                ));
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
            this._setToolHookProviderOverride(conversation.id, runningTool, postHookResult);
            runtimeMessages.push(...createAgentToolRuntimeMessages(
                request,
                responseText,
                postHookResult.stopNormalProcessing
                    ? postHookResult.feedback || reason
                    : reason,
                { failed: true, nativeToolCall },
            ));

            if (!isComputerUseError(error))
                logError(error, 'Failed to run Agent tool request');

            return Boolean(nativeToolCall);
        }
    }

    _appendProviderSearchResults(conversation, serverToolResults) {
        for (const searchResult of serverToolResults ?? []) {
            const names = new Set(['search', 'x_search', 'google_maps', 'url_context']);
            const name = names.has(searchResult?.name) ? searchResult.name : 'search';
            const fallbackLabels = {
                search: 'Web Search',
                x_search: 'X Search',
                google_maps: 'Google Maps',
                url_context: 'URL Context',
            };
            const request = {
                name,
                label: searchResult?.label ?? fallbackLabels[name],
                input: String(searchResult?.query ?? '').trim() || 'Provider-managed tool',
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
                output: `${results.length} cited source${results.length === 1 ? '' : 's'} returned.`,
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

    _appendAgentToolCancellation(
        request,
        responseText,
        conversation,
        runtimeMessages,
        nativeToolCall = null,
    ) {
        const reason = `${request.label} was stopped before it finished.`;
        this._appendAgentToolFailure(
            request,
            responseText,
            conversation,
            runtimeMessages,
            reason,
            'cancelled',
            nativeToolCall,
        );
    }

    _appendAgentToolFailure(
        request,
        responseText,
        conversation,
        runtimeMessages,
        reason,
        status = 'failed',
        nativeToolCall = null,
    ) {
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
        runtimeMessages.push(...createAgentToolRuntimeMessages(
            request,
            responseText,
            reason,
            { failed: true, nativeToolCall },
        ));
    }

}
