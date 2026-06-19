export function estimateTokenCount(text) {
    const normalized = String(text ?? '').trim();

    if (!normalized)
        return 0;

    return Math.max(1, Math.ceil(normalized.length / 4));
}

export function estimateConversationUsage(messages) {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const characters = safeMessages.reduce((total, message) => (
        total + String(message?.content ?? '').length
    ), 0);
    const tokens = safeMessages.reduce((total, message) => (
        total + estimateTokenCount(message?.content)
    ), 0);

    return {
        characters,
        messages: safeMessages.length,
        tokens,
    };
}
