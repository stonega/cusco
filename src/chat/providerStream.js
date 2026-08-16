import GLib from 'gi://GLib?version=2.0';

import { isOutputCapacityError } from '../providers/outputLimits.js';
import { normalizeThinkingLevel } from '../providers/thinking.js';
import { normalizeTokenUsage } from '../providers/usage.js';

const PROVIDER_CONTENT_CALLBACK_INTERVAL_MS = 33;

function normalizeProviderChunk(chunk) {
    if (typeof chunk === 'string')
        return { type: 'text', text: chunk };

    if (!chunk || typeof chunk !== 'object')
        return { type: 'text', text: '' };

    if (chunk.type === 'usage') {
        return {
            type: 'usage',
            text: '',
            usage: normalizeTokenUsage(chunk.usage),
        };
    }

    if (chunk.type === 'tool_calls') {
        return {
            type: 'tool_calls',
            text: '',
            toolCalls: Array.isArray(chunk.toolCalls) ? chunk.toolCalls : [],
            toolCallIntegrity: chunk.integrity ?? { status: 'valid', reason: '' },
            usage: null,
        };
    }

    if (chunk.type === 'server_tool_results') {
        return {
            type: 'server_tool_results',
            text: '',
            serverToolResults: Array.isArray(chunk.serverToolResults) ? chunk.serverToolResults : [],
            usage: null,
        };
    }

    if (chunk.type === 'provider_context') {
        return {
            type: 'provider_context',
            text: '',
            providerParts: Array.isArray(chunk.providerParts) ? chunk.providerParts : [],
            usage: null,
        };
    }

    if (chunk.type === 'status') {
        return {
            type: 'status',
            text: String(chunk.text ?? ''),
            status: String(chunk.status ?? ''),
            attempt: Number(chunk.attempt) || 0,
            maxAttempts: Number(chunk.maxAttempts) || 0,
            usage: null,
        };
    }

    return {
        type: chunk.type === 'reasoning' ? 'reasoning' : 'text',
        text: String(chunk.text ?? chunk.content ?? ''),
        replace: chunk.replace === true,
        usage: null,
    };
}

function resolveThinkingLevel(providerConfigs, appSettings, providerId, modelId, currentLevel) {
    const levels = providerConfigs.getThinkingLevels?.(providerId, modelId) ?? [];
    const normalizedLevel = normalizeThinkingLevel(currentLevel ?? appSettings.thinkingLevel);

    if (levels.length === 0 || levels.includes(normalizedLevel))
        return normalizedLevel;

    return providerConfigs.getDefaultThinkingLevel(providerId, modelId, normalizedLevel);
}

