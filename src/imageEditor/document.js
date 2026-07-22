export const IMAGE_DOCUMENT_VERSION = 1;
export const MAX_HISTORY_ENTRIES = 100;
export const MIN_NORMALIZED_SIZE = 0.000001;

export const ANNOTATION_TYPES = Object.freeze([
    'pencil',
    'line',
    'arrow',
    'rectangle',
    'ellipse',
    'text',
]);

export const RESIZE_HANDLES = Object.freeze([
    'north-west',
    'north',
    'north-east',
    'east',
    'south-east',
    'south',
    'south-west',
    'west',
]);

export const DEFAULT_ANNOTATION_STYLE = Object.freeze({
    strokeColor: '#ed333b',
    strokeWidth: 0.006,
    fillColor: null,
    opacity: 1,
    color: '#ed333b',
    fontSize: 0.045,
    fontFamily: 'Sans',
    fontWeight: 400,
});

let _nextAnnotationId = 1;

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function positiveDimension(value, fallback = 1) {
    return Math.max(1, Math.round(finiteNumber(value, fallback)));
}

function normalizedSize(value, fallback) {
    return Math.max(0, finiteNumber(value, fallback));
}

function normalizedFontSize(value, fallback = DEFAULT_ANNOTATION_STYLE.fontSize) {
    return Math.max(MIN_NORMALIZED_SIZE, finiteNumber(value, fallback));
}

function normalizedColor(value, fallback) {
    if (value === null)
        return null;

    const color = String(value ?? '').trim();
    return color || fallback;
}

function deepClone(value) {
    if (value === undefined)
        return undefined;

    return JSON.parse(JSON.stringify(value));
}

function approximatelyEqual(a, b, epsilon = 1e-9) {
    return Math.abs(a - b) <= epsilon;
}

function stateFingerprint(state) {
    return JSON.stringify({
        width: state.width,
        height: state.height,
        annotations: state.annotations,
        transforms: state.transforms,
    });
}

export function clamp(value, minimum = 0, maximum = 1) {
    return Math.min(maximum, Math.max(minimum, finiteNumber(value, minimum)));
}

