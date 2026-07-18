import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import GLib from 'gi://GLib?version=2.0';

export const NORMALIZED_COORDINATE_SIZE = 1000;
export const DEFAULT_GRID_MAJOR_STEP = 100;
export const DEFAULT_GRID_MINOR_STEP = 50;
export const MIN_REGION_SIZE = 20;

const REGION_TARGET_DIMENSION = 1200;
const REGION_MAX_DIMENSION = 1600;
const VISUAL_SIGNATURE_MAX_DIMENSION = 256;
const VISUAL_PIXEL_DELTA_THRESHOLD = 24;
const VISUAL_PIXEL_TOTAL_DELTA_THRESHOLD = 48;
const VISUAL_CHANGE_MINIMUM_PIXELS = 12;
const VISUAL_CHANGE_MINIMUM_RATIO = 0.001;

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value, label) {
    const number = Number(value);

    if (!Number.isFinite(number))
        throw new Error(`${label} must be a finite number.`);

    return number;
}

export function createVisualSignature(path) {
    const source = GdkPixbuf.Pixbuf.new_from_file(path);
    const largestDimension = Math.max(source.get_width(), source.get_height());
    const scale = Math.min(1, VISUAL_SIGNATURE_MAX_DIMENSION / largestDimension);
    const width = Math.max(1, Math.round(source.get_width() * scale));
    const height = Math.max(1, Math.round(source.get_height() * scale));
    const image = scale < 1
        ? source.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)
        : source;
    const pixels = image.get_pixels();
    const channels = image.get_n_channels();
    const rowstride = image.get_rowstride();
    const rgb = new Uint8Array(width * height * 3);
    let outputOffset = 0;

    for (let y = 0; y < height; y++) {
        const rowOffset = y * rowstride;

        for (let x = 0; x < width; x++) {
            const pixelOffset = rowOffset + (x * channels);

            rgb[outputOffset++] = pixels[pixelOffset];
            rgb[outputOffset++] = pixels[pixelOffset + 1];
            rgb[outputOffset++] = pixels[pixelOffset + 2];
        }
    }

    return { width, height, pixels: rgb };
}

export function compareVisualSignatures(before, after) {
    if (!before || !after) {
        return {
            changed: null,
            changedPixels: null,
            changeRatio: null,
            thresholdPixels: null,
        };
    }

    const totalPixels = Math.max(1, after.width * after.height);
    const thresholdPixels = Math.max(
        VISUAL_CHANGE_MINIMUM_PIXELS,
        Math.ceil(totalPixels * VISUAL_CHANGE_MINIMUM_RATIO),
    );

    if (before.width !== after.width || before.height !== after.height) {
        return {
            changed: true,
            changedPixels: totalPixels,
            changeRatio: 1,
            thresholdPixels,
        };
    }

    let changedPixels = 0;

    for (let offset = 0; offset < after.pixels.length; offset += 3) {
        const redDelta = Math.abs(after.pixels[offset] - before.pixels[offset]);
        const greenDelta = Math.abs(after.pixels[offset + 1] - before.pixels[offset + 1]);
        const blueDelta = Math.abs(after.pixels[offset + 2] - before.pixels[offset + 2]);

        if (Math.max(redDelta, greenDelta, blueDelta) >= VISUAL_PIXEL_DELTA_THRESHOLD
            && redDelta + greenDelta + blueDelta >= VISUAL_PIXEL_TOTAL_DELTA_THRESHOLD) {
            changedPixels += 1;
        }
    }

    return {
        changed: changedPixels >= thresholdPixels,
        changedPixels,
        changeRatio: changedPixels / totalPixels,
        thresholdPixels,
    };
}

export function normalizeRegion(region) {
    const normalized = {
        x: finiteNumber(region?.x, 'region.x'),
        y: finiteNumber(region?.y, 'region.y'),
        width: finiteNumber(region?.width, 'region.width'),
        height: finiteNumber(region?.height, 'region.height'),
    };

    if (normalized.x < 0 || normalized.y < 0
        || normalized.width < MIN_REGION_SIZE
        || normalized.height < MIN_REGION_SIZE
        || normalized.x + normalized.width > NORMALIZED_COORDINATE_SIZE
        || normalized.y + normalized.height > NORMALIZED_COORDINATE_SIZE) {
        throw new Error(
            `Region must stay inside 0..${NORMALIZED_COORDINATE_SIZE} and be at least ${MIN_REGION_SIZE} units wide and high.`,
        );
    }

    return normalized;
}

