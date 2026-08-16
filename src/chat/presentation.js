import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';

const COMPUTER_USE_ACCENT_COLOR = '#42e6f5';
const SHIMMER_EDGE_PADDING = 3;
const CONVERSATION_PAGE_CONTEXT_LIMIT = 6;
const CONVERSATION_LIST_PAGE_SIZE = 50;
const IMAGE_CLIPBOARD_MIME_TYPES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/tiff',
];
const TEXT_CLIPBOARD_MIME_TYPES = [
    'text/plain',
    'text/plain;charset=utf-8',
];

export function shouldAutoSendQueuedMessages({
    cancelled = false,
    stoppedBeforeAssistantText = false,
} = {}) {
    return !cancelled || stoppedBeforeAssistantText;
}

export function shouldSendLongResponseNotification(window) {
    return !Boolean(window.is_active);
}

export function shouldSendSudoPasswordNotification(window) {
    return !Boolean(window.is_active);
}

export function composerHintPresentation(sendWithEnter, isBusy, computerUseActive) {
    const sendShortcut = sendWithEnter ? 'Enter' : 'Ctrl+Enter';

    if (computerUseActive) {
        return {
            markup: `<span alpha="55%">${sendShortcut} queues · </span><span foreground="${COMPUTER_USE_ACCENT_COLOR}" weight="bold">Esc to quit</span>`,
        };
    }

    return {
        label: isBusy
            ? `${sendShortcut} queues · Esc to stop`
            : `${sendShortcut} ↵ to send`,
    };
}

export function formatRunningTime(elapsedSeconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(elapsedSeconds) || 0));
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);

    if (totalMinutes === 0)
        return `${seconds}s`;

    const minutes = totalMinutes % 60;
    if (totalMinutes < 60)
        return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;

    const hours = Math.floor(totalMinutes / 60);
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

export function messageRunDurationLabel(message) {
    const storedDuration = message?.metadata?.agentRunDurationMs;

    if (storedDuration === null || storedDuration === undefined || storedDuration === '')
        return '';

    const durationMilliseconds = Number(storedDuration);

    if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0)
        return '';

    return `Worked for ${formatRunningTime(durationMilliseconds / 1000)}`;
}

export function buildShimmerMarkup(text, phase = 0) {
    const characters = [...String(text ?? '')];

    if (characters.length === 0)
        return '';

    const cycleLength = characters.length + SHIMMER_EDGE_PADDING * 2;
    const normalizedPhase = ((Math.floor(Number(phase) || 0) % cycleLength) + cycleLength) % cycleLength;
    const highlightPosition = normalizedPhase - SHIMMER_EDGE_PADDING;

    return characters.map((character, index) => {
        const distance = Math.abs(index - highlightPosition);
        let alpha = 68;

        if (distance < 0.5)
            alpha = 100;
        else if (distance < 1.5)
            alpha = 90;
        else if (distance < 2.5)
            alpha = 78;

        return `<span alpha="${alpha}%">${GLib.markup_escape_text(character, -1)}</span>`;
    }).join('');
}

export function formatConversationUpdatedAt(updatedAt, currentTime = new Date()) {
    if (updatedAt === null || updatedAt === undefined || updatedAt === '')
        return '';

    const updatedDate = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
    const currentDate = currentTime instanceof Date ? currentTime : new Date(currentTime);

    if (Number.isNaN(updatedDate.getTime()))
        return '';

    const isToday = !Number.isNaN(currentDate.getTime())
        && updatedDate.getFullYear() === currentDate.getFullYear()
        && updatedDate.getMonth() === currentDate.getMonth()
        && updatedDate.getDate() === currentDate.getDate();

    if (isToday) {
        const elapsedMinutes = Math.max(
            0,
            Math.floor((currentDate.getTime() - updatedDate.getTime()) / 60000),
        );

        if (elapsedMinutes < 1)
            return 'Just now';

        if (elapsedMinutes < 60)
            return `${elapsedMinutes} ${elapsedMinutes === 1 ? 'min' : 'mins'} ago`;

        const elapsedHours = Math.floor(elapsedMinutes / 60);
        return `${elapsedHours} ${elapsedHours === 1 ? 'hour' : 'hours'} ago`;
    }

    return updatedDate.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

function getMessageReasoningContent(message) {
    if (typeof message?.reasoning === 'string')
        return message.reasoning.trim();

    return String(message?.reasoning?.content ?? '').trim();
}

function isAgentReasoningMessage(message) {
    return Boolean(message?.reasoning?.agentMode && getMessageReasoningContent(message));
}

export function normalizeConversationMessageStartIndex(
    messages,
    requestedStartIndex,
    contextLimit = CONVERSATION_PAGE_CONTEXT_LIMIT,
) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    let startIndex = Math.max(0, Math.min(safeMessages.length, requestedStartIndex));
    const earliestContextIndex = Math.max(0, startIndex - contextLimit);

    while (startIndex > earliestContextIndex) {
        const message = safeMessages[startIndex];
        const isContinuation = isAgentReasoningMessage(message) || Boolean(message?.toolCall?.agentMode);

        if (!isContinuation)
            break;

        startIndex -= 1;
    }

    return startIndex;
}

export function defaultConversationOptions(enabledSkills = [], overrides = {}) {
    const skillIds = [...new Set((Array.isArray(enabledSkills) ? enabledSkills : [])
        .map((skill) => String(skill?.id ?? skill ?? '').trim())
        .filter(Boolean))];

    return {
        memoryEnabled: false,
        agentModeEnabled: true,
        skillIds,
        ...overrides,
    };
}

export function conversationListPageTarget(
    totalCount,
    requestedCount,
    requiredIndex = -1,
    pageSize = CONVERSATION_LIST_PAGE_SIZE,
) {
    const total = Math.max(0, Number(totalCount) || 0);
    const size = Math.max(1, Number(pageSize) || CONVERSATION_LIST_PAGE_SIZE);
    const requested = Math.max(0, Number(requestedCount) || 0);
    const required = Math.max(0, Number(requiredIndex) + 1 || 0);
    const target = Math.max(Math.min(size, total), requested, required);

    return Math.min(total, Math.ceil(target / size) * size);
}

export function clipboardFormatsContainImage(formats) {
    if (!formats)
        return false;

    if (typeof formats.contain_gtype === 'function'
        && formats.contain_gtype(Gdk.Texture.$gtype)) {
        return true;
    }

    return typeof formats.contain_mime_type === 'function'
        && IMAGE_CLIPBOARD_MIME_TYPES.some((mimeType) => formats.contain_mime_type(mimeType));
}

export function clipboardFormatsContainText(formats) {
    if (!formats)
        return false;

    if (typeof formats.contain_gtype === 'function'
        && formats.contain_gtype(GObject.TYPE_STRING)) {
        return true;
    }

    return typeof formats.contain_mime_type === 'function'
        && TEXT_CLIPBOARD_MIME_TYPES.some((mimeType) => formats.contain_mime_type(mimeType));
}

export function replacePendingAttachment(attachments, currentAttachment, replacementAttachment) {
    if (!Array.isArray(attachments) || !currentAttachment || !replacementAttachment)
        return false;

    const index = attachments.indexOf(currentAttachment);

    if (index < 0)
        return false;

    attachments.splice(index, 1, replacementAttachment);
    return true;
}
