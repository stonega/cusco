import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('providerRuntime/outputLimits.js');

export const {
    DEFAULT_MAX_OUTPUT_TOKENS,
    MIN_MAX_OUTPUT_TOKENS,
    DEFAULT_MAX_CONTINUATION_TURNS,
    CONTEXT_OUTPUT_RESERVE_TOKENS,
    OUTPUT_CAPACITY_ERROR_CODE,
    normalizeMaxOutputTokens,
    estimateRequestInputTokens,
    resolveEffectiveMaxOutputTokens,
    createOutputCapacityError,
    isOutputCapacityError,
} = implementation;
