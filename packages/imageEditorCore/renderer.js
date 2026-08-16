import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Pango from 'gi://Pango?version=1.0';
import PangoCairo from 'gi://PangoCairo?version=1.0';

import {
    DEFAULT_ANNOTATION_STYLE,
    HAND_DRAWN_ROUGHNESS,
} from './document.js';

const PNG_MIME_TYPE = 'image/png';
const DEFAULT_STROKE_WIDTH = DEFAULT_ANNOTATION_STYLE.strokeWidth;
const DEFAULT_FONT_SIZE = DEFAULT_ANNOTATION_STYLE.fontSize;
const MINIMUM_DEVICE_STROKE_WIDTH = 0.5;
const ARROW_HEAD_ANGLE = Math.PI / 7;
const ROUGH_BOWING = 0.75;
const ROUGH_CURVE_STEP_COUNT = 9;
const ROUGH_MIN_RANDOMNESS_OFFSET = 0.75;
const ROUGH_PRIMARY_JITTER_SCALE = 0.25;
const ROUGH_RETRACE_JITTER_SCALE = 0.12;

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function requireLocalPath(path, label = 'Image path') {
    const normalized = String(path ?? '').trim();

    if (!normalized)
        throw new Error(label + ' is required.');

    if (normalized.includes('\0'))
        throw new Error(label + ' contains an invalid null byte.');

    return normalized;
}

function canonicalPath(path) {
    return GLib.canonicalize_filename(requireLocalPath(path), null);
}

function fileIdentity(path) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;

    try {
        const info = Gio.File.new_for_path(path).query_info(
            'unix::device,unix::inode',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );

        return [
            info.get_attribute_as_string('unix::device'),
            info.get_attribute_as_string('unix::inode'),
        ].join(':');
    } catch {
        return null;
    }
}

function pathsReferToSameFile(leftPath, rightPath) {
    if (!leftPath || !rightPath)
        return false;

    if (canonicalPath(leftPath) === canonicalPath(rightPath))
        return true;

    const leftIdentity = fileIdentity(leftPath);
    const rightIdentity = fileIdentity(rightPath);

    return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

function queryFileMetadata(path, format) {
    let contentType = null;
    let fileSize = null;
    let displayName = GLib.path_get_basename(path);

    try {
        const info = Gio.File.new_for_path(path).query_info(
            'standard::content-type,standard::display-name,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );

        contentType = info.get_content_type();
        fileSize = info.get_size();
        displayName = info.get_display_name() || displayName;
    } catch {
        // Decoding below provides the useful error if the file is unreadable.
    }

    const formatMimeTypes = format?.get_mime_types?.() ?? [];
    const mimeType = contentType
        ? Gio.content_type_get_mime_type(contentType)
        : (formatMimeTypes[0] ?? 'application/octet-stream');

    return {
        contentType,
        displayName,
        fileSize,
        mimeType,
    };
}

function pixbufFormatForPath(path) {
    try {
        const [format] = GdkPixbuf.Pixbuf.get_file_info(path);
        return format ?? null;
    } catch {
        return null;
    }
}

function buildLoadedImage(path, animation, rawPixbuf) {
    const format = pixbufFormatForPath(path);
    const metadata = queryFileMetadata(path, format);
    const pixbuf = rawPixbuf.apply_embedded_orientation?.() ?? rawPixbuf;
    const isAnimated = !animation.is_static_image();
    const isVector = Boolean(format?.is_scalable?.())
        || metadata.mimeType === 'image/svg+xml';

    return {
        path,
        pixbuf,
        staticFrame: pixbuf,
        animation,
        width: pixbuf.get_width(),
        height: pixbuf.get_height(),
        sourceWidth: rawPixbuf.get_width(),
        sourceHeight: rawPixbuf.get_height(),
        mimeType: metadata.mimeType,
        contentType: metadata.contentType,
        formatName: format?.get_name?.() ?? null,
        displayName: metadata.displayName,
        fileSize: metadata.fileSize,
        isAnimated,
        isVector,
        isStatic: !isAnimated,
    };
}

/**
 * Decode an image and apply its embedded orientation.
 *
 * Animated images expose their GdkPixbufAnimation as metadata while pixbuf and
 * staticFrame contain the frame that should be flattened when editing starts.
 */
export function loadImageSource(path) {
    const localPath = requireLocalPath(path);
    const animation = GdkPixbuf.PixbufAnimation.new_from_file(localPath);
    const rawPixbuf = animation.get_static_image();

    if (!rawPixbuf)
        throw new Error('The image decoder did not provide a frame for ' + localPath + '.');

    return buildLoadedImage(localPath, animation, rawPixbuf);
}

function notifyImageLoad(onComplete, source, error) {
    if (typeof onComplete !== 'function')
        return;

    try {
        onComplete(source, error);
    } catch (callbackError) {
        logError(callbackError, 'Image load completion callback failed');
    }
}

/**
 * Decode without blocking the GTK main loop while preserving animation metadata.
 * The optional callback supports consumers running a nested GLib main loop, where
 * GJS may defer promise reactions from a dynamically loaded module.
 */
export function loadImageSourceAsync(path, cancellable = null, onComplete = null) {
    const localPath = requireLocalPath(path);
    const file = Gio.File.new_for_path(localPath);

    return new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            let stream;

            try {
                stream = source.read_finish(result);
            } catch (error) {
                notifyImageLoad(onComplete, null, error);
                reject(error);
                return;
            }

            GdkPixbuf.PixbufAnimation.new_from_stream_async(
                stream,
                cancellable,
                (_loader, loadResult) => {
                    try {
                        const animation = GdkPixbuf.PixbufAnimation.new_from_stream_finish(loadResult);
                        const rawPixbuf = animation.get_static_image();

                        if (!rawPixbuf)
                            throw new Error('The image decoder did not provide a frame for ' + localPath + '.');

                        const loadedSource = buildLoadedImage(localPath, animation, rawPixbuf);
                        notifyImageLoad(onComplete, loadedSource, null);
                        resolve(loadedSource);
                    } catch (error) {
                        notifyImageLoad(onComplete, null, error);
                        reject(error);
                    } finally {
                        try {
                            stream.close(null);
                        } catch (_error) {
                            // The image loader may already have closed a failed stream.
                        }
                    }
                },
            );
        });
    });
}

