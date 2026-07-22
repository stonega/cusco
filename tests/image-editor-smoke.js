import Cairo from 'cairo';
import Gio from 'gi://Gio?version=2.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    createAnnotation,
    getAnnotationBounds,
    hitTestAnnotations,
    ImageDocument,
    normalizeImageTransform,
} from '../src/imageEditor/document.js';
import {
    applyImageTransforms,
    exportDocumentPng,
    loadImageSource,
    renderDocumentToSurface,
    saveDocumentForChat,
} from '../src/imageEditor/renderer.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function checksum(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);
}

function pixelAt(pixbuf, x, y) {
    const pixels = pixbuf.get_pixels();
    const offset = (y * pixbuf.get_rowstride()) + (x * pixbuf.get_n_channels());

    return Array.from(pixels.slice(offset, offset + pixbuf.get_n_channels()));
}

function permissionBits(path) {
    const info = Gio.File.new_for_path(path).query_info(
        'unix::mode',
        Gio.FileQueryInfoFlags.NONE,
        null,
    );

    return info.get_attribute_uint32('unix::mode') & 0o777;
}

function removeTree(path) {
    const file = Gio.File.new_for_path(path);
    const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);

    if (type === Gio.FileType.UNKNOWN)
        return;

    if (type === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
        );

        try {
            let info;
            while ((info = enumerator.next_file(null)) !== null)
                removeTree(file.get_child(info.get_name()).get_path());
        } finally {
            enumerator.close(null);
        }
    }

    file.delete(null);
}