export async function collectProviderResponse(
    {
        providerConfigs,
        appSettings,
        conversations = null,
        resolveSelectionThinkingLevel = null,
    },
    providerId,
    modelId,
    providerMessages,
    cancellable,
    onChunk = null,
    collectOptions = {},
) {
    const activeProvider = providerConfigs.createProvider(providerId);
    const providerConfig = providerConfigs.resolve(providerId, modelId);
    const responseTextParts = [];
    const reasoningTextParts = [];
    let responseText = '';
    let reasoningText = '';
    let usage = null;
    const toolCalls = [];
    let toolCallIntegrity = { status: 'valid', reason: '' };
    const serverToolResults = [];
    let providerParts = [];
    const pendingContent = {
        text: { parts: [], replace: false },
        reasoning: { parts: [], replace: false },
    };
    const pendingContentOrder = [];
    let lastContentFlushAt = 0;
    let contentFlushSourceId = 0;
    let deferredContentError = null;
    const cancelScheduledContentFlush = () => {
        if (!contentFlushSourceId)
            return;
        GLib.source_remove(contentFlushSourceId);
        contentFlushSourceId = 0;
    };
    const materializeContent = () => {
        responseText = responseTextParts.join('');
        reasoningText = reasoningTextParts.join('');
    };
    const chunkState = (normalizedChunk) => ({
        type: normalizedChunk.type,
        text: responseText,
        reasoning: reasoningText,
        replace: normalizedChunk.replace === true,
        usage,
        toolCalls,
        toolCallIntegrity,
        serverToolResults,
        providerParts,
        serverToolResultChunk: normalizedChunk.serverToolResults ?? [],
        status: normalizedChunk.type === 'status' ? normalizedChunk.text : '',
        statusKind: normalizedChunk.status ?? '',
        attempt: normalizedChunk.attempt ?? 0,
        maxAttempts: normalizedChunk.maxAttempts ?? 0,
    });
    const flushPendingContent = () => {
        if (pendingContentOrder.length === 0)
            return;
        cancelScheduledContentFlush();
        materializeContent();
        for (const type of pendingContentOrder) {
            const pending = pendingContent[type];
            const delta = pending.parts.join('');
            onChunk?.(responseText, delta, chunkState({
                type,
                text: delta,
                replace: pending.replace,
            }));
            pending.parts = [];
            pending.replace = false;
        }
        pendingContentOrder.length = 0;
        lastContentFlushAt = GLib.get_monotonic_time();
    };
    const scheduleContentFlush = (delayMilliseconds) => {
        if (!onChunk || contentFlushSourceId)
            return;
        contentFlushSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(delayMilliseconds)),
            () => {
                contentFlushSourceId = 0;
                try {
                    flushPendingContent();
                } catch (error) {
                    deferredContentError = error;
                    cancellable?.cancel?.();
                }
                return GLib.SOURCE_REMOVE;
            },
        );
    };
    const queueContent = (type, text, replace) => {
        const targetParts = type === 'reasoning' ? reasoningTextParts : responseTextParts;
        const pending = pendingContent[type];
        if (replace) {
            targetParts.length = 0;
            pending.parts = [];
            pending.replace = true;
        }
        targetParts.push(text);
        pending.parts.push(text);
        if (!pendingContentOrder.includes(type))
            pendingContentOrder.push(type);
        const now = GLib.get_monotonic_time();
        const elapsedMilliseconds = (now - lastContentFlushAt) / 1000;
        if (onChunk && (lastContentFlushAt === 0
            || elapsedMilliseconds >= PROVIDER_CONTENT_CALLBACK_INTERVAL_MS)) {
            flushPendingContent();
        } else {
            scheduleContentFlush(PROVIDER_CONTENT_CALLBACK_INTERVAL_MS - elapsedMilliseconds);
        }
    };

    let providerError = null;
    try {
        const thinkingLevel = resolveSelectionThinkingLevel
            ? resolveSelectionThinkingLevel(
                providerId,
                modelId,
                collectOptions.thinkingLevel
                    ?? conversations?.activeConversation?.thinkingLevel
                    ?? appSettings.thinkingLevel,
            )
            : resolveThinkingLevel(
                providerConfigs,
                appSettings,
                providerId,
                modelId,
                collectOptions.thinkingLevel
                    ?? conversations?.activeConversation?.thinkingLevel
                    ?? appSettings.thinkingLevel,
            );
        for await (const chunk of activeProvider.streamChat(providerMessages, {
            ...providerConfig,
            cancellable,
            timeoutSeconds: appSettings.responseTimeoutSeconds,
            maxOutputTokens: collectOptions.maxOutputTokens,
            thinkingLevel,
            tools: collectOptions.tools ?? [],
        })) {
            if (deferredContentError)
                throw deferredContentError;
            const normalizedChunk = normalizeProviderChunk(chunk);
            if (normalizedChunk.type === 'reasoning' || normalizedChunk.type === 'text') {
                queueContent(normalizedChunk.type, normalizedChunk.text, normalizedChunk.replace === true);
                continue;
            }
            flushPendingContent();
            if (normalizedChunk.type === 'usage')
                usage = normalizedChunk.usage;
            else if (normalizedChunk.type === 'tool_calls') {
                toolCalls.push(...normalizedChunk.toolCalls);
                toolCallIntegrity = normalizedChunk.toolCallIntegrity;
            } else if (normalizedChunk.type === 'server_tool_results')
                serverToolResults.push(...normalizedChunk.serverToolResults);
            else if (normalizedChunk.type === 'provider_context')
                providerParts = normalizedChunk.providerParts;
            onChunk?.(responseText, normalizedChunk.text, chunkState(normalizedChunk));
        }
    } catch (error) {
        providerError = error;
    } finally {
        cancelScheduledContentFlush();
        try {
            flushPendingContent();
        } catch (error) {
            deferredContentError ??= error;
        }
    }

    if (deferredContentError)
        throw deferredContentError;
    if (providerError)
        throw providerError;
    materializeContent();
    if (collectOptions.returnState) {
        return {
            text: responseText,
            reasoning: reasoningText,
            usage,
            toolCalls,
            toolCallIntegrity,
            serverToolResults,
            providerParts,
        };
    }
    return responseText;
}

export async function collectProviderResponseWithFallback(
    {
        collect,
        getFallback,
        conversations,
        isActiveConversation = () => false,
        onFallbackSelected = () => {},
    },
    conversation,
    providerMessages,
    cancellable,
    onChunk = null,
    collectOptions = {},
) {
    let primaryResponseStarted = false;
    const trackPrimaryChunk = (text, chunk, state) => {
        const type = state?.type ?? 'text';
        if ((type === 'reasoning' && Boolean(state?.reasoning))
            || (type === 'tool_calls' && (state?.toolCalls?.length ?? 0) > 0)
            || (type === 'server_tool_results' && (state?.serverToolResults?.length ?? 0) > 0)
            || (type === 'provider_context' && (state?.providerParts?.length ?? 0) > 0)
            || (type !== 'status' && type !== 'usage' && Boolean(text || chunk))) {
            primaryResponseStarted = true;
        }
        onChunk?.(text, chunk, state);
    };

    try {
        return await collect(
            conversation.providerId,
            conversation.modelId,
            providerMessages,
            cancellable,
            trackPrimaryChunk,
            collectOptions,
        );
    } catch (error) {
        if (primaryResponseStarted || isOutputCapacityError(error))
            throw error;
        const fallback = getFallback(conversation.providerId, error);
        if (!fallback.provider)
            throw error;
        conversations.updateProviderConfig(conversation.id, {
            providerId: fallback.provider.id,
            modelId: fallback.model?.id ?? '',
        });
        onFallbackSelected(conversation, isActiveConversation(conversation.id));
        return await collect(
            fallback.provider.id,
            fallback.model?.id ?? '',
            providerMessages,
            cancellable,
            onChunk,
            collectOptions,
        );
    }
}
