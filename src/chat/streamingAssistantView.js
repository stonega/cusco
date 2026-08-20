import { createMessage } from '../providers/provider.js';
import { normalizeTokenUsage } from '../providers/usage.js';

export function createStreamingAssistantView({
    conversation,
    options = {},
    conversations,
    isActiveConversationId,
    addMessage,
}) {
    let view = null;
    let assistantMessage = null;
    let currentText = '';
    let currentReasoning = '';
    let currentUsage = null;

    const ensureView = () => {
        if (!isActiveConversationId(conversation.id))
            return null;

        if (!view) {
            view = addMessage('', 'assistant');

            if (conversation.agentModeEnabled)
                view.start_working?.(options.workingStartedAt);
        }

        return view;
    };

    const ensureMessage = (text) => {
        if (assistantMessage)
            return assistantMessage;

        assistantMessage = createMessage('assistant', text);
        conversations.appendMessage(conversation.id, assistantMessage, { persist: false });
        return assistantMessage;
    };

    const updatePersistentText = (text, displayText = text) => {
        const normalizedText = String(text ?? '');

        if (normalizedText === currentText) {
            ensureView()?.set_label(displayText);
            return;
        }

        currentText = normalizedText;
        const message = ensureMessage(currentText);

        conversations.updateMessageContent(
            conversation.id,
            message.id,
            currentText,
            { persist: false },
        );
        ensureView()?.set_label(displayText);
    };

    const updatePersistentReasoning = (reasoning) => {
        const normalizedReasoning = String(reasoning ?? '');

        if (normalizedReasoning === currentReasoning)
            return;

        currentReasoning = normalizedReasoning;
        const message = ensureMessage(currentText);

        conversations.updateMessageReasoning(conversation.id, message.id, {
            content: currentReasoning,
            providerId: conversation.providerId,
            modelId: conversation.modelId,
            thinkingLevel: conversation.thinkingLevel,
            createdAt: new Date().toISOString(),
        }, { persist: false });
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
        conversations.updateMessageUsage(
            conversation.id,
            message.id,
            currentUsage,
            { persist: false },
        );
    };
    const updatePersistentArtifacts = (artifacts) => {
        const message = ensureMessage(currentText);
        const storedMessage = conversations.updateMessageArtifacts(
            conversation.id,
            message.id,
            artifacts,
            { persist: false },
        );

        assistantMessage = storedMessage;
    };
    const updatePersistentRunDuration = (durationMilliseconds) => {
        const normalizedDuration = Math.max(
            0,
            Math.round(Number(durationMilliseconds) || 0),
        );
        const message = ensureMessage(currentText);
        const storedMessage = conversations.updateMessageMetadata(
            conversation.id,
            message.id,
            {
                ...message.metadata,
                agentRunDurationMs: normalizedDuration,
            },
            { persist: false },
        );

        assistantMessage = storedMessage;
        ensureView()?.set_run_duration?.(normalizedDuration);
    };
    const updatePersistentProviderContext = (providerParts) => {
        if (!Array.isArray(providerParts) || providerParts.length === 0)
            return;

        const message = ensureMessage(currentText);
        const storedMessage = conversations.updateMessageMetadata(
            conversation.id,
            message.id,
            {
                ...message.metadata,
                geminiProviderParts: providerParts.map((part) => ({ ...part })),
            },
            { persist: false },
        );

        assistantMessage = storedMessage;
    };

    return {
        set_label: (text) => updatePersistentText(text, text),
        set_stream_text: updatePersistentText,
        set_reasoning: updatePersistentReasoning,
        set_usage: updatePersistentUsage,
        set_artifacts: updatePersistentArtifacts,
        set_run_duration: updatePersistentRunDuration,
        set_provider_context: updatePersistentProviderContext,
        set_loading: () => ensureView()?.set_loading(),
        set_status: (text) => ensureView()?.set_status(text),
        clear_status: () => view?.clear_loading?.(),
        finish_working: () => view?.finish_working?.(),
        finish_stream: (finishOptions = {}) => view?.finish_stream?.({
            ...finishOptions,
            onContentRevealed: () => {
                view?.show_actions?.(assistantMessage);
                finishOptions.onContentRevealed?.();
            },
        }),
        set_stream_preferences: (streamOptions) => view?.set_stream_preferences?.(streamOptions),
        persist: () => conversations.persist(),
        remove: () => view?.remove?.(),
        hasContent: () => currentText.length > 0 || currentReasoning.length > 0 || Boolean(currentUsage),
        hasToolResults: () => view?.has_tool_results?.() ?? false,
    };
}
