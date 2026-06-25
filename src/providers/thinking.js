export const DEFAULT_THINKING_LEVEL = 'auto';
export const THINKING_LEVELS = ['off', 'auto', 'low', 'medium', 'high'];
export const THINKING_LEVEL_LABELS = {
    off: 'Off',
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
};

export function normalizeThinkingLevel(value, fallback = DEFAULT_THINKING_LEVEL) {
    const normalized = String(value ?? '').trim().toLowerCase();

    if (THINKING_LEVELS.includes(normalized))
        return normalized;

    return THINKING_LEVELS.includes(fallback) ? fallback : DEFAULT_THINKING_LEVEL;
}

export function getThinkingLevelLabel(level) {
    return THINKING_LEVEL_LABELS[normalizeThinkingLevel(level)] ?? THINKING_LEVEL_LABELS[DEFAULT_THINKING_LEVEL];
}

export function getThinkingCapability(provider, model = null) {
    const capability = model?.thinking === false
        ? null
        : model?.thinking ?? provider?.thinking ?? null;

    if (!capability || typeof capability !== 'object')
        return null;

    const levels = Array.isArray(capability.levels)
        ? THINKING_LEVELS.filter((level) => capability.levels.includes(level))
        : [];

    if (levels.length === 0)
        return null;

    return {
        ...capability,
        levels,
    };
}

export function getSupportedThinkingLevels(provider, model = null) {
    return getThinkingCapability(provider, model)?.levels ?? [];
}

export function isThinkingLevelSupported(provider, model, level) {
    return getSupportedThinkingLevels(provider, model).includes(normalizeThinkingLevel(level));
}
