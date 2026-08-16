import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('streamingText/streamingText.js');

export const {
    STREAM_ANIMATION_STYLES,
    DEFAULT_STREAM_ANIMATION_STYLE,
    normalizeStreamAnimationStyle,
    streamRevealUnits,
    StreamingTextSmoother,
} = implementation;