function transformType(transform) {
    const explicit = String(transform?.type ?? transform?.kind ?? '').toLowerCase();

    if (explicit)
        return explicit;
    if (transform?.rect)
        return 'crop';
    if (transform?.quarterTurns != null || transform?.direction)
        return 'rotate';
    if (transform?.axis || transform?.horizontal || transform?.vertical)
        return 'flip';

    return '';
}

function cropPixbuf(pixbuf, transform) {
    const rect = transform?.rect;
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const x = finiteNumber(rect?.x, NaN);
    const y = finiteNumber(rect?.y, NaN);
    const rectWidth = finiteNumber(rect?.width, NaN);
    const rectHeight = finiteNumber(rect?.height, NaN);

    if (![x, y, rectWidth, rectHeight].every(Number.isFinite)
        || rectWidth <= 0 || rectHeight <= 0) {
        throw new Error('Crop rectangle must contain finite, positive normalized dimensions.');
    }

    if (x + rectWidth <= 0 || y + rectHeight <= 0 || x >= 1 || y >= 1)
        throw new Error('Crop rectangle does not intersect the image.');

    const transformSourceWidth = finiteNumber(transform?.sourceWidth, NaN);
    const transformSourceHeight = finiteNumber(transform?.sourceHeight, NaN);
    const transformOutputWidth = finiteNumber(transform?.outputWidth, NaN);
    const transformOutputHeight = finiteNumber(transform?.outputHeight, NaN);
    const requestedWidth = Math.max(1, Math.round(
        transformSourceWidth > 0 && transformOutputWidth > 0
            ? transformOutputWidth * width / transformSourceWidth
            : rectWidth * width,
    ));
    const requestedHeight = Math.max(1, Math.round(
        transformSourceHeight > 0 && transformOutputHeight > 0
            ? transformOutputHeight * height / transformSourceHeight
            : rectHeight * height,
    ));
    const cropWidth = clamp(requestedWidth, 1, width);
    const cropHeight = clamp(requestedHeight, 1, height);
    const left = clamp(Math.floor(x * width), 0, width - cropWidth);
    const top = clamp(Math.floor(y * height), 0, height - cropHeight);

    return pixbuf.new_subpixbuf(
        left,
        top,
        cropWidth,
        cropHeight,
    ).copy();
}

function quarterTurnsForTransform(transform) {
    if (transform?.quarterTurns != null)
        return Math.trunc(finiteNumber(transform.quarterTurns));

    switch (String(transform?.direction ?? '').toLowerCase()) {
    case 'clockwise':
    case 'cw':
    case 'right':
        return 1;
    case 'counterclockwise':
    case 'counter-clockwise':
    case 'ccw':
    case 'left':
        return -1;
    default:
        return 0;
    }
}

function rotatePixbuf(pixbuf, rawQuarterTurns) {
    const quarterTurns = ((rawQuarterTurns % 4) + 4) % 4;

    switch (quarterTurns) {
    case 1:
        return pixbuf.rotate_simple(GdkPixbuf.PixbufRotation.CLOCKWISE);
    case 2:
        return pixbuf.rotate_simple(GdkPixbuf.PixbufRotation.UPSIDEDOWN);
    case 3:
        return pixbuf.rotate_simple(GdkPixbuf.PixbufRotation.COUNTERCLOCKWISE);
    default:
        return pixbuf;
    }
}

function flipPixbuf(pixbuf, transform) {
    let output = pixbuf;
    const axis = String(transform?.axis ?? '').toLowerCase();
    const horizontal = axis === 'horizontal' || transform?.horizontal === true;
    const vertical = axis === 'vertical' || transform?.vertical === true;

    if (!horizontal && !vertical)
        throw new Error('Flip transform must specify a horizontal or vertical axis.');

    if (horizontal)
        output = output.flip(true);
    if (vertical)
        output = output.flip(false);

    return output;
}

/**
 * Replay image transforms in document order without mutating the source.
 */
