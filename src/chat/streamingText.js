import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('streamingText/streamingText.js');

export const {
    STREAM_ANIMATION_STYLES,
    DEFAULT_STREAM_ANIMATION_STYLE,
    DEFAULT_STREAM_INTERVAL_MS,
    DEFAULT_STREAM_IDLE_FLUSH_MS,
    DEFAULT_STREAM_TARGET_LAG_MS,
    DEFAULT_STREAM_RECOVERY_MS,
    DEFAULT_STREAM_FINISH_DRAIN_MS,
    DEFAULT_STREAM_MAX_LIVE_LAG_MS,
    DEFAULT_STREAM_MAX_BATCH_UNITS,
    normalizeStreamAnimationStyle,
    streamRevealUnits,
    StreamingTextSmoother,
} = implementation;
