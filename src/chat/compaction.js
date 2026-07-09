import { createMessage } from '../providers/provider.js';
import { estimateConversationUsage, estimateTokenCount } from './usage.js';

export const CONTEXT_COMPACTION_SUMMARY_KIND = 'context-compaction-summary';
export const AUTO_COMPACTION_THRESHOLD_RATIO = 0.8;
export const AUTO_COMPACTION_MAX_SUMMARY_OUTPUT_TOKENS = 1536;

const DEFAULT_MAX_SERIALIZED_CHARS = 120000;
const DEFAULT_MIN_RECENT_MESSAGES = 2;
const DEFAULT_MIN_PRESERVE_RECENT_TOKENS = 2000;
const DEFAULT_MAX_PRESERVE_RECENT_TOKENS = 20000;
const DEFAULT_PRESERVE_RECENT_RATIO = 0.25;

function normalizeContextWindowTokens(value) {
    const tokens = Number(value);

    return Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
}

function normalizeRatio(value, fallback) {
    const ratio = Number(value);

    return Number.isFinite(ratio) && ratio > 0 ? ratio : fallback;
}

function cloneMessage(message) {
    return {
        ...message,
        attachments: Array.isArray(message?.attachments)
            ? message.attachments.map((attachment) => ({ ...attachment }))
            : [],
        artifacts: Array.isArray(message?.artifacts)
            ? message.artifacts.map((artifact) => ({ ...artifact }))
            : [],
        metadata: message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
            ? { ...message.metadata }
            : {},
        toolCall: message?.toolCall && typeof message.toolCall === 'object'
            ? { ...message.toolCall }
            : null,
    };
}

function attachmentSummary(message) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];

    if (attachments.length === 0)
        return '';

    return attachments
        .map((attachment) => `${attachment.kind ?? 'attachment'}:${attachment.name ?? attachment.path ?? 'unnamed'}`)
        .join(', ');
}

function truncateTextMiddle(text, maxChars = DEFAULT_MAX_SERIALIZED_CHARS) {
    const value = String(text ?? '');

    if (value.length <= maxChars)
        return value;

    const headLength = Math.floor(maxChars * 0.65);
    const tailLength = Math.max(0, maxChars - headLength);
    return `${value.slice(0, headLength)}\n...[truncated ${value.length - maxChars} chars]...\n${value.slice(-tailLength)}`;
}

export function isCompactionSummaryMessage(message) {
    return message?.metadata?.kind === CONTEXT_COMPACTION_SUMMARY_KIND;
}

export function getCompactionSummary(message) {
    if (!isCompactionSummaryMessage(message))
        return '';

    return String(message.metadata?.summary ?? message.content ?? '').trim();
}

export function estimateMessagesTokens(messages) {
    return estimateConversationUsage(Array.isArray(messages) ? messages : []).tokens;
}

export function getContextUsageState(messages, contextWindowTokens, options = {}) {
    const maxTokens = normalizeContextWindowTokens(contextWindowTokens);
    const tokens = estimateMessagesTokens(messages);
    const thresholdRatio = normalizeRatio(options.thresholdRatio, AUTO_COMPACTION_THRESHOLD_RATIO);

    return {
        tokens,
        maxTokens,
        ratio: maxTokens > 0 ? tokens / maxTokens : 0,
        thresholdRatio,
        shouldCompact: maxTokens > 0 && tokens / maxTokens >= thresholdRatio,
    };
}

export function findCompactionBoundary(messages, contextWindowTokens, options = {}) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const minRecentMessages = Math.max(1, Math.round(options.minRecentMessages ?? DEFAULT_MIN_RECENT_MESSAGES));
    const maxBoundary = safeMessages.length - minRecentMessages;

    if (maxBoundary <= 0)
        return 0;

    const maxTokens = normalizeContextWindowTokens(contextWindowTokens);
    const preserveRecentTokens = Math.max(
        DEFAULT_MIN_PRESERVE_RECENT_TOKENS,
        Math.min(
            DEFAULT_MAX_PRESERVE_RECENT_TOKENS,
            Math.floor(maxTokens * DEFAULT_PRESERVE_RECENT_RATIO),
        ),
    );
    let recentTokens = 0;
    let candidate = maxBoundary;

    for (let index = safeMessages.length - 1; index >= 0; index--) {
        recentTokens += estimateTokenCount(safeMessages[index]?.content ?? '');

        if (recentTokens >= preserveRecentTokens) {
            candidate = index;
            break;
        }
    }

    candidate = Math.min(Math.max(1, candidate), maxBoundary);

    let boundary = candidate;
    while (boundary > 0 && safeMessages[boundary]?.role !== 'user')
        boundary--;

    if (boundary <= 0)
        return 0;

    return Math.min(Math.max(1, boundary), maxBoundary);
}

