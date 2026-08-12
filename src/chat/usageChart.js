export const DAILY_USAGE_CHART_PADDING = Object.freeze({
    top: 14,
    right: 8,
    bottom: 10,
    left: 8,
});

export function easeOutCubic(progress) {
    const clampedProgress = Math.min(1, Math.max(0, Number(progress) || 0));
    return 1 - ((1 - clampedProgress) ** 3);
}

export function revealDailyUsageChartPoints(points, height, progress) {
    if (!Array.isArray(points) || points.length === 0)
        return [];

    const baseline = Math.max(
        DAILY_USAGE_CHART_PADDING.top + 1,
        (Number(height) || 0) - DAILY_USAGE_CHART_PADDING.bottom,
    );
    const clampedProgress = Math.min(1, Math.max(0, Number(progress) || 0));

    return points.map((point) => ({
        ...point,
        y: baseline + ((point.y - baseline) * clampedProgress),
    }));
}

export function buildDailyUsageCurveSegments(points) {
    if (!Array.isArray(points) || points.length < 2)
        return [];

    const segments = [];
    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const point = points[index];
        const midpointX = (previous.x + point.x) / 2;
        segments.push({
            control1X: midpointX,
            control1Y: previous.y,
            control2X: midpointX,
            control2Y: point.y,
            endX: point.x,
            endY: point.y,
        });
    }
    return segments;
}

export function dailyUsageIndexAtX(daily, width, x) {
    if (!Array.isArray(daily) || daily.length === 0)
        return -1;

    const chartWidth = Math.max(
        1,
        width - DAILY_USAGE_CHART_PADDING.left - DAILY_USAGE_CHART_PADDING.right,
    );
    const chartX = Math.min(
        chartWidth,
        Math.max(0, (Number(x) || 0) - DAILY_USAGE_CHART_PADDING.left),
    );
    return daily.length === 1
        ? 0
        : Math.round((chartX / chartWidth) * (daily.length - 1));
}

export function shouldKeepDailyUsageTooltipVisible(
    chartContainsPointer,
    tooltipContainsPointer,
) {
    return Boolean(chartContainsPointer || tooltipContainsPointer);
}

export function buildDailyUsageChartPoints(daily, width, height) {
    if (!Array.isArray(daily) || daily.length === 0)
        return [];

    const chartWidth = Math.max(
        1,
        width - DAILY_USAGE_CHART_PADDING.left - DAILY_USAGE_CHART_PADDING.right,
    );
    const chartHeight = Math.max(
        1,
        height - DAILY_USAGE_CHART_PADDING.top - DAILY_USAGE_CHART_PADDING.bottom,
    );
    const values = daily.map((entry) => Math.max(0, Number(entry?.totalTokens) || 0));
    const maximum = Math.max(
        1,
        ...values,
    );

    return values.map((value, index) => ({
        x: DAILY_USAGE_CHART_PADDING.left + (daily.length === 1
            ? chartWidth / 2
            : (chartWidth * index) / (daily.length - 1)),
        y: DAILY_USAGE_CHART_PADDING.top + chartHeight - ((value / maximum) * chartHeight),
        value,
    }));
}

export function dailyUsageDateLabelIndices(length, maximumLabelCount = 7) {
    const entryCount = Math.max(0, Math.floor(Number(length) || 0));
    if (entryCount === 0)
        return [];

    const labelCount = Math.min(
        entryCount,
        Math.max(2, Math.floor(Number(maximumLabelCount) || 0)),
    );
    if (labelCount === 1)
        return [0];

    return Array.from(
        { length: labelCount },
        (_value, index) => Math.round((index * (entryCount - 1)) / (labelCount - 1)),
    );
}
