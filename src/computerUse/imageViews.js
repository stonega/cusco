import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('computerUse/imageViews.js');

export const {
    NORMALIZED_COORDINATE_SIZE,
    DEFAULT_GRID_MAJOR_STEP,
    DEFAULT_GRID_MINOR_STEP,
    MIN_REGION_SIZE,
    createVisualSignature,
    compareVisualSignatures,
    normalizeRegion,
    mapRegionPoint,
    regionPixelBounds,
    createCoordinateGridOverlay,
    createRegionScreenshot,
    accessibilityForRegion,
} = implementation;
