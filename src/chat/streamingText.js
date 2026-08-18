import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('streamingText/streamingText.js');

export const {
    STREAM_ANIMATION_STYLES,
    DEFAULT_STREAM_ANIMATION_STYLE,
    DEFAULT_STREAM_INTERVAL_MS,
    DEFAULT_STREAM_IDLE_FLUSH_MS,
    normalizeStreamAnimationStyle,
    streamRevealUnits,
    StreamingTextSmoother,
} = implementation;