export function applyImageTransforms(pixbuf, transforms = []) {
    if (!pixbuf)
        throw new Error('A source pixbuf is required.');

    if (!Array.isArray(transforms))
        throw new Error('Image transforms must be an array.');

    let output = pixbuf;

    for (const transform of transforms) {
        switch (transformType(transform)) {
        case 'crop':
            output = cropPixbuf(output, transform);
            break;
        case 'rotate':
            output = rotatePixbuf(output, quarterTurnsForTransform(transform));
            break;
        case 'flip':
            output = flipPixbuf(output, transform);
            break;
        case '':
            throw new Error('Image transform is missing a type.');
        default:
            throw new Error('Unsupported image transform: ' + transformType(transform) + '.');
        }
    }

    return output;
}

function documentTransforms(document) {
    if (typeof document?.getTransforms === 'function')
        return document.getTransforms();

    return document?.transforms ?? [];
}

function documentAnnotations(document) {
    if (typeof document?.getAnnotations === 'function')
        return document.getAnnotations();

    return document?.annotations ?? [];
}

function normalizedX(value, width) {
    return finiteNumber(value) * width;
}

function normalizedY(value, height) {
    return finiteNumber(value) * height;
}

function normalizedPoint(point, width, height) {
    return {
        x: normalizedX(point?.x, width),
        y: normalizedY(point?.y, height),
    };
}

function normalizedRect(rect, width, height) {
    return {
        x: normalizedX(rect?.x, width),
        y: normalizedY(rect?.y, height),
        width: normalizedX(rect?.width, width),
        height: normalizedY(rect?.height, height),
    };
}

function annotationOpacity(annotation) {
    return clamp(finiteNumber(annotation?.opacity, 1), 0, 1);
}

function parseColor(value, fallback = '#000000') {
    if (Array.isArray(value)) {
        const scale = value.some((component) => finiteNumber(component) > 1) ? 255 : 1;
        return {
            red: clamp(finiteNumber(value[0]) / scale, 0, 1),
            green: clamp(finiteNumber(value[1]) / scale, 0, 1),
            blue: clamp(finiteNumber(value[2]) / scale, 0, 1),
            alpha: clamp(finiteNumber(value[3], scale) / scale, 0, 1),
        };
    }

    if (value && typeof value === 'object') {
        const scale = [value.red, value.green, value.blue, value.alpha]
            .some((component) => finiteNumber(component) > 1)
            ? 255
            : 1;

        return {
            red: clamp(finiteNumber(value.red) / scale, 0, 1),
            green: clamp(finiteNumber(value.green) / scale, 0, 1),
            blue: clamp(finiteNumber(value.blue) / scale, 0, 1),
            alpha: clamp(finiteNumber(value.alpha, scale) / scale, 0, 1),
        };
    }

    const rgba = new Gdk.RGBA();
    if (rgba.parse(String(value ?? fallback)))
        return rgba;
    if (value !== fallback && rgba.parse(fallback))
        return rgba;

    return { red: 0, green: 0, blue: 0, alpha: 1 };
}

function setSourceColor(cr, value, opacity = 1, fallback = '#000000') {
    const color = parseColor(value, fallback);
    cr.setSourceRGBA(
        color.red,
        color.green,
        color.blue,
        clamp(color.alpha * opacity, 0, 1),
    );
}

function annotationStrokeWidth(annotation, minimumDimension) {
    const normalized = Math.max(
        0,
        finiteNumber(annotation?.strokeWidth, DEFAULT_STROKE_WIDTH),
    );

    return Math.max(MINIMUM_DEVICE_STROKE_WIDTH, normalized * minimumDimension);
}

function configureStroke(cr, annotation, minimumDimension) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineWidth(annotationStrokeWidth(annotation, minimumDimension));
    setSourceColor(
        cr,
        annotation?.strokeColor ?? annotation?.color,
        annotationOpacity(annotation),
        '#e01b24',
    );
}