export function prepareContextCompaction(messages, contextWindowTokens, options = {}) {
    const safeMessages = Array.isArray(messages) ? messages : [];

    if (safeMessages.length <= DEFAULT_MIN_RECENT_MESSAGES + 1)
        return null;

    const boundary = findCompactionBoundary(safeMessages, contextWindowTokens, options);

    if (boundary <= 0)
        return null;

    const compactedMessages = safeMessages.slice(0, boundary).map(cloneMessage);
    const recentMessages = safeMessages.slice(boundary).map(cloneMessage);

    if (compactedMessages.length === 0 || recentMessages.length === 0)
        return null;

    let previousSummary = '';
    for (const message of compactedMessages) {
        const summary = getCompactionSummary(message);

        if (summary)
            previousSummary = summary;
    }

    const messagesToSummarize = compactedMessages.filter((message) => !isCompactionSummaryMessage(message));

    if (!previousSummary && messagesToSummarize.length === 0)
        return null;

    return {
        boundary,
        compactedMessages,
        messagesToSummarize,
        recentMessages,
        previousSummary,
        tokensBefore: estimateMessagesTokens(safeMessages),
    };
}

export function serializeMessageForCompaction(message) {
    const role = String(message?.role ?? 'message');
    const content = String(message?.content ?? '').trim();
    const attachments = attachmentSummary(message);
    const parts = [`[${role}]`];

    if (content)
        parts.push(content);

    if (attachments)
        parts.push(`Attachments: ${attachments}`);

    if (message?.toolCall?.label || message?.toolCall?.name) {
        parts.push(`Tool: ${message.toolCall.label ?? message.toolCall.name}`);
        if (message.toolCall.status)
            parts.push(`Tool status: ${message.toolCall.status}`);
        if (message.toolCall.output)
            parts.push(`Tool output: ${String(message.toolCall.output).slice(0, 2000)}`);
    }

    return parts.join('\n').trim();
}

export function serializeMessagesForCompaction(messages, options = {}) {
    return truncateTextMiddle(
        (Array.isArray(messages) ? messages : [])
            .map(serializeMessageForCompaction)
            .filter(Boolean)
            .join('\n\n'),
        options.maxChars ?? DEFAULT_MAX_SERIALIZED_CHARS,
    );
}

export function buildCompactionPrompt(compaction, options = {}) {
    const compactedText = serializeMessagesForCompaction(compaction.messagesToSummarize, options);
    const recentText = serializeMessagesForCompaction(compaction.recentMessages, {
        maxChars: Math.min(options.maxChars ?? DEFAULT_MAX_SERIALIZED_CHARS, 20000),
    });
    const previousSummary = String(compaction.previousSummary ?? '').trim();

    return [
        'Summarize the conversation history that will be compacted out of the active chat context.',
        '',
        'Instructions:',
        '- Preserve key decisions, user preferences, constraints, and current goals.',
        '- Preserve files, artifacts, tool results, commands, errors, and code changes that matter going forward.',
        '- Preserve unresolved questions, blockers, and next steps.',
        '- Be factual and specific. Do not invent details.',
        '- Keep the summary concise, but complete enough for the assistant to continue without the removed messages.',
        '',
        'Previous summary:',
        previousSummary || '(none)',
        '',
        'Messages being compacted:',
        compactedText || '(none)',
        '',
        'Recent messages that will remain in context:',
        recentText || '(none)',
    ].join('\n');
}

export function createCompactionSummaryMessage(summary, options = {}) {
    const normalizedSummary = String(summary ?? '').trim();
    const generatedAt = new Date().toISOString();

    return createMessage('system', `Context compacted automatically.\n\n${normalizedSummary}`, {
        metadata: {
            kind: CONTEXT_COMPACTION_SUMMARY_KIND,
            summary: normalizedSummary,
            tokensBefore: Math.max(0, Math.round(Number(options.tokensBefore) || 0)),
            tokensAfter: Math.max(0, Math.round(Number(options.tokensAfter) || 0)),
            messagesCompacted: Math.max(0, Math.round(Number(options.messagesCompacted) || 0)),
            providerId: String(options.providerId ?? ''),
            modelId: String(options.modelId ?? ''),
            generatedAt,
        },
    });
}

export function buildCompactedMessageList(summary, compaction, options = {}) {
    const summaryMessage = createCompactionSummaryMessage(summary, {
        ...options,
        tokensBefore: compaction.tokensBefore,
        messagesCompacted: compaction.compactedMessages.length,
    });
    const nextMessages = [
        summaryMessage,
        ...compaction.recentMessages.map(cloneMessage),
    ];

    summaryMessage.metadata.tokensAfter = estimateMessagesTokens(nextMessages);
    return nextMessages;
}
