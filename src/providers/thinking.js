import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('providerRuntime/thinking.js');

export const {
    DEFAULT_THINKING_LEVEL,
    THINKING_LEVELS,
    THINKING_LEVEL_LABELS,
    normalizeThinkingLevel,
    getThinkingLevelLabel,
    getThinkingCapability,
    getSupportedThinkingLevels,
    getDefaultThinkingLevel,
    isThinkingLevelSupported,
} = implementation;