export function createAnnotationId() {
    const sequence = _nextAnnotationId++;
    return `annotation-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function normalizePoint(point = {}, fallback = { x: 0, y: 0 }) {
    return {
        x: finiteNumber(point?.x, fallback.x),
        y: finiteNumber(point?.y, fallback.y),
    };
}

export function normalizeRect(rect = {}, fallback = {}) {
    let x = finiteNumber(rect?.x, finiteNumber(fallback.x, 0));
    let y = finiteNumber(rect?.y, finiteNumber(fallback.y, 0));
    let width = finiteNumber(rect?.width, finiteNumber(fallback.width, 0));
    let height = finiteNumber(rect?.height, finiteNumber(fallback.height, 0));

    if (width < 0) {
        x += width;
        width = -width;
    }

    if (height < 0) {
        y += height;
        height = -height;
    }

    return { x, y, width, height };
}

export function clampRect(rect, bounds = { x: 0, y: 0, width: 1, height: 1 }) {
    const normalized = normalizeRect(rect);
    const limit = normalizeRect(bounds);
    const left = clamp(normalized.x, limit.x, limit.x + limit.width);
    const top = clamp(normalized.y, limit.y, limit.y + limit.height);
    const right = clamp(
        normalized.x + normalized.width,
        limit.x,
        limit.x + limit.width,
    );
    const bottom = clamp(
        normalized.y + normalized.height,
        limit.y,
        limit.y + limit.height,
    );

    return {
        x: Math.min(left, right),
        y: Math.min(top, bottom),
        width: Math.abs(right - left),
        height: Math.abs(bottom - top),
    };
}

export function rectsIntersect(first, second) {
    const a = normalizeRect(first);
    const b = normalizeRect(second);

    return a.x <= b.x + b.width
        && a.x + a.width >= b.x
        && a.y <= b.y + b.height
        && a.y + a.height >= b.y;
}

export function normalizeCropRect(rect) {
    const cropped = clampRect(rect);

    if (cropped.width < MIN_NORMALIZED_SIZE || cropped.height < MIN_NORMALIZED_SIZE)
        throw new RangeError('Crop rectangle must have a non-zero width and height.');

    return cropped;
}

function annotationBase(annotation, type, id = '') {
    return {
        id: String(id || annotation?.id || createAnnotationId()),
        type,
        opacity: clamp(annotation?.opacity ?? DEFAULT_ANNOTATION_STYLE.opacity),
    };
}

function strokeStyle(annotation) {
    return {
        strokeColor: normalizedColor(
            annotation?.strokeColor,
            DEFAULT_ANNOTATION_STYLE.strokeColor,
        ),
        strokeWidth: normalizedSize(
            annotation?.strokeWidth,
            DEFAULT_ANNOTATION_STYLE.strokeWidth,
        ),
    };
}

/**
 * Normalize an annotation into the editor's plain-data wire shape.
 *
 * Coordinates are relative to the current output width and height. They are
 * normally inside 0..1, but a crop intentionally leaves partially clipped
 * objects outside that range so their geometry is not distorted.
 */
export function normalizeAnnotation(annotation = {}, options = {}) {
    const type = String(annotation?.type ?? options.type ?? '').toLowerCase();

    if (!ANNOTATION_TYPES.includes(type))
        throw new TypeError(`Unsupported annotation type: ${type || '(empty)'}`);

    const base = annotationBase(annotation, type, options.id);

    if (type === 'pencil') {
        const sourcePoints = Array.isArray(annotation?.points) && annotation.points.length > 0
            ? annotation.points
            : [{ x: 0, y: 0 }];

        return {
            ...base,
            ...strokeStyle(annotation),
            points: sourcePoints.map((point) => normalizePoint(point)),
        };
    }

    if (type === 'line' || type === 'arrow') {
        return {
            ...base,
            ...strokeStyle(annotation),
            start: normalizePoint(annotation?.start),
            end: normalizePoint(annotation?.end, annotation?.start),
        };
    }

    if (type === 'rectangle' || type === 'ellipse') {
        return {
            ...base,
            ...strokeStyle(annotation),
            fillColor: normalizedColor(annotation?.fillColor, null),
            rect: normalizeRect(annotation?.rect ?? annotation),
        };
    }

    const fontWeight = Math.round(clamp(
        annotation?.fontWeight ?? DEFAULT_ANNOTATION_STYLE.fontWeight,
        100,
        1000,
    ));

    return {
        ...base,
        rect: normalizeRect(annotation?.rect ?? annotation, {
            width: 0.25,
            height: 0.08,
        }),
        text: String(annotation?.text ?? ''),
        color: normalizedColor(annotation?.color, DEFAULT_ANNOTATION_STYLE.color),
        fontSize: normalizedFontSize(annotation?.fontSize),
        fontFamily: String(
            annotation?.fontFamily ?? DEFAULT_ANNOTATION_STYLE.fontFamily,
        ).trim() || DEFAULT_ANNOTATION_STYLE.fontFamily,
        fontWeight,
        rotation: finiteNumber(annotation?.rotation, 0),
        flipX: Boolean(annotation?.flipX),
        flipY: Boolean(annotation?.flipY),
    };
}

export function createAnnotation(type, properties = {}) {
    return normalizeAnnotation({ ...properties, type });
}

export function getAnnotationBounds(annotation, { includeStroke = false } = {}) {
    let bounds;

    switch (annotation?.type) {
    case 'pencil': {
        const points = Array.isArray(annotation.points) ? annotation.points : [];

        if (points.length === 0)
            return { x: 0, y: 0, width: 0, height: 0 };

        const xs = points.map((point) => finiteNumber(point?.x));
        const ys = points.map((point) => finiteNumber(point?.y));
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        bounds = {
            x: left,
            y: top,
            width: Math.max(...xs) - left,
            height: Math.max(...ys) - top,
        };
        break;
    }
    case 'line':
    case 'arrow': {
        const start = normalizePoint(annotation.start);
        const end = normalizePoint(annotation.end);
        bounds = normalizeRect({
            x: start.x,
            y: start.y,
            width: end.x - start.x,
            height: end.y - start.y,
        });
        break;
    }
    case 'rectangle':
    case 'ellipse':
    case 'text':
        bounds = normalizeRect(annotation.rect);
        break;
    default:
        throw new TypeError(`Unsupported annotation type: ${annotation?.type ?? '(empty)'}`);
    }

    if (!includeStroke || annotation.type === 'text')
        return bounds;

    const padding = normalizedSize(annotation.strokeWidth, 0) / 2;
    return {
        x: bounds.x - padding,
        y: bounds.y - padding,
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
    };
}

export function annotationIntersectsRect(annotation, rect) {
    return rectsIntersect(getAnnotationBounds(annotation, { includeStroke: true }), rect);
}

function metricScale(options = {}) {
    const width = Math.max(MIN_NORMALIZED_SIZE, finiteNumber(options.width, 1));
    const height = Math.max(MIN_NORMALIZED_SIZE, finiteNumber(options.height, 1));
    const shorter = Math.min(width, height);

    return { x: width / shorter, y: height / shorter };
}

function distanceBetween(first, second, scale = { x: 1, y: 1 }) {
    return Math.hypot(
        (first.x - second.x) * scale.x,
        (first.y - second.y) * scale.y,
    );
}

function distanceToSegment(point, start, end, scale) {
    const px = point.x * scale.x;
    const py = point.y * scale.y;
    const x1 = start.x * scale.x;
    const y1 = start.y * scale.y;
    const x2 = end.x * scale.x;
    const y2 = end.y * scale.y;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared <= Number.EPSILON)
        return Math.hypot(px - x1, py - y1);

    const position = clamp(
        ((px - x1) * dx + (py - y1) * dy) / lengthSquared,
        0,
        1,
    );
    return Math.hypot(px - (x1 + position * dx), py - (y1 + position * dy));
}

function pointInsideRect(point, rect) {
    return point.x >= rect.x
        && point.x <= rect.x + rect.width
        && point.y >= rect.y
        && point.y <= rect.y + rect.height;
}

export function hitTestAnnotation(annotation, point, options = {}) {
    const target = normalizePoint(point);
    const scale = metricScale(options);
    const tolerance = Math.max(0, finiteNumber(options.tolerance, 0.008));
    const strokeTolerance = tolerance + normalizedSize(annotation?.strokeWidth, 0) / 2;

    if (annotation?.type === 'pencil') {
        const points = Array.isArray(annotation.points)
            ? annotation.points.map((item) => normalizePoint(item))
            : [];

        if (points.length === 1)
            return distanceBetween(target, points[0], scale) <= strokeTolerance;

        for (let index = 1; index < points.length; index++) {
            if (distanceToSegment(target, points[index - 1], points[index], scale)
                <= strokeTolerance) {
                return true;
            }
        }

        return false;
    }

    if (annotation?.type === 'line' || annotation?.type === 'arrow') {
        return distanceToSegment(
            target,
            normalizePoint(annotation.start),
            normalizePoint(annotation.end),
            scale,
        ) <= strokeTolerance;
    }

    const rect = normalizeRect(annotation?.rect);

    if (annotation?.type === 'text')
        return pointInsideRect(target, rect);

    if (annotation?.type === 'rectangle') {
        if (annotation.fillColor !== null && pointInsideRect(target, rect))
            return true;

        const corners = [
            { x: rect.x, y: rect.y },
            { x: rect.x + rect.width, y: rect.y },
            { x: rect.x + rect.width, y: rect.y + rect.height },
            { x: rect.x, y: rect.y + rect.height },
        ];

        return corners.some((corner, index) => distanceToSegment(
            target,
            corner,
            corners[(index + 1) % corners.length],
            scale,
        ) <= strokeTolerance);
    }

    if (annotation?.type === 'ellipse') {
        const radiusX = rect.width / 2;
        const radiusY = rect.height / 2;

        if (radiusX <= Number.EPSILON || radiusY <= Number.EPSILON)
            return pointInsideRect(target, rect);

        const centerX = rect.x + radiusX;
        const centerY = rect.y + radiusY;
        const normalizedDistance = Math.hypot(
            (target.x - centerX) / radiusX,
            (target.y - centerY) / radiusY,
        );

        if (annotation.fillColor !== null && normalizedDistance <= 1)
            return true;

        const approximateBoundaryDistance = Math.abs(normalizedDistance - 1)
            * Math.min(radiusX * scale.x, radiusY * scale.y);
        return approximateBoundaryDistance <= strokeTolerance;
    }

    return false;
}

export function hitTestAnnotations(annotations, point, options = {}) {
    const source = Array.isArray(annotations) ? annotations : [];

    for (let index = source.length - 1; index >= 0; index--) {
        if (hitTestAnnotation(source[index], point, options))
            return source[index];
    }

    return null;
}

export function getResizeHandles(bounds) {
    const rect = normalizeRect(bounds);
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;

    return [
        { handle: 'north-west', point: { x: rect.x, y: rect.y } },
        { handle: 'north', point: { x: centerX, y: rect.y } },
        { handle: 'north-east', point: { x: rect.x + rect.width, y: rect.y } },
        { handle: 'east', point: { x: rect.x + rect.width, y: centerY } },
        {
            handle: 'south-east',
            point: { x: rect.x + rect.width, y: rect.y + rect.height },
        },
        { handle: 'south', point: { x: centerX, y: rect.y + rect.height } },
        { handle: 'south-west', point: { x: rect.x, y: rect.y + rect.height } },
        { handle: 'west', point: { x: rect.x, y: centerY } },
    ];
}

export function hitTestResizeHandle(bounds, point, options = {}) {
    const target = normalizePoint(point);
    const scale = metricScale(options);
    const tolerance = Math.max(0, finiteNumber(options.tolerance, 0.012));

    return getResizeHandles(bounds).find(({ point: handlePoint }) => (
        distanceBetween(target, handlePoint, scale) <= tolerance
    ))?.handle ?? null;
}

function constrainedTranslation(bounds, dx, dy) {
    const rect = normalizeRect(bounds);
    let adjustedX = finiteNumber(dx);
    let adjustedY = finiteNumber(dy);

    if (rect.width <= 1) {
        adjustedX = clamp(adjustedX, -rect.x, 1 - rect.x - rect.width);
    } else {
        adjustedX = clamp(adjustedX, 1 - rect.x - rect.width, -rect.x);
    }

    if (rect.height <= 1) {
        adjustedY = clamp(adjustedY, -rect.y, 1 - rect.y - rect.height);
    } else {
        adjustedY = clamp(adjustedY, 1 - rect.y - rect.height, -rect.y);
    }

    return { dx: adjustedX, dy: adjustedY };
}

export function mapAnnotationGeometry(annotation, pointMapper, options = {}) {
    const normalized = normalizeAnnotation(annotation, { id: annotation?.id });
    const mapPoint = (point) => normalizePoint(pointMapper(normalizePoint(point)));
    const styleScale = Math.max(0, finiteNumber(options.styleScale, 1));
    let mapped;

    if (normalized.type === 'pencil') {
        mapped = {
            ...normalized,
            points: normalized.points.map(mapPoint),
        };
    } else if (normalized.type === 'line' || normalized.type === 'arrow') {
        mapped = {
            ...normalized,
            start: mapPoint(normalized.start),
            end: mapPoint(normalized.end),
        };
    } else {
        const rect = normalized.rect;
        const corners = [
            mapPoint({ x: rect.x, y: rect.y }),
            mapPoint({ x: rect.x + rect.width, y: rect.y }),
            mapPoint({ x: rect.x + rect.width, y: rect.y + rect.height }),
            mapPoint({ x: rect.x, y: rect.y + rect.height }),
        ];
        const xs = corners.map((point) => point.x);
        const ys = corners.map((point) => point.y);
        mapped = {
            ...normalized,
            rect: {
                x: Math.min(...xs),
                y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
            },
        };
    }

    if ('strokeWidth' in mapped)
        mapped.strokeWidth *= styleScale;

    if ('fontSize' in mapped)
        mapped.fontSize *= styleScale;

    return mapped;
}

export function moveAnnotationGeometry(annotation, dx, dy, { clamp: shouldClamp = false } = {}) {
    let offsetX = finiteNumber(dx);
    let offsetY = finiteNumber(dy);

    if (shouldClamp) {
        const constrained = constrainedTranslation(
            getAnnotationBounds(annotation, { includeStroke: true }),
            offsetX,
            offsetY,
        );
        offsetX = constrained.dx;
        offsetY = constrained.dy;
    }

    return mapAnnotationGeometry(annotation, (point) => ({
        x: point.x + offsetX,
        y: point.y + offsetY,
    }));
}

export function resizeBounds(bounds, handle, dx, dy, options = {}) {
    const rect = normalizeRect(bounds);
    const normalizedHandle = String(handle ?? '').toLowerCase();

    if (!RESIZE_HANDLES.includes(normalizedHandle))
        throw new TypeError(`Unsupported resize handle: ${handle}`);

    const minimum = Math.max(MIN_NORMALIZED_SIZE, finiteNumber(options.minSize, 0.005));
    const movesWest = normalizedHandle.includes('west');
    const movesEast = normalizedHandle.includes('east');
    const movesNorth = normalizedHandle.includes('north');
    const movesSouth = normalizedHandle.includes('south');
    let left = rect.x;
    let right = rect.x + rect.width;
    let top = rect.y;
    let bottom = rect.y + rect.height;

    if (movesWest)
        left = Math.min(left + finiteNumber(dx), right - minimum);
    if (movesEast)
        right = Math.max(right + finiteNumber(dx), left + minimum);
    if (movesNorth)
        top = Math.min(top + finiteNumber(dy), bottom - minimum);
    if (movesSouth)
        bottom = Math.max(bottom + finiteNumber(dy), top + minimum);

    if (options.keepAspect && rect.width > 0 && rect.height > 0) {
        const ratio = rect.width / rect.height;

        if ((movesWest || movesEast) && (movesNorth || movesSouth)) {
            const candidateWidth = right - left;
            const candidateHeight = bottom - top;

            if (candidateWidth / candidateHeight > ratio) {
                const wantedHeight = candidateWidth / ratio;
                if (movesNorth)
                    top = bottom - wantedHeight;
                else
                    bottom = top + wantedHeight;
            } else {
                const wantedWidth = candidateHeight * ratio;
                if (movesWest)
                    left = right - wantedWidth;
                else
                    right = left + wantedWidth;
            }
        } else if (movesWest || movesEast) {
            const centerY = (top + bottom) / 2;
            const wantedHeight = (right - left) / ratio;
            top = centerY - wantedHeight / 2;
            bottom = centerY + wantedHeight / 2;
        } else {
            const centerX = (left + right) / 2;
            const wantedWidth = (bottom - top) * ratio;
            left = centerX - wantedWidth / 2;
            right = centerX + wantedWidth / 2;
        }
    }

    let resized = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };

    if (options.clamp)
        resized = clampRect(resized);

    return resized;
}

export function resizeAnnotationGeometry(annotation, oldBounds, newBounds, options = {}) {
    const source = normalizeRect(oldBounds ?? getAnnotationBounds(annotation));
    const target = normalizeRect(newBounds);
    const scaleX = source.width > MIN_NORMALIZED_SIZE
        ? target.width / source.width
        : 1;
    const scaleY = source.height > MIN_NORMALIZED_SIZE
        ? target.height / source.height
        : 1;
    const styleScale = options.scaleStyle
        ? Math.sqrt(Math.abs(scaleX * scaleY))
        : 1;

    return mapAnnotationGeometry(annotation, (point) => ({
        x: source.width > MIN_NORMALIZED_SIZE
            ? target.x + (point.x - source.x) * scaleX
            : point.x + target.x - source.x,
        y: source.height > MIN_NORMALIZED_SIZE
            ? target.y + (point.y - source.y) * scaleY
            : point.y + target.y - source.y,
    }), { styleScale });
}

function orientationMatrix(annotation) {
    const radians = finiteNumber(annotation?.rotation, 0) * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const scaleX = annotation?.flipX ? -1 : 1;
    const scaleY = annotation?.flipY ? -1 : 1;

    return {
        a: cosine * scaleX,
        b: -sine * scaleY,
        c: sine * scaleX,
        d: cosine * scaleY,
    };
}

function multiplyMatrices(left, right) {
    return {
        a: left.a * right.a + left.b * right.c,
        b: left.a * right.b + left.b * right.d,
        c: left.c * right.a + left.d * right.c,
        d: left.c * right.b + left.d * right.d,
    };
}

function normalizedDegrees(value) {
    const normalized = finiteNumber(value) % 360;
    return normalized < 0 ? normalized + 360 : normalized;
}

function decomposeOrientation(matrix) {
    const candidates = [];

    for (const rotation of [0, 90, 180, 270]) {
        for (const flipX of [false, true]) {
            for (const flipY of [false, true]) {
                const candidate = orientationMatrix({ rotation, flipX, flipY });
                const error = Math.abs(candidate.a - matrix.a)
                    + Math.abs(candidate.b - matrix.b)
                    + Math.abs(candidate.c - matrix.c)
                    + Math.abs(candidate.d - matrix.d);
                candidates.push({ rotation, flipX, flipY, error });
            }
        }
    }

    candidates.sort((first, second) => {
        const errorDifference = first.error - second.error;

        if (Math.abs(errorDifference) > 1e-12)
            return errorDifference;

        const firstFlips = Number(first.flipX) + Number(first.flipY);
        const secondFlips = Number(second.flipX) + Number(second.flipY);
        return firstFlips - secondFlips || first.rotation - second.rotation;
    });

    if (candidates[0].error < 1e-7) {
        const { rotation, flipX, flipY } = candidates[0];
        return { rotation, flipX, flipY };
    }

    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    const flipX = determinant < 0;
    const rotation = flipX
        ? Math.atan2(-matrix.c, -matrix.a) * 180 / Math.PI
        : Math.atan2(matrix.c, matrix.a) * 180 / Math.PI;

    return { rotation: normalizedDegrees(rotation), flipX, flipY: false };
}

export function transformTextOrientation(annotation, matrix) {
    if (annotation?.type !== 'text')
        return normalizeAnnotation(annotation, { id: annotation?.id });

    return {
        ...normalizeAnnotation(annotation, { id: annotation.id }),
        ...decomposeOrientation(multiplyMatrices(matrix, orientationMatrix(annotation))),
    };
}

export function remapAnnotationForCrop(annotation, cropRect, styleScale = 1) {
    const crop = normalizeCropRect(cropRect);
    return mapAnnotationGeometry(annotation, (point) => ({
        x: (point.x - crop.x) / crop.width,
        y: (point.y - crop.y) / crop.height,
    }), { styleScale });
}

export function rotateAnnotation(annotation, quarterTurn = 1) {
    const clockwise = finiteNumber(quarterTurn, 1) >= 0;
    const matrix = clockwise
        ? { a: 0, b: -1, c: 1, d: 0 }
        : { a: 0, b: 1, c: -1, d: 0 };
    let mapped = mapAnnotationGeometry(annotation, clockwise
        ? (point) => ({ x: 1 - point.y, y: point.x })
        : (point) => ({ x: point.y, y: 1 - point.x }));

    if (mapped.type === 'text')
        mapped = transformTextOrientation(mapped, matrix);

    return mapped;
}

export function flipAnnotation(annotation, axis = 'horizontal') {
    const normalizedAxis = String(axis).toLowerCase();

    if (normalizedAxis !== 'horizontal' && normalizedAxis !== 'vertical')
        throw new TypeError(`Unsupported flip axis: ${axis}`);

    const matrix = normalizedAxis === 'horizontal'
        ? { a: -1, b: 0, c: 0, d: 1 }
        : { a: 1, b: 0, c: 0, d: -1 };
    let mapped = mapAnnotationGeometry(annotation, normalizedAxis === 'horizontal'
        ? (point) => ({ x: 1 - point.x, y: point.y })
        : (point) => ({ x: point.x, y: 1 - point.y }));

    if (mapped.type === 'text')
        mapped = transformTextOrientation(mapped, matrix);

    return mapped;
}

function normalizeTransform(transform = {}) {
    const type = String(transform?.type ?? '').toLowerCase();

    if (type === 'crop') {
        return {
            type,
            rect: normalizeCropRect(transform.rect),
            sourceWidth: positiveDimension(transform.sourceWidth),
            sourceHeight: positiveDimension(transform.sourceHeight),
            outputWidth: positiveDimension(transform.outputWidth),
            outputHeight: positiveDimension(transform.outputHeight),
        };
    }

    if (type === 'rotate') {
        const rawQuarterTurns = Math.trunc(finiteNumber(transform.quarterTurns, 1));
        const moduloTurns = ((rawQuarterTurns % 4) + 4) % 4;

        return {
            type,
            quarterTurns: moduloTurns === 3 ? -1 : moduloTurns,
            sourceWidth: positiveDimension(transform.sourceWidth),
            sourceHeight: positiveDimension(transform.sourceHeight),
            outputWidth: positiveDimension(transform.outputWidth),
            outputHeight: positiveDimension(transform.outputHeight),
        };
    }

    if (type === 'flip') {
        const axis = String(transform.axis ?? '').toLowerCase();

        if (axis !== 'horizontal' && axis !== 'vertical')
            throw new TypeError(`Unsupported flip axis: ${transform.axis}`);

        return {
            type,
            axis,
            width: positiveDimension(transform.width),
            height: positiveDimension(transform.height),
        };
    }

    throw new TypeError(`Unsupported image transform: ${type || '(empty)'}`);
}

export function normalizeImageTransform(transform) {
    return normalizeTransform(transform);
}

export class ImageDocument {
    constructor(options = {}) {
        this.width = positiveDimension(options.width);
        this.height = positiveDimension(options.height);
        this.originalWidth = positiveDimension(options.originalWidth, this.width);
        this.originalHeight = positiveDimension(options.originalHeight, this.height);
        this.annotations = Array.isArray(options.annotations)
            ? options.annotations.map((annotation) => normalizeAnnotation(annotation))
            : [];
        this.transforms = Array.isArray(options.transforms)
            ? options.transforms.map(normalizeTransform)
            : [];
        this.selectionId = null;
        this.historyLimit = Math.max(
            1,
            Math.round(finiteNumber(options.historyLimit, MAX_HISTORY_ENTRIES)),
        );
        this._undoStack = [];
        this._redoStack = [];
        this._transaction = null;
        this._savedFingerprint = this._fingerprint();
    }

    static fromJSON(value = {}) {
        return new ImageDocument(value);
    }

    get selectedAnnotation() {
        return this.annotations.find((annotation) => annotation.id === this.selectionId) ?? null;
    }

    get outputWidth() {
        return this.width;
    }

    get outputHeight() {
        return this.height;
    }

    get canUndo() {
        return this._undoStack.length > 0 && !this._transaction;
    }

    get canRedo() {
        return this._redoStack.length > 0 && !this._transaction;
    }

    get undoDepth() {
        return this._undoStack.length;
    }

    get redoDepth() {
        return this._redoStack.length;
    }

    get inTransaction() {
        return Boolean(this._transaction);
    }

    get dirty() {
        return this._fingerprint() !== this._savedFingerprint;
    }

    _captureState() {
        return deepClone({
            width: this.width,
            height: this.height,
            annotations: this.annotations,
            transforms: this.transforms,
            selectionId: this.selectionId,
        });
    }

    _restoreState(state) {
        this.width = state.width;
        this.height = state.height;
        this.annotations = deepClone(state.annotations);
        this.transforms = deepClone(state.transforms);
        this.selectionId = state.selectionId;
        this._repairSelection();
    }

    _repairSelection() {
        if (this.selectionId
            && !this.annotations.some((annotation) => annotation.id === this.selectionId)) {
            this.selectionId = null;
        }
    }

    _fingerprint() {
        return stateFingerprint(this._captureState());
    }

    _pushUndo(state) {
        this._undoStack.push(state);

        if (this._undoStack.length > this.historyLimit)
            this._undoStack.splice(0, this._undoStack.length - this.historyLimit);
    }

    _mutate(callback) {
        const before = this._captureState();
        const beforeFingerprint = stateFingerprint(before);
        let result;

        try {
            result = callback();
            this._repairSelection();
        } catch (error) {
            this._restoreState(before);
            throw error;
        }

        const changed = beforeFingerprint !== this._fingerprint();

        if (changed && !this._transaction) {
            this._pushUndo(before);
            this._redoStack = [];
        }

        return changed ? result : false;
    }

    select(id = null) {
        if (id === null || id === undefined || id === '') {
            this.selectionId = null;
            return null;
        }

        const annotation = this.annotations.find((item) => item.id === String(id)) ?? null;
        this.selectionId = annotation?.id ?? null;
        return annotation;
    }

    addAnnotation(annotation) {
        let added = null;

        return this._mutate(() => {
            added = normalizeAnnotation(annotation);

            if (this.annotations.some((item) => item.id === added.id))
                added.id = createAnnotationId();

            this.annotations.push(added);
            this.selectionId = added.id;
            return added;
        });
    }

    updateAnnotation(id, patchOrUpdater) {
        const annotationId = String(id ?? '');
        const index = this.annotations.findIndex((annotation) => annotation.id === annotationId);

        if (index < 0)
            return false;

        return this._mutate(() => {
            const current = this.annotations[index];
            const update = typeof patchOrUpdater === 'function'
                ? patchOrUpdater(deepClone(current))
                : patchOrUpdater;

            if (!update || typeof update !== 'object')
                return current;

            const merged = {
                ...current,
                ...update,
                id: current.id,
                type: current.type,
            };

            for (const key of ['rect', 'start', 'end']) {
                if (update[key])
                    merged[key] = { ...current[key], ...update[key] };
            }

            this.annotations[index] = normalizeAnnotation(merged, { id: current.id });
            return this.annotations[index];
        });
    }

    deleteAnnotation(id = this.selectionId) {
        const annotationId = String(id ?? '');
        const index = this.annotations.findIndex((annotation) => annotation.id === annotationId);

        if (index < 0)
            return false;

        return this._mutate(() => {
            const [removed] = this.annotations.splice(index, 1);
            if (this.selectionId === annotationId)
                this.selectionId = null;
            return removed;
        });
    }

    duplicateAnnotation(id = this.selectionId, offset = { x: 0.02, y: 0.02 }) {
        const source = this.annotations.find((annotation) => annotation.id === String(id ?? ''));

        if (!source)
            return false;

        return this._mutate(() => {
            const duplicate = moveAnnotationGeometry({
                ...deepClone(source),
                id: createAnnotationId(),
            }, finiteNumber(offset?.x, 0.02), finiteNumber(offset?.y, 0.02), { clamp: true });
            this.annotations.push(duplicate);
            this.selectionId = duplicate.id;
            return duplicate;
        });
    }

    moveAnnotation(id, dx, dy, options = {}) {
        const annotationId = String(id ?? '');
        const index = this.annotations.findIndex((annotation) => annotation.id === annotationId);

        if (index < 0)
            return false;

        return this._mutate(() => {
            this.annotations[index] = moveAnnotationGeometry(
                this.annotations[index],
                dx,
                dy,
                options,
            );
            return this.annotations[index];
        });
    }

    resizeAnnotation(id, handle, dx, dy, options = {}) {
        const annotationId = String(id ?? '');
        const index = this.annotations.findIndex((annotation) => annotation.id === annotationId);

        if (index < 0)
            return false;

        return this._mutate(() => {
            const annotation = this.annotations[index];
            const oldBounds = getAnnotationBounds(annotation);
            const newBounds = resizeBounds(oldBounds, handle, dx, dy, options);
            this.annotations[index] = resizeAnnotationGeometry(
                annotation,
                oldBounds,
                newBounds,
                options,
            );
            return this.annotations[index];
        });
    }

    crop(rect) {
        const crop = normalizeCropRect(rect);

        if (approximatelyEqual(crop.x, 0)
            && approximatelyEqual(crop.y, 0)
            && approximatelyEqual(crop.width, 1)
            && approximatelyEqual(crop.height, 1)) {
            return false;
        }

        return this._mutate(() => {
            const sourceWidth = this.width;
            const sourceHeight = this.height;
            const outputWidth = Math.max(1, Math.round(sourceWidth * crop.width));
            const outputHeight = Math.max(1, Math.round(sourceHeight * crop.height));
            const sourceShorter = Math.min(sourceWidth, sourceHeight);
            const outputShorter = Math.min(outputWidth, outputHeight);
            const styleScale = sourceShorter / outputShorter;

            this.annotations = this.annotations
                .filter((annotation) => annotationIntersectsRect(annotation, crop))
                .map((annotation) => remapAnnotationForCrop(annotation, crop, styleScale));
            this.width = outputWidth;
            this.height = outputHeight;
            this.transforms.push({
                type: 'crop',
                rect: crop,
                sourceWidth,
                sourceHeight,
                outputWidth,
                outputHeight,
            });
            return crop;
        });
    }

    rotate(quarterTurns = 1) {
        const requestedTurns = Math.trunc(finiteNumber(quarterTurns, 1));

        if (requestedTurns === 0 || requestedTurns % 4 === 0)
            return false;

        const direction = requestedTurns < 0 ? -1 : 1;
        const steps = Math.abs(requestedTurns) % 4;

        return this._mutate(() => {
            for (let step = 0; step < steps; step++) {
                const sourceWidth = this.width;
                const sourceHeight = this.height;
                const outputWidth = sourceHeight;
                const outputHeight = sourceWidth;
                this.annotations = this.annotations.map((annotation) => (
                    rotateAnnotation(annotation, direction)
                ));
                this.width = outputWidth;
                this.height = outputHeight;
                this.transforms.push({
                    type: 'rotate',
                    quarterTurns: direction,
                    sourceWidth,
                    sourceHeight,
                    outputWidth,
                    outputHeight,
                });
            }

            return direction * steps;
        });
    }

    flip(axis = 'horizontal') {
        const normalizedAxis = String(axis).toLowerCase();

        if (normalizedAxis !== 'horizontal' && normalizedAxis !== 'vertical')
            throw new TypeError(`Unsupported flip axis: ${axis}`);

        return this._mutate(() => {
            this.annotations = this.annotations.map((annotation) => (
                flipAnnotation(annotation, normalizedAxis)
            ));
            this.transforms.push({
                type: 'flip',
                axis: normalizedAxis,
                width: this.width,
                height: this.height,
            });
            return normalizedAxis;
        });
    }

    beginTransaction(label = '') {
        if (this._transaction)
            return false;

        this._transaction = {
            label: String(label ?? ''),
            before: this._captureState(),
        };
        return true;
    }

    commitTransaction() {
        if (!this._transaction)
            return false;

        const transaction = this._transaction;
        this._transaction = null;
        const changed = stateFingerprint(transaction.before) !== this._fingerprint();

        if (changed) {
            this._pushUndo(transaction.before);
            this._redoStack = [];
        }

        return changed;
    }

    cancelTransaction() {
        if (!this._transaction)
            return false;

        const before = this._transaction.before;
        this._transaction = null;
        this._restoreState(before);
        return true;
    }

    undo() {
        if (!this.canUndo)
            return false;

        const previous = this._undoStack.pop();
        this._redoStack.push(this._captureState());
        this._restoreState(previous);
        return true;
    }

    redo() {
        if (!this.canRedo)
            return false;

        const next = this._redoStack.pop();
        this._pushUndo(this._captureState());
        this._restoreState(next);
        return true;
    }

    clearHistory() {
        if (this._transaction)
            this.cancelTransaction();
        this._undoStack = [];
        this._redoStack = [];
    }

    markSaved() {
        this._savedFingerprint = this._fingerprint();
        return this._savedFingerprint;
    }

    toJSON() {
        return deepClone({
            version: IMAGE_DOCUMENT_VERSION,
            originalWidth: this.originalWidth,
            originalHeight: this.originalHeight,
            width: this.width,
            height: this.height,
            annotations: this.annotations,
            transforms: this.transforms,
        });
    }
}