export function mapRegionPoint(region, x, y) {
    const normalized = normalizeRegion(region);
    return {
        x: normalized.x + ((finiteNumber(x, 'x') / NORMALIZED_COORDINATE_SIZE) * normalized.width),
        y: normalized.y + ((finiteNumber(y, 'y') / NORMALIZED_COORDINATE_SIZE) * normalized.height),
    };
}

export function regionPixelBounds(region, width, height) {
    const normalized = normalizeRegion(region);
    const sourceWidth = Math.max(1, Math.round(finiteNumber(width, 'width')));
    const sourceHeight = Math.max(1, Math.round(finiteNumber(height, 'height')));
    const x = clamp(
        Math.floor((normalized.x / NORMALIZED_COORDINATE_SIZE) * sourceWidth),
        0,
        sourceWidth - 1,
    );
    const y = clamp(
        Math.floor((normalized.y / NORMALIZED_COORDINATE_SIZE) * sourceHeight),
        0,
        sourceHeight - 1,
    );
    const endX = clamp(
        Math.ceil(((normalized.x + normalized.width) / NORMALIZED_COORDINATE_SIZE) * sourceWidth),
        x + 1,
        sourceWidth,
    );
    const endY = clamp(
        Math.ceil(((normalized.y + normalized.height) / NORMALIZED_COORDINATE_SIZE) * sourceHeight),
        y + 1,
        sourceHeight,
    );

    return {
        x,
        y,
        width: endX - x,
        height: endY - y,
    };
}

function appendGridLines(cr, values, width, height) {
    for (const value of values) {
        const x = Math.round((value / NORMALIZED_COORDINATE_SIZE) * (width - 1)) + 0.5;
        const y = Math.round((value / NORMALIZED_COORDINATE_SIZE) * (height - 1)) + 0.5;

        cr.moveTo(x, 0);
        cr.lineTo(x, height);
        cr.moveTo(0, y);
        cr.lineTo(width, y);
    }
}

function drawGridLines(cr, values, width, height, { major = false } = {}) {
    appendGridLines(cr, values, width, height);
    cr.setLineWidth(major ? 3 : 2);
    cr.setSourceRGBA(0, 0, 0, major ? 0.48 : 0.28);
    cr.stroke();

    appendGridLines(cr, values, width, height);
    cr.setLineWidth(major ? 1.25 : 0.75);
    cr.setSourceRGBA(0.26, 0.91, 1, major ? 0.72 : 0.36);
    cr.stroke();
}

function drawLabel(cr, text, x, y, width, height) {
    const paddingX = 4;
    const paddingY = 2;
    const extents = cr.textExtents(text);
    const boxWidth = extents.width + (paddingX * 2);
    const boxHeight = extents.height + (paddingY * 2);
    const boxX = clamp(x, 1, Math.max(1, width - boxWidth - 1));
    const boxY = clamp(y, 1, Math.max(1, height - boxHeight - 1));

    cr.setSourceRGBA(0.02, 0.04, 0.06, 0.78);
    cr.rectangle(boxX, boxY, boxWidth, boxHeight);
    cr.fill();
    cr.setSourceRGBA(0.72, 0.97, 1, 0.98);
    cr.moveTo(
        boxX + paddingX - extents.xBearing,
        boxY + paddingY - extents.yBearing,
    );
    cr.showText(text);
}