function sketchRandom(annotation, salt) {
    const identity = annotation?.id
        ? String(annotation.id)
        : JSON.stringify(annotation ?? {});
    const input = `${identity}:${salt}`;
    let hash = 2166136261;

    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    let state = hash >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function randomOffset(random, amount) {
    return ((random() * 2) - 1) * amount;
}

function randomBetween(random, minimum, maximum) {
    return minimum + random() * (maximum - minimum);
}

// Cairo port of the core RoughJS 4.6.4 line and ellipse construction used by
// Excalidraw. Keep the accompanying license notice in THIRD_PARTY_NOTICES.md.
function roughnessGain(length) {
    if (length < 200)
        return 1;
    if (length > 500)
        return 0.4;
    return -0.0016668 * length + 1.233334;
}

function appendRoughLinePass(
    cr,
    start,
    end,
    random,
    gesture,
    overlay,
) {
    if (gesture.length <= Number.EPSILON) {
        cr.moveTo(start.x, start.y);
        cr.lineTo(end.x, end.y);
        return;
    }

    const jitterScale = overlay
        ? ROUGH_RETRACE_JITTER_SCALE
        : ROUGH_PRIMARY_JITTER_SCALE;
    const jitter = gesture.boundedOffset * gesture.gain * jitterScale;

    cr.moveTo(start.x, start.y);
    cr.curveTo(
        start.x + gesture.deltaX * gesture.divergePoint
            + gesture.displacementX + randomOffset(random, jitter),
        start.y + gesture.deltaY * gesture.divergePoint
            + gesture.displacementY + randomOffset(random, jitter),
        start.x + gesture.deltaX * gesture.divergePoint * 2
            + gesture.displacementX + randomOffset(random, jitter),
        start.y + gesture.deltaY * gesture.divergePoint * 2
            + gesture.displacementY + randomOffset(random, jitter),
        end.x,
        end.y,
    );
}

function createRoughLineGesture(
    start,
    end,
    random,
    maxRandomnessOffset,
) {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const length = Math.hypot(deltaX, deltaY);
    const gain = roughnessGain(length);
    const boundedOffset = maxRandomnessOffset * maxRandomnessOffset * 100
        > length * length
        ? length / 10
        : maxRandomnessOffset;
    const lengthBowingGain = clamp(length / 200 * gain, 0.35, 1);
    const bowDirection = random() < 0.5 ? -1 : 1;
    const bowAmount = ROUGH_BOWING
        * boundedOffset
        * lengthBowingGain
        * randomBetween(random, 0.55, 1)
        * bowDirection;
    const normalX = length > Number.EPSILON ? -deltaY / length : 0;
    const normalY = length > Number.EPSILON ? deltaX / length : 0;

    return {
        deltaX,
        deltaY,
        length,
        gain,
        boundedOffset,
        divergePoint: 0.2 + random() * 0.2,
        displacementX: normalX * bowAmount,
        displacementY: normalY * bowAmount,
    };
}

function appendRoughDoubleLine(
    cr,
    start,
    end,
    random,
    maxRandomnessOffset,
) {
    const gesture = createRoughLineGesture(
        start,
        end,
        random,
        maxRandomnessOffset,
    );

    appendRoughLinePass(
        cr,
        start,
        end,
        random,
        gesture,
        false,
    );
    appendRoughLinePass(
        cr,
        start,
        end,
        random,
        gesture,
        true,
    );
}

function appendRoughQuadraticPass(
    cr,
    start,
    control,
    end,
    random,
    gesture,
    overlay,
) {
    if (gesture.length <= Number.EPSILON) {
        cr.moveTo(start.x, start.y);
        cr.lineTo(end.x, end.y);
        return;
    }

    const jitterScale = overlay
        ? ROUGH_RETRACE_JITTER_SCALE
        : ROUGH_PRIMARY_JITTER_SCALE;
    const jitter = gesture.boundedOffset * gesture.gain * jitterScale;
    const firstControl = {
        x: start.x + (control.x - start.x) * 2 / 3,
        y: start.y + (control.y - start.y) * 2 / 3,
    };
    const secondControl = {
        x: end.x + (control.x - end.x) * 2 / 3,
        y: end.y + (control.y - end.y) * 2 / 3,
    };

    cr.moveTo(start.x, start.y);
    cr.curveTo(
        firstControl.x + gesture.displacementX + randomOffset(random, jitter),
        firstControl.y + gesture.displacementY + randomOffset(random, jitter),
        secondControl.x + gesture.displacementX + randomOffset(random, jitter),
        secondControl.y + gesture.displacementY + randomOffset(random, jitter),
        end.x,
        end.y,
    );
}

function appendRoughDoubleQuadratic(
    cr,
    start,
    control,
    end,
    random,
    maxRandomnessOffset,
) {
    const gesture = createRoughLineGesture(
        start,
        end,
        random,
        maxRandomnessOffset,
    );

    appendRoughQuadraticPass(
        cr,
        start,
        control,
        end,
        random,
        gesture,
        false,
    );
    appendRoughQuadraticPass(
        cr,
        start,
        control,
        end,
        random,
        gesture,
        true,
    );
}

function appendRoughPolygonStroke(cr, points, random, maxRandomnessOffset) {
    for (let index = 0; index < points.length; index++) {
        appendRoughDoubleLine(
            cr,
            points[index],
            points[(index + 1) % points.length],
            random,
            maxRandomnessOffset,
        );
    }
}

function appendRoughPolygonFill(cr, points, random, maxRandomnessOffset) {
    if (points.length === 0)
        return;

    cr.moveTo(
        points[0].x + randomOffset(random, maxRandomnessOffset),
        points[0].y + randomOffset(random, maxRandomnessOffset),
    );
    for (const point of points.slice(1)) {
        cr.lineTo(
            point.x + randomOffset(random, maxRandomnessOffset),
            point.y + randomOffset(random, maxRandomnessOffset),
        );
    }
    cr.closePath();
}

function appendRoughCurve(cr, points) {
    if (points.length < 4)
        return;

    cr.moveTo(points[1].x, points[1].y);
    for (let index = 1; index + 2 < points.length; index++) {
        const previous = points[index - 1];
        const current = points[index];
        const next = points[(index + 1) % points.length];
        const following = points[index + 2];

        cr.curveTo(
            current.x + (next.x - previous.x) / 6,
            current.y + (next.y - previous.y) / 6,
            next.x - (following.x - current.x) / 6,
            next.y - (following.y - current.y) / 6,
            next.x,
            next.y,
        );
    }
}

function ellipseIncrement(rect) {
    const radiusX = Math.abs(rect.width) / 2;
    const radiusY = Math.abs(rect.height) / 2;
    const perimeterScale = Math.sqrt(
        Math.PI * 2 * Math.sqrt((radiusX * radiusX + radiusY * radiusY) / 2),
    );
    const stepCount = Math.ceil(Math.max(
        ROUGH_CURVE_STEP_COUNT,
        ROUGH_CURVE_STEP_COUNT / Math.sqrt(200) * perimeterScale,
    ));

    return Math.PI * 2 / stepCount;
}

function roughEllipsePoints(
    rect,
    random,
    increment,
    pointOffset,
    overlap,
) {
    const radiusX = Math.abs(rect.width) / 2;
    const radiusY = Math.abs(rect.height) / 2;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const radialStart = randomOffset(random, 0.5) - Math.PI / 2;
    const points = [];

    points.push({
        x: centerX + randomOffset(random, pointOffset)
            + radiusX * 0.9 * Math.cos(radialStart - increment),
        y: centerY + randomOffset(random, pointOffset)
            + radiusY * 0.9 * Math.sin(radialStart - increment),
    });

    const endAngle = Math.PI * 2 + radialStart - 0.01;
    for (let angle = radialStart; angle < endAngle; angle += increment) {
        points.push({
            x: centerX + randomOffset(random, pointOffset)
                + radiusX * Math.cos(angle),
            y: centerY + randomOffset(random, pointOffset)
                + radiusY * Math.sin(angle),
        });
    }

    points.push({
        x: centerX + randomOffset(random, pointOffset)
            + radiusX * Math.cos(radialStart + Math.PI * 2 + overlap * 0.5),
        y: centerY + randomOffset(random, pointOffset)
            + radiusY * Math.sin(radialStart + Math.PI * 2 + overlap * 0.5),
    });
    points.push({
        x: centerX + randomOffset(random, pointOffset)
            + radiusX * 0.98 * Math.cos(radialStart + overlap),
        y: centerY + randomOffset(random, pointOffset)
            + radiusY * 0.98 * Math.sin(radialStart + overlap),
    });
    points.push({
        x: centerX + randomOffset(random, pointOffset)
            + radiusX * 0.9 * Math.cos(radialStart + overlap * 0.5),
        y: centerY + randomOffset(random, pointOffset)
            + radiusY * 0.9 * Math.sin(radialStart + overlap * 0.5),
    });

    return points;
}

function appendRoughEllipsePass(
    cr,
    rect,
    random,
    maxRandomnessOffset,
    passScale,
    overlap,
) {
    const pointOffset = Math.max(
        0.5,
        maxRandomnessOffset * 0.65 * passScale,
    );
    appendRoughCurve(
        cr,
        roughEllipsePoints(
            rect,
            random,
            ellipseIncrement(rect),
            pointOffset,
            overlap,
        ),
    );
}

function appendRoughDoubleEllipse(cr, rect, random, maxRandomnessOffset) {
    const increment = ellipseIncrement(rect);
    const overlapLimit = randomBetween(random, 0.4, 1);
    const overlap = increment * randomBetween(random, 0.1, overlapLimit);
    const points = roughEllipsePoints(
        rect,
        random,
        increment,
        Math.max(0.5, maxRandomnessOffset * 0.65),
        overlap,
    );

    appendRoughCurve(cr, points);
    appendRoughCurve(cr, points.map(point => ({
        x: point.x + randomOffset(
            random,
            maxRandomnessOffset * ROUGH_RETRACE_JITTER_SCALE,
        ),
        y: point.y + randomOffset(
            random,
            maxRandomnessOffset * ROUGH_RETRACE_JITTER_SCALE,
        ),
    })));
}

function sketchMaxRandomnessOffset(minimumDimension) {
    return Math.max(
        ROUGH_MIN_RANDOMNESS_OFFSET,
        minimumDimension * HAND_DRAWN_ROUGHNESS,
    );
}

function strokeRoughLines(
    cr,
    annotation,
    minimumDimension,
    salt,
    segments,
) {
    const random = sketchRandom(annotation, salt);
    const maxRandomnessOffset = sketchMaxRandomnessOffset(minimumDimension);

    cr.newPath();
    for (const [start, end] of segments)
        appendRoughDoubleLine(cr, start, end, random, maxRandomnessOffset);
    configureStroke(cr, annotation, minimumDimension);
    cr.stroke();
}

function paintRoughPolygon(
    cr,
    annotation,
    minimumDimension,
    salt,
    points,
) {
    const maxRandomnessOffset = sketchMaxRandomnessOffset(minimumDimension);
    const fillColor = annotation?.fillColor ?? annotation?.fill;

    if (fillColor) {
        cr.newPath();
        appendRoughPolygonFill(
            cr,
            points,
            sketchRandom(annotation, `${salt}:fill`),
            maxRandomnessOffset,
        );
        setSourceColor(
            cr,
            fillColor,
            annotationOpacity(annotation),
            'transparent',
        );
        cr.fill();
    }

    if (annotation?.strokeColor === null || annotation?.strokeColor === 'transparent')
        return;

    cr.newPath();
    appendRoughPolygonStroke(
        cr,
        points,
        sketchRandom(annotation, `${salt}:stroke`),
        maxRandomnessOffset,
    );
    configureStroke(cr, annotation, minimumDimension);
    cr.stroke();
}

function paintRoughEllipse(cr, annotation, minimumDimension, rect) {
    const maxRandomnessOffset = sketchMaxRandomnessOffset(minimumDimension);
    const fillColor = annotation?.fillColor ?? annotation?.fill;

    if (fillColor) {
        const random = sketchRandom(annotation, 'ellipse:fill');
        const increment = ellipseIncrement(rect);
        const overlapLimit = randomBetween(random, 0.4, 1);
        const overlap = increment * randomBetween(random, 0.1, overlapLimit);

        cr.newPath();
        appendRoughEllipsePass(
            cr,
            rect,
            random,
            maxRandomnessOffset,
            1,
            overlap,
        );
        cr.closePath();
        setSourceColor(
            cr,
            fillColor,
            annotationOpacity(annotation),
            'transparent',
        );
        cr.fill();
    }

    if (annotation?.strokeColor === null || annotation?.strokeColor === 'transparent')
        return;

    cr.newPath();
    appendRoughDoubleEllipse(
        cr,
        rect,
        sketchRandom(annotation, 'ellipse:stroke'),
        maxRandomnessOffset,
    );
    configureStroke(cr, annotation, minimumDimension);
    cr.stroke();
}

function drawPencil(cr, annotation, width, height, minimumDimension) {
    const points = Array.isArray(annotation?.points)
        ? annotation.points.map((point) => normalizedPoint(point, width, height))
        : [];

    if (points.length === 0)
        return;

    configureStroke(cr, annotation, minimumDimension);

    if (points.length === 1) {
        cr.arc(
            points[0].x,
            points[0].y,
            annotationStrokeWidth(annotation, minimumDimension) / 2,
            0,
            Math.PI * 2,
        );
        cr.fill();
        return;
    }

    cr.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1))
        cr.lineTo(point.x, point.y);
    cr.stroke();
}

