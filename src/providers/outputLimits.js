export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export const MIN_MAX_OUTPUT_TOKENS = 1024;
export const MAX_MAX_OUTPUT_TOKENS = 32768;
export const DEFAULT_MAX_CONTINUATION_TURNS = 2;

export function normalizeMaxOutputTokens(value) {
    const tokens = Number(value);

    if (!Number.isFinite(tokens) || tokens <= 0)
        return DEFAULT_MAX_OUTPUT_TOKENS;

    return Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, Math.round(tokens)));
}