export function createCoordinateGridOverlay(sourcePath, outputPath, options = {}) {
    const majorStep = Number(options.majorStep) || DEFAULT_GRID_MAJOR_STEP;
    const minorStep = Number(options.minorStep) || DEFAULT_GRID_MINOR_STEP;
    const surface = Cairo.ImageSurface.createFromPNG(sourcePath);
    const cr = new Cairo.Context(surface);

    try {
        const width = surface.getWidth();
        const height = surface.getHeight();
        const minorValues = [];
        const majorValues = [];

        for (let value = minorStep; value < NORMALIZED_COORDINATE_SIZE; value += minorStep) {
            if (value % majorStep === 0)
                majorValues.push(value);
            else
                minorValues.push(value);
        }

        drawGridLines(cr, minorValues, width, height);
        drawGridLines(cr, majorValues, width, height, { major: true });

        const fontSize = clamp(Math.round(Math.min(width, height) * 0.016), 11, 18);
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(fontSize);

        for (const value of majorValues) {
            const x = Math.round((value / NORMALIZED_COORDINATE_SIZE) * (width - 1));
            const y = Math.round((value / NORMALIZED_COORDINATE_SIZE) * (height - 1));
            const xText = `X${value}`;
            const yText = `Y${value}`;
            const xExtents = cr.textExtents(xText);

            drawLabel(cr, xText, x - (xExtents.width / 2), 2, width, height);
            drawLabel(cr, yText, 2, y - (fontSize / 2), width, height);
        }

        surface.flush();
        surface.writeToPNG(outputPath);
        GLib.chmod(outputPath, 0o600);
        return {
            path: outputPath,
            width,
            height,
            coordinateSpace: 'normalized_1000',
            majorStep,
            minorStep,
        };
    } finally {
        cr.$dispose();
        surface.finish();
    }
}

export function createRegionScreenshot(sourcePath, outputPath, region) {
    const source = GdkPixbuf.Pixbuf.new_from_file(sourcePath);
    const normalized = normalizeRegion(region);
    const pixelRegion = regionPixelBounds(
        normalized,
        source.get_width(),
        source.get_height(),
    );
    const cropped = source.new_subpixbuf(
        pixelRegion.x,
        pixelRegion.y,
        pixelRegion.width,
        pixelRegion.height,
    );
    const largestDimension = Math.max(pixelRegion.width, pixelRegion.height);
    const scale = largestDimension < REGION_TARGET_DIMENSION
        ? REGION_TARGET_DIMENSION / largestDimension
        : Math.min(1, REGION_MAX_DIMENSION / largestDimension);
    const width = Math.max(1, Math.round(pixelRegion.width * scale));
    const height = Math.max(1, Math.round(pixelRegion.height * scale));
    const output = scale === 1
        ? cropped
        : cropped.scale_simple(width, height, GdkPixbuf.InterpType.HYPER);

    output.savev(outputPath, 'png', [], []);
    GLib.chmod(outputPath, 0o600);
    return {
        path: outputPath,
        width,
        height,
        region: normalized,
        sourcePixels: pixelRegion,
    };
}

export function accessibilityForRegion(accessibility, region) {
    const normalized = normalizeRegion(region);
    const elements = (accessibility?.elements ?? []).flatMap((element) => {
        const bounds = element?.bounds;

        if (!bounds)
            return [];

        const left = Math.max(normalized.x, Number(bounds.x));
        const top = Math.max(normalized.y, Number(bounds.y));
        const right = Math.min(
            normalized.x + normalized.width,
            Number(bounds.x) + Number(bounds.width),
        );
        const bottom = Math.min(
            normalized.y + normalized.height,
            Number(bounds.y) + Number(bounds.height),
        );

        if (![left, top, right, bottom].every(Number.isFinite)
            || right <= left || bottom <= top) {
            return [];
        }

        return [{
            ...element,
            bounds: {
                x: Math.round(((left - normalized.x) / normalized.width) * NORMALIZED_COORDINATE_SIZE),
                y: Math.round(((top - normalized.y) / normalized.height) * NORMALIZED_COORDINATE_SIZE),
                width: Math.max(1, Math.round(((right - left) / normalized.width) * NORMALIZED_COORDINATE_SIZE)),
                height: Math.max(1, Math.round(((bottom - top) / normalized.height) * NORMALIZED_COORDINATE_SIZE)),
            },
        }];
    });

    return {
        ...(accessibility ?? {}),
        elements,
        view: 'region',
    };
}