function lineEndpoints(annotation, width, height) {
    const points = Array.isArray(annotation?.points) ? annotation.points : [];
    const start = annotation?.start ?? points[0] ?? {
        x: annotation?.x1,
        y: annotation?.y1,
    };
    const end = annotation?.end ?? points[points.length - 1] ?? {
        x: annotation?.x2,
        y: annotation?.y2,
    };

    return {
        start: normalizedPoint(start, width, height),
        end: normalizedPoint(end, width, height),
    };
}

function drawLine(cr, annotation, width, height, minimumDimension) {
    const { start, end } = lineEndpoints(annotation, width, height);

    strokeRoughLines(
        cr,
        annotation,
        minimumDimension,
        'line',
        [[start, end]],
    );
}

function drawArrow(cr, annotation, width, height, minimumDimension) {
    const { start, end } = lineEndpoints(annotation, width, height);
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const length = Math.hypot(deltaX, deltaY);
    const chordMidpoint = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
    };
    const bend = annotation?.bend
        ? normalizedPoint(annotation.bend, width, height)
        : chordMidpoint;
    const control = {
        x: bend.x * 2 - chordMidpoint.x,
        y: bend.y * 2 - chordMidpoint.y,
    };

    if (length < 0.5) {
        configureStroke(cr, annotation, minimumDimension);
        cr.arc(
            end.x,
            end.y,
            annotationStrokeWidth(annotation, minimumDimension) / 2,
            0,
            Math.PI * 2,
        );
        cr.fill();
        return;
    }

    const requestedHeadLength = finiteNumber(annotation?.headSize, 0)
        * minimumDimension;
    const headLength = Math.min(
        length * 0.45,
        Math.max(
            requestedHeadLength,
            annotationStrokeWidth(annotation, minimumDimension) * 4,
            minimumDimension * 0.02,
        ),
    );

    let tangentX = end.x - control.x;
    let tangentY = end.y - control.y;

    if (Math.hypot(tangentX, tangentY) < 0.5) {
        tangentX = deltaX;
        tangentY = deltaY;
    }

    const lineAngle = Math.atan2(tangentY, tangentX);
    const left = {
        x: end.x - Math.cos(lineAngle - ARROW_HEAD_ANGLE) * headLength,
        y: end.y - Math.sin(lineAngle - ARROW_HEAD_ANGLE) * headLength,
    };
    const right = {
        x: end.x - Math.cos(lineAngle + ARROW_HEAD_ANGLE) * headLength,
        y: end.y - Math.sin(lineAngle + ARROW_HEAD_ANGLE) * headLength,
    };

    const random = sketchRandom(annotation, 'arrow');
    const maxRandomnessOffset = sketchMaxRandomnessOffset(minimumDimension);

    cr.newPath();
    appendRoughDoubleQuadratic(
        cr,
        start,
        control,
        end,
        random,
        maxRandomnessOffset,
    );
    appendRoughDoubleLine(cr, left, end, random, maxRandomnessOffset);
    appendRoughDoubleLine(cr, right, end, random, maxRandomnessOffset);
    configureStroke(cr, annotation, minimumDimension);
    cr.stroke();
}

