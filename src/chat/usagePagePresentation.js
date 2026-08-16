import Cairo from 'cairo';
import GLib from 'gi://GLib?version=2.0';

import {
    buildDailyUsageChartPoints,
    buildDailyUsageCurveSegments,
    DAILY_USAGE_CHART_PADDING,
    revealDailyUsageChartPoints,
} from './usageChart.js';

export function formatStatisticCount(value) {
    return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('en-US');
}

export function formatStatisticNoun(count, singular, plural = `${singular}s`) {
    return `${formatStatisticCount(count)} ${count === 1 ? singular : plural}`;
}

export function formatUsageNumberMarkup(value) {
    return String(value ?? '')
        .split(/(\d+)/)
        .map((part) => /^\d+$/.test(part)
            ? `<span font_family="monospace">${part}</span>`
            : GLib.markup_escape_text(part, -1))
        .join('');
}

export function setUsageNumberLabel(label, value) {
    label.set_markup(formatUsageNumberMarkup(value));
}

function appendDailyUsageCurve(cr, segments) {
    for (const segment of segments) {
        cr.curveTo(
            segment.control1X,
            segment.control1Y,
            segment.control2X,
            segment.control2Y,
            segment.endX,
            segment.endY,
        );
    }
}

export function drawDailyUsageChart(
    cr,
    width,
    height,
    daily,
    color,
    hoveredIndex = -1,
    revealProgress = 1,
) {
    const padding = DAILY_USAGE_CHART_PADDING;
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const baseline = padding.top + chartHeight;
    const points = revealDailyUsageChartPoints(
        buildDailyUsageChartPoints(daily, width, height),
        height,
        revealProgress,
    );

    cr.save();
    cr.setLineWidth(1);
    cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha * 0.12);

    for (let index = 0; index <= 3; index += 1) {
        const y = padding.top + ((chartHeight / 3) * index);
        cr.moveTo(padding.left, y);
        cr.lineTo(padding.left + chartWidth, y);
    }
    cr.stroke();

    if (points.length === 0) {
        cr.restore();
        return;
    }

    if (points.some((point) => point.value > 0)) {
        const curveSegments = buildDailyUsageCurveSegments(points);

        cr.moveTo(points[0].x, baseline);
        cr.lineTo(points[0].x, points[0].y);
        appendDailyUsageCurve(cr, curveSegments);
        cr.lineTo(points.at(-1).x, baseline);
        cr.closePath();
        cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha * 0.16);
        cr.fill();

        cr.setLineWidth(2);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(points[0].x, points[0].y);
        appendDailyUsageCurve(cr, curveSegments);
        cr.setSourceRGBA(color.red, color.green, color.blue, Math.max(0.72, color.alpha));
        cr.stroke();
    }

    const hoveredPoint = points[hoveredIndex];
    if (hoveredPoint) {
        cr.setLineWidth(1);
        cr.setSourceRGBA(color.red, color.green, color.blue, Math.max(0.38, color.alpha * 0.5));
        cr.moveTo(hoveredPoint.x, padding.top);
        cr.lineTo(hoveredPoint.x, baseline);
        cr.stroke();
        cr.arc(hoveredPoint.x, hoveredPoint.y, 4, 0, Math.PI * 2);
        cr.setSourceRGBA(color.red, color.green, color.blue, Math.max(0.9, color.alpha));
        cr.fill();
    }
    cr.restore();
}

const USAGE_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
});

export function formatUsageDate(date) {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) ? USAGE_DATE_FORMATTER.format(parsed) : '';
}

export function clearContainer(container) {
    let child = container?.get_first_child?.();
    while (child) {
        const next = child.get_next_sibling();
        container.remove(child);
        child = next;
    }
}
