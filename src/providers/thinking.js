export const DEFAULT_THINKING_LEVEL = 'auto';
export const THINKING_LEVELS = ['off', 'minimal', 'auto', 'low', 'medium', 'high', 'max'];
export const THINKING_LEVEL_LABELS = {
    off: 'Off',
    minimal: 'Minimal',
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    max: 'Max',
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

export function getDefaultThinkingLevel(provider, model = null, fallback = DEFAULT_THINKING_LEVEL) {
    const capability = getThinkingCapability(provider, model);

    if (!capability)
        return normalizeThinkingLevel(fallback);

    const defaultLevel = String(capability.defaultLevel ?? '').trim().toLowerCase();

    if (THINKING_LEVELS.includes(defaultLevel) && capability.levels.includes(defaultLevel))
        return defaultLevel;

    const fallbackLevel = normalizeThinkingLevel(fallback);

    if (capability.levels.includes(fallbackLevel))
        return fallbackLevel;

    if (capability.levels.includes(DEFAULT_THINKING_LEVEL))
        return DEFAULT_THINKING_LEVEL;

    return capability.levels[0];
}

export function isThinkingLevelSupported(provider, model, level) {
    return getSupportedThinkingLevels(provider, model).includes(normalizeThinkingLevel(level));
}