function drawRectangle(cr, annotation, width, height, minimumDimension) {
    const rect = normalizedRect(
        annotation?.rect ?? annotation?.bounds ?? annotation,
        width,
        height,
    );

    const points = [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
        { x: rect.x, y: rect.y + rect.height },
    ];

    paintRoughPolygon(
        cr,
        annotation,
        minimumDimension,
        'rectangle',
        points,
    );
}

function drawEllipse(cr, annotation, width, height, minimumDimension) {
    const rect = normalizedRect(
        annotation?.rect ?? annotation?.bounds ?? annotation,
        width,
        height,
    );

    paintRoughEllipse(cr, annotation, minimumDimension, rect);
}

function pangoWeight(value) {
    if (Number.isFinite(Number(value)))
        return clamp(Math.round(Number(value)), Pango.Weight.THIN, Pango.Weight.ULTRAHEAVY);

    switch (String(value ?? '').toLowerCase()) {
    case 'thin':
        return Pango.Weight.THIN;
    case 'light':
        return Pango.Weight.LIGHT;
    case 'medium':
        return Pango.Weight.MEDIUM;
    case 'semibold':
    case 'semi-bold':
        return Pango.Weight.SEMIBOLD;
    case 'bold':
        return Pango.Weight.BOLD;
    case 'heavy':
        return Pango.Weight.HEAVY;
    default:
        return Pango.Weight.NORMAL;
    }
}

