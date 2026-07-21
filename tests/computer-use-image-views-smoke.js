import Cairo from 'cairo';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    accessibilityForRegion,
    compareVisualSignatures,
    createCoordinateGridOverlay,
    createRegionScreenshot,
    createVisualSignature,
    mapRegionPoint,
    normalizeRegion,
    regionPixelBounds,
} from '../src/computerUse/imageViews.js';

const directory = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-computer-use-images-${GLib.uuid_string_random()}`,
]);
GLib.mkdir_with_parents(directory, 0o700);
const sourcePath = GLib.build_filenamev([directory, 'source.png']);
const gridPath = GLib.build_filenamev([directory, 'grid.png']);
const regionPath = GLib.build_filenamev([directory, 'region.png']);
const cursorOnlyPath = GLib.build_filenamev([directory, 'cursor-only.png']);
const changedPath = GLib.build_filenamev([directory, 'changed.png']);
const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 400, 200);
const cr = new Cairo.Context(surface);
cr.setSourceRGB(0.08, 0.09, 0.1);
cr.paint();
cr.setSourceRGB(0.9, 0.9, 0.9);
cr.rectangle(100, 50, 200, 100);
cr.fill();
surface.writeToPNG(sourcePath);
cr.$dispose();
surface.finish();

const cursorOnlySurface = new Cairo.ImageSurface(Cairo.Format.RGB24, 400, 200);
const cursorOnlyContext = new Cairo.Context(cursorOnlySurface);
cursorOnlyContext.setSourceRGB(0.08, 0.09, 0.1);
cursorOnlyContext.paint();
cursorOnlyContext.setSourceRGB(0.9, 0.9, 0.9);
cursorOnlyContext.rectangle(100, 50, 200, 100);
cursorOnlyContext.fill();
cursorOnlyContext.setSourceRGB(0.1, 0.8, 1);
cursorOnlyContext.rectangle(20, 20, 3, 3);
cursorOnlyContext.fill();
cursorOnlySurface.writeToPNG(cursorOnlyPath);
cursorOnlyContext.$dispose();
cursorOnlySurface.finish();

const changedSurface = new Cairo.ImageSurface(Cairo.Format.RGB24, 400, 200);
const changedContext = new Cairo.Context(changedSurface);
changedContext.setSourceRGB(0.08, 0.09, 0.1);
changedContext.paint();
changedContext.setSourceRGB(0.9, 0.9, 0.9);
changedContext.rectangle(100, 50, 200, 100);
changedContext.fill();
changedContext.setSourceRGB(0.1, 0.8, 1);
changedContext.rectangle(20, 20, 80, 40);
changedContext.fill();
changedSurface.writeToPNG(changedPath);
changedContext.$dispose();
changedSurface.finish();

const sourceSignature = createVisualSignature(sourcePath);
const cursorOnlyChange = compareVisualSignatures(
    sourceSignature,
    createVisualSignature(cursorOnlyPath),
);
const meaningfulChange = compareVisualSignatures(
    sourceSignature,
    createVisualSignature(changedPath),
);
if (cursorOnlyChange.changed !== false
    || meaningfulChange.changed !== true
    || meaningfulChange.changedPixels <= meaningfulChange.thresholdPixels
    || !meaningfulChange.changedBounds
    || meaningfulChange.changedBounds.x > 75
    || meaningfulChange.changedBounds.y > 125
    || meaningfulChange.changedBounds.x + meaningfulChange.changedBounds.width < 225
    || meaningfulChange.changedBounds.y + meaningfulChange.changedBounds.height < 275) {
    throw new Error(`Visual change filtering was incorrect: ${JSON.stringify({ cursorOnlyChange, meaningfulChange })}`);
}

const [, sourceBytesBefore] = GLib.file_get_contents(sourcePath);
const sourceHashBefore = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, sourceBytesBefore);
const grid = createCoordinateGridOverlay(sourcePath, gridPath);
const [, sourceBytesAfter] = GLib.file_get_contents(sourcePath);
const [, gridBytes] = GLib.file_get_contents(gridPath);
const sourceHashAfter = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, sourceBytesAfter);
const gridHash = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, gridBytes);

if (grid.width !== 400 || grid.height !== 200
    || sourceHashBefore !== sourceHashAfter
    || gridHash === sourceHashAfter) {
    throw new Error('Coordinate grid did not preserve the clean screenshot or its dimensions');
}

const normalized = normalizeRegion({ x: 250, y: 250, width: 500, height: 500 });
const pixels = regionPixelBounds(normalized, 400, 200);
if (pixels.x !== 100 || pixels.y !== 50 || pixels.width !== 200 || pixels.height !== 100)
    throw new Error(`Region pixel mapping was incorrect: ${JSON.stringify(pixels)}`);

const center = mapRegionPoint(normalized, 500, 500);
if (center.x !== 500 || center.y !== 500)
    throw new Error(`Region point mapping was incorrect: ${JSON.stringify(center)}`);

const region = createRegionScreenshot(sourcePath, regionPath, normalized);
if (region.width !== 1200 || region.height !== 600)
    throw new Error(`Region screenshot was not enlarged correctly: ${JSON.stringify(region)}`);

const regionalAccessibility = accessibilityForRegion({
    available: true,
    source: 'test',
    elements: [
        { ref: 'inside', bounds: { x: 400, y: 400, width: 100, height: 100 } },
        { ref: 'outside', bounds: { x: 0, y: 0, width: 100, height: 100 } },
    ],
}, normalized);
if (regionalAccessibility.elements.length !== 1
    || regionalAccessibility.elements[0].ref !== 'inside'
    || regionalAccessibility.elements[0].bounds.x !== 300
    || regionalAccessibility.elements[0].bounds.y !== 300) {
    throw new Error(`Region accessibility mapping failed: ${JSON.stringify(regionalAccessibility)}`);
}

for (const path of [sourcePath, gridPath, regionPath, cursorOnlyPath, changedPath]) {
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        GLib.unlink(path);
}
Gio.File.new_for_path(directory).delete(null);

print('Cusco computer-use image views smoke passed');