const root = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-image-editor-${GLib.uuid_string_random()}`,
]);
const sourcePath = GLib.build_filenamev([root, 'source.png']);
const exportPath = GLib.build_filenamev([root, 'edited.png']);
const managedDirectory = GLib.build_filenamev([root, 'managed']);
GLib.mkdir_with_parents(root, 0o700);

const sourceSurface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 80, 60);
const sourceContext = new Cairo.Context(sourceSurface);
sourceContext.setOperator(Cairo.Operator.SOURCE);
sourceContext.setSourceRGBA(0.08, 0.12, 0.2, 1);
sourceContext.paint();
sourceContext.setSourceRGBA(0.9, 0.2, 0.2, 1);
sourceContext.rectangle(0, 0, 40, 30);
sourceContext.fill();
sourceContext.setSourceRGBA(0.2, 0.8, 0.3, 0.7);
sourceContext.rectangle(40, 30, 40, 30);
sourceContext.fill();
sourceSurface.writeToPNG(sourcePath);
sourceContext.$dispose();
sourceSurface.finish();

const sourceHash = checksum(sourcePath);
const loaded = loadImageSource(sourcePath);
assert(loaded.width === 80 && loaded.height === 60, 'The source image decoded at the wrong size');
assert(loaded.mimeType === 'image/png', `Unexpected image MIME type: ${loaded.mimeType}`);
assert(normalizeImageTransform({
    type: 'rotate',
    quarterTurns: 2,
    sourceWidth: 80,
    sourceHeight: 60,
    outputWidth: 80,
    outputHeight: 60,
}).quarterTurns === 2, 'A serialized 180-degree transform was changed to 90 degrees');

const document = new ImageDocument({ width: loaded.width, height: loaded.height });
const rectangle = document.addAnnotation(createAnnotation('rectangle', {
    rect: { x: 0.1, y: 0.15, width: 0.3, height: 0.25 },
    strokeColor: '#ffffff',
    fillColor: '#3584e4',
}));
assert(rectangle?.id, 'A rectangle annotation was not added');
assert(
    hitTestAnnotations(document.annotations, { x: 0.2, y: 0.2 })?.id === rectangle.id,
    'Filled rectangle hit testing failed',
);

const originalBounds = getAnnotationBounds(rectangle);
document.markSaved();
const historyDepthBeforeDrag = document.undoDepth;
document.beginTransaction('move annotation');
document.moveAnnotation(rectangle.id, 0.05, 0.03, { clamp: true });
document.moveAnnotation(rectangle.id, 0.02, 0.01, { clamp: true });
assert(document.commitTransaction(), 'A changed gesture transaction did not commit');
assert(document.undoDepth === historyDepthBeforeDrag + 1, 'One drag did not produce exactly one undo entry');
assert(document.dirty, 'A moved annotation did not mark the document dirty');
assert(document.undo(), 'Move undo failed');
assert(
    Math.abs(getAnnotationBounds(document.selectedAnnotation).x - originalBounds.x) < 1e-9,
    'Undo did not restore annotation geometry',
);
assert(document.redo(), 'Move redo failed');

const duplicate = document.duplicateAnnotation(rectangle.id);
assert(duplicate?.id && duplicate.id !== rectangle.id, 'Annotation duplication reused the original ID');
assert(document.deleteAnnotation(duplicate.id), 'Deleting a duplicated annotation failed');
assert(document.undo(), 'Deleted annotation could not be restored');

document.addAnnotation(createAnnotation('pencil', {
    points: [{ x: 0.05, y: 0.9 }, { x: 0.3, y: 0.7 }, { x: 0.48, y: 0.85 }],
    strokeColor: '#f9f06b',
    strokeWidth: 0.012,
}));
document.addAnnotation(createAnnotation('arrow', {
    start: { x: 0.12, y: 0.6 },
    end: { x: 0.42, y: 0.38 },
    strokeColor: '#ffffff',
}));
document.addAnnotation(createAnnotation('line', {
    start: { x: 0.08, y: 0.2 },
    end: { x: 0.4, y: 0.52 },
    strokeColor: '#ffbe6f',
}));
document.addAnnotation(createAnnotation('ellipse', {
    rect: { x: 0.52, y: 0.1, width: 0.35, height: 0.3 },
    strokeColor: '#c061cb',
    fillColor: '#c061cb80',
}));
document.addAnnotation(createAnnotation('text', {
    rect: { x: 0.5, y: 0.55, width: 0.42, height: 0.25 },
    text: 'Cusco',
    color: '#ffffff',
    fontSize: 0.09,
}));

document.crop({ x: 0, y: 0, width: 0.75, height: 1 });
assert(document.width === 60 && document.height === 60, 'Crop dimensions were not tracked');
document.rotate(1);
assert(document.width === 60 && document.height === 60, 'Quarter-turn dimensions were not tracked');
document.flip('horizontal');
assert(document.transforms.length === 3, 'Image transforms were not recorded in order');
assert(
    document.transforms.map(transform => transform.type).join(',') === 'crop,rotate,flip',
    'Crop, rotate, and flip transforms were reordered',
);

const previewSurface = renderDocumentToSurface(loaded.pixbuf, document);
assert(previewSurface.getWidth() === 60 && previewSurface.getHeight() === 60,
    'Rendered transformed dimensions were incorrect');
previewSurface.finish();

const edgePixbuf = loaded.pixbuf.scale_simple(32, 32, GdkPixbuf.InterpType.NEAREST);
const edgeCrop = new ImageDocument({ width: 32, height: 32 });
edgeCrop.crop({ x: 0.99, y: 0, width: 0.01, height: 1 });
const edgeSurface = renderDocumentToSurface(edgePixbuf, edgeCrop);
assert(edgeSurface.getWidth() === 1 && edgeSurface.getHeight() === 32,
    'A valid one-pixel crop at the far image edge was rejected');
edgeSurface.finish();

const scaledCropSource = loaded.pixbuf.scale_simple(40, 30, GdkPixbuf.InterpType.NEAREST);
const scaledCropDocument = new ImageDocument({ width: 80, height: 60 });
scaledCropDocument.crop({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
const scaledCropSurface = renderDocumentToSurface(scaledCropSource, scaledCropDocument);
assert(scaledCropSurface.getWidth() === 20 && scaledCropSurface.getHeight() === 15,
    'A downscaled preview did not preserve the normalized crop dimensions');
scaledCropSurface.finish();

// A small, asymmetric RGBA image catches no-op, reversed, and reordered
// transform implementations while also verifying transparent pixels survive.
const asymmetricBytes = new Uint8Array([
    255, 0, 0, 255,       0, 255, 0, 255,       0, 0, 255, 255,       255, 255, 0, 255,
    255, 0, 255, 255,     0, 255, 255, 255,     32, 64, 96, 128,      200, 100, 50, 0,
    10, 20, 30, 255,      40, 50, 60, 255,      70, 80, 90, 255,      100, 110, 120, 255,
]);
const asymmetricPixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
    new GLib.Bytes(asymmetricBytes),
    GdkPixbuf.Colorspace.RGB,
    true,
    8,
    4,
    3,
    16,
);
const asymmetricDocument = new ImageDocument({ width: 4, height: 3 });
asymmetricDocument.crop({ x: 0.25, y: 0, width: 0.75, height: 2 / 3 });
asymmetricDocument.rotate(1);
asymmetricDocument.flip('horizontal');

const exactTransform = applyImageTransforms(
    asymmetricPixbuf,
    asymmetricDocument.transforms,
);
assert(exactTransform.get_width() === 2 && exactTransform.get_height() === 3,
    'Exact transform fixture produced the wrong dimensions');
const expectedPixels = [
    [[0, 255, 0, 255], [0, 255, 255, 255]],
    [[0, 0, 255, 255], [32, 64, 96, 128]],
    [[255, 255, 0, 255], [200, 100, 50, 0]],
];
for (let y = 0; y < expectedPixels.length; y++) {
    for (let x = 0; x < expectedPixels[y].length; x++) {
        assert(
            pixelAt(exactTransform, x, y).join(',') === expectedPixels[y][x].join(','),
            `Transform pixel mismatch at ${x},${y}`,
        );
    }
}

const transparentSurface = renderDocumentToSurface(asymmetricPixbuf, asymmetricDocument);
const transparentPath = GLib.build_filenamev([root, 'transparent-transform.png']);
transparentSurface.writeToPNG(transparentPath);
transparentSurface.finish();
const transparentOutput = GdkPixbuf.Pixbuf.new_from_file(transparentPath);
assert(pixelAt(transparentOutput, 1, 2)[3] === 0,
    'Flattening discarded the transformed source alpha channel');

const exported = exportDocumentPng(loaded.pixbuf, document, exportPath, { sourcePath });
assert(exported.width === 60 && exported.height === 60, 'Export dimensions were incorrect');
assert(GLib.file_test(exportPath, GLib.FileTest.EXISTS), 'Edited PNG was not created');
assert(checksum(sourcePath) === sourceHash, 'Export modified the source image');
const exportedPixbuf = GdkPixbuf.Pixbuf.new_from_file(exportPath);
assert(exportedPixbuf.get_width() === 60 && exportedPixbuf.get_height() === 60,
    'Exported PNG could not be decoded at the expected size');

let missingSourceRejected = false;
try {
    exportDocumentPng(loaded.pixbuf, document, GLib.build_filenamev([root, 'missing-source.png']));
} catch (error) {
    missingSourceRejected = /source path is required/i.test(error.message);
}
assert(missingSourceRejected, 'The renderer accepted an export without source protection');

let sourceOverwriteRejected = false;
try {
    exportDocumentPng(loaded.pixbuf, document, sourcePath, { sourcePath });
} catch (error) {
    sourceOverwriteRejected = /cannot be overwritten/i.test(error.message);
}
assert(sourceOverwriteRejected, 'The renderer allowed the original image to be overwritten');
assert(checksum(sourcePath) === sourceHash, 'Rejected source overwrite still changed the source');

const managed = saveDocumentForChat(loaded.pixbuf, document, sourcePath, {
    directory: managedDirectory,
});
assert(managed.managed && managed.path.endsWith('.png'), 'Managed chat save returned invalid metadata');
assert(GLib.file_test(managed.path, GLib.FileTest.EXISTS), 'Managed chat PNG was not created');
assert(GLib.path_get_dirname(managed.path) === managedDirectory,
    'Managed chat PNG escaped its configured directory');
assert(permissionBits(managedDirectory) === 0o700,
    'Managed edited-image directory permissions are not private');
assert(permissionBits(managed.path) === 0o600,
    'Managed edited-image file permissions are not private');

removeTree(root);
print('Cusco image editor smoke passed');