function annotationRotation(value) {
    return finiteNumber(value) * Math.PI / 180;
}

function drawText(cr, annotation, width, height, minimumDimension) {
    const text = String(annotation?.text ?? '');
    if (!text)
        return;

    const rect = normalizedRect(
        annotation?.rect ?? annotation?.bounds ?? annotation,
        width,
        height,
    );
    const rectWidth = Math.max(1, Math.abs(rect.width));
    const rectHeight = Math.max(1, Math.abs(rect.height));
    const rotationDegrees = finiteNumber(annotation?.rotation);
    const normalizedRotation = ((rotationDegrees % 180) + 180) % 180;
    const swapsAxes = Math.abs(normalizedRotation - 90) < 0.000001;
    const layoutWidth = swapsAxes ? rectHeight : rectWidth;
    const layoutHeight = swapsAxes ? rectWidth : rectHeight;
    const centerX = rect.x + (rect.width / 2);
    const centerY = rect.y + (rect.height / 2);
    const fontSize = Math.max(
        1,
        finiteNumber(annotation?.fontSize, DEFAULT_FONT_SIZE) * minimumDimension,
    );
    const description = new Pango.FontDescription();

    description.set_family(String(
        annotation?.fontFamily ?? DEFAULT_ANNOTATION_STYLE.fontFamily,
    ));
    description.set_weight(pangoWeight(annotation?.fontWeight));
    description.set_absolute_size(fontSize * Pango.SCALE);

    cr.translate(centerX, centerY);
    cr.rotate(annotationRotation(rotationDegrees));
    cr.scale(annotation?.flipX ? -1 : 1, annotation?.flipY ? -1 : 1);
    cr.rectangle(-layoutWidth / 2, -layoutHeight / 2, layoutWidth, layoutHeight);
    cr.clip();
    cr.moveTo(-layoutWidth / 2, -layoutHeight / 2);

    const layout = PangoCairo.create_layout(cr);
    layout.set_text(text, -1);
    layout.set_font_description(description);
    layout.set_width(Math.round(layoutWidth * Pango.SCALE));
    layout.set_height(Math.round(layoutHeight * Pango.SCALE));
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    layout.set_ellipsize(Pango.EllipsizeMode.NONE);

    setSourceColor(
        cr,
        annotation?.color ?? annotation?.strokeColor,
        annotationOpacity(annotation),
        '#e01b24',
    );
    PangoCairo.show_layout(cr, layout);
}

function drawAnnotation(cr, annotation, width, height) {
    const minimumDimension = Math.min(width, height);
    const type = String(annotation?.type ?? annotation?.kind ?? '').toLowerCase();

    if (annotationOpacity(annotation) <= 0)
        return;

    cr.save();
    try {
        switch (type) {
        case 'pencil':
        case 'freehand':
            drawPencil(cr, annotation, width, height, minimumDimension);
            break;
        case 'line':
            drawLine(cr, annotation, width, height, minimumDimension);
            break;
        case 'arrow':
            drawArrow(cr, annotation, width, height, minimumDimension);
            break;
        case 'rectangle':
        case 'rect':
            drawRectangle(cr, annotation, width, height, minimumDimension);
            break;
        case 'ellipse':
        case 'oval':
            drawEllipse(cr, annotation, width, height, minimumDimension);
            break;
        case 'text':
            drawText(cr, annotation, width, height, minimumDimension);
            break;
        default:
            throw new Error('Unsupported image annotation: ' + (type || '(missing type)') + '.');
        }
    } finally {
        cr.restore();
    }
}

