export const KNOT_ICON_VIEWBOX_WIDTH = 903;
export const KNOT_ICON_VIEWBOX_HEIGHT = 414;
export const KNOT_ICON_STROKE_WIDTH = 35;
export const KNOT_ICON_ANIMATION_SECONDS = 1;

const KNOT_ICON_SAMPLE_STEPS = 28;
const KNOT_ICON_CURVES = [
    [15, 219.379, 56.5, 207.379, 186.6, 201.8, 431, 259],
    [431, 259, 736.5, 330.5, 706.5, 70.3797, 706.5, 70.3797],
    [706.5, 70.3797, 659.7, -11.2203, 510, 15.0463, 441, 38.3797],
    [441, 38.3797, 441, 38.3797, 376.641, 62.7237, 343, 89.8799],
    [343, 89.8799, 307.145, 118.823, 268.5, 181.38, 268.5, 181.38],
    [268.5, 181.38, 169.3, 339.38, 278.5, 394.667, 359.5, 398.5],
    [359.5, 398.5, 440.5, 402.333, 483, 301, 483, 301],
    [483, 301, 483, 301, 505.689, 221.851, 532.5, 181.38],
    [532.5, 181.38, 566.79, 129.62, 598.134, 103.051, 656.5, 81.8799],
    [656.5, 81.8799, 708.53, 63.0069, 742.856, 69.1365, 798, 73.8799],
    [798, 73.8799, 833.375, 76.9228, 887.5, 89.8799, 887.5, 89.8799],
];

let knotIconPath = null;

function cubicPoint(curve, t) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = curve;
    const inverse = 1 - t;
    const inverse2 = inverse * inverse;
    const t2 = t * t;

    return {
        x: inverse2 * inverse * x0 + 3 * inverse2 * t * x1 + 3 * inverse * t2 * x2 + t2 * t * x3,
        y: inverse2 * inverse * y0 + 3 * inverse2 * t * y1 + 3 * inverse * t2 * y2 + t2 * t * y3,
    };
}

function getKnotIconPath() {
    if (knotIconPath)
        return knotIconPath;

    const points = [];
    for (const curve of KNOT_ICON_CURVES) {
        if (points.length === 0)
            points.push({ x: curve[0], y: curve[1] });
        for (let step = 1; step <= KNOT_ICON_SAMPLE_STEPS; step++)
            points.push(cubicPoint(curve, step / KNOT_ICON_SAMPLE_STEPS));
    }

    let totalLength = 0;
    for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1];
        const current = points[index];
        totalLength += Math.hypot(current.x - previous.x, current.y - previous.y);
    }
    knotIconPath = { points, totalLength };
    return knotIconPath;
}

export function mirrorProgress(value) {
    const phase = value % 2;
    return phase <= 1 ? phase : 2 - phase;
}

export function drawKnotIconPath(cr, progress) {
    const { points, totalLength } = getKnotIconPath();
    const targetLength = Math.max(0, Math.min(1, progress)) * totalLength;

    if (points.length === 0 || targetLength <= 0)
        return;

    cr.moveTo(points[0].x, points[0].y);
    let walkedLength = 0;
    for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1];
        const current = points[index];
        const segmentLength = Math.hypot(current.x - previous.x, current.y - previous.y);

        if (walkedLength + segmentLength <= targetLength) {
            cr.lineTo(current.x, current.y);
            walkedLength += segmentLength;
            continue;
        }

        const remaining = targetLength - walkedLength;
        const ratio = segmentLength === 0 ? 0 : remaining / segmentLength;
        cr.lineTo(
            previous.x + (current.x - previous.x) * ratio,
            previous.y + (current.y - previous.y) * ratio,
        );
        break;
    }
    cr.stroke();
}