/**
 * Render the transformed source and normalized vector annotations at the
 * transformed source's full pixel dimensions. The caller owns the returned
 * surface and must call finish() when done.
 */
export function renderDocumentToSurface(sourcePixbuf, document) {
    if (!sourcePixbuf)
        throw new Error('A source pixbuf is required.');

    const transformed = applyImageTransforms(
        sourcePixbuf,
        documentTransforms(document),
    );
    const width = transformed.get_width();
    const height = transformed.get_height();
    const annotations = documentAnnotations(document);

    if (!Array.isArray(annotations))
        throw new Error('Image annotations must be an array.');

    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);

    try {
        const cr = new Cairo.Context(surface);

        try {
            cr.setOperator(Cairo.Operator.SOURCE);
            Gdk.cairo_set_source_pixbuf(cr, transformed, 0, 0);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            cr.setAntialias(Cairo.Antialias.BEST);

            for (const annotation of annotations)
                drawAnnotation(cr, annotation, width, height);
        } finally {
            cr.$dispose();
        }

        surface.flush();
        return surface;
    } catch (error) {
        surface.finish();
        throw error;
    }
}

function atomicMove(tempPath, targetPath) {
    Gio.File.new_for_path(tempPath).move(
        Gio.File.new_for_path(targetPath),
        Gio.FileCopyFlags.OVERWRITE,
        null,
        null,
    );
}

/**
 * Flatten an image document to PNG through a same-directory temporary file.
 */
export function exportDocumentPng(
    sourcePixbuf,
    document,
    targetPath,
    { sourcePath } = {},
) {
    const outputPath = requireLocalPath(targetPath, 'Export path');
    const originalPath = requireLocalPath(sourcePath, 'Source path');

    if (pathsReferToSameFile(originalPath, outputPath))
        throw new Error('Choose a new file name; the original image cannot be overwritten.');

    const directory = GLib.path_get_dirname(outputPath);
    const basename = GLib.path_get_basename(outputPath);
    const tempPath = GLib.build_filenamev([
        directory,
        '.' + basename + '.' + GLib.uuid_string_random() + '.tmp',
    ]);

    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error('Could not create the export directory: ' + directory + '.');

    const surface = renderDocumentToSurface(sourcePixbuf, document);
    const width = surface.getWidth();
    const height = surface.getHeight();

    try {
        surface.writeToPNG(tempPath);
        if (GLib.chmod(tempPath, 0o600) !== 0)
            throw new Error('Could not secure the temporary edited image.');
        atomicMove(tempPath, outputPath);
        if (GLib.chmod(outputPath, 0o600) !== 0)
            throw new Error('Could not secure the exported edited image.');
    } finally {
        surface.finish();

        if (GLib.file_test(tempPath, GLib.FileTest.EXISTS))
            GLib.unlink(tempPath);
    }

    let fileSize = null;
    try {
        fileSize = Gio.File.new_for_path(outputPath).query_info(
            'standard::size',
            Gio.FileQueryInfoFlags.NONE,
            null,
        ).get_size();
    } catch {
        // A successful export is still usable if size metadata is unavailable.
    }

    return {
        path: outputPath,
        width,
        height,
        mimeType: PNG_MIME_TYPE,
        fileSize,
    };
}

export function defaultEditedImageDirectory(appId = 'io.github.stonega.Cusco') {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        appId,
        'edited-images',
    ]);
}

function safeOutputStem(sourcePath) {
    const basename = sourcePath
        ? GLib.path_get_basename(String(sourcePath))
        : 'image';
    const extensionIndex = basename.lastIndexOf('.');
    const rawStem = extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename;
    const stem = rawStem
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '');

    return stem || 'image';
}

function safeSuffix(value) {
    const suffix = String(value ?? 'edited')
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return suffix || 'edited';
}

/**
 * Create a collision-resistant managed PNG path. The file is not created
 * until exportDocumentPng succeeds.
 */
export function createEditedImagePath(sourcePath, options = {}) {
    const directory = requireLocalPath(
        options.directory ?? defaultEditedImageDirectory(options.appId),
        'Edited image directory',
    );
    const stem = safeOutputStem(sourcePath);
    const suffix = safeSuffix(options.suffix);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    for (let attempt = 0; attempt < 8; attempt++) {
        const uuid = GLib.uuid_string_random();
        const path = GLib.build_filenamev([
            directory,
            stem + '-' + suffix + '-' + timestamp + '-' + uuid + '.png',
        ]);

        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }

    throw new Error('Could not allocate a unique edited image path.');
}

/**
 * Flatten an edited document into Cusco's durable chat-attachment directory.
 */
export function saveDocumentForChat(
    sourcePixbuf,
    document,
    sourcePath,
    options = {},
) {
    const path = createEditedImagePath(sourcePath, options);
    const directory = GLib.path_get_dirname(path);

    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error('Could not create the managed edited-image directory.');
    if (GLib.chmod(directory, 0o700) !== 0)
        throw new Error('Could not secure the managed edited-image directory.');

    const result = exportDocumentPng(
        sourcePixbuf,
        document,
        path,
        { sourcePath },
    );

    return {
        ...result,
        managed: true,
        sourcePath: sourcePath ?? null,
    };
}
