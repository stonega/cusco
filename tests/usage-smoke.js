import {
    estimateConversationUsage,
    estimateTokenCount,
    summarizeConversationStatistics,
    summarizeUsageDashboard,
} from '../src/chat/usage.js';
import {
    buildDailyUsageChartPoints,
    buildDailyUsageCurveSegments,
    dailyUsageDateLabelIndices,
    dailyUsageIndexAtX,
    easeOutCubic,
    revealDailyUsageChartPoints,
    shouldKeepDailyUsageTooltipVisible,
} from '../src/chat/usageChart.js';
import { customProviderIconSpec } from '../src/providers/providerIconAvatar.js';
import {
    arrangeProviderIconBodies,
    createProviderIconBodies,
    providerIdsForUsageBreakdown,
    stepProviderIconBodies,
} from '../src/chat/providerIconPile.js';

if (estimateTokenCount('') !== 0)
    throw new Error('Empty text should estimate to zero tokens');

if (estimateTokenCount('hello') !== 2)
    throw new Error(`Unexpected token estimate for short text: ${estimateTokenCount('hello')}`);

const usage = estimateConversationUsage([
    { content: 'hello' },
    { content: 'world!' },
]);

if (usage.messages !== 2 || usage.tokens !== 4 || usage.characters !== 11)
    throw new Error(`Unexpected conversation usage: ${JSON.stringify(usage)}`);

const statistics = summarizeConversationStatistics([
    { role: 'user', content: 'First prompt' },
    {
        role: 'assistant',
        content: 'First answer',
        usage: {
            inputTokens: 7129883,
            cachedInputTokens: 6776832,
            outputTokens: 30013,
            totalTokens: 7159896,
        },
    },
    {
        role: 'system',
        toolCall: {
            status: 'completed',
            output: 'Done',
        },
    },
    {
        role: 'system',
        toolCall: {
            status: 'running',
        },
    },
]);

if (statistics.totalMessages !== 4
    || statistics.userMessages !== 1
    || statistics.assistantMessages !== 1
    || statistics.toolCalls !== 2
    || statistics.toolResults !== 1) {
    throw new Error(`Unexpected message statistics: ${JSON.stringify(statistics)}`);
}

if (statistics.inputTokens !== 7129883
    || statistics.cachedInputTokens !== 6776832
    || statistics.uncachedInputTokens !== 353051
    || statistics.outputTokens !== 30013
    || statistics.totalTokens !== 7159896) {
    throw new Error(`Unexpected token statistics: ${JSON.stringify(statistics)}`);
}

const separateCacheStatistics = summarizeConversationStatistics([{
    role: 'assistant',
    usage: {
        inputTokens: 12,
        outputTokens: 14,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 5,
        totalTokens: 26,
    },
}]);

if (separateCacheStatistics.inputTokens !== 19
    || separateCacheStatistics.cachedInputTokens !== 5
    || separateCacheStatistics.uncachedInputTokens !== 14
    || separateCacheStatistics.totalTokens !== 33) {
    throw new Error(
        `Unexpected separate cache statistics: ${JSON.stringify(separateCacheStatistics)}`,
    );
}

const totalOnlyStatistics = summarizeConversationStatistics([{
    role: 'assistant',
    usage: {
        totalTokens: 42,
    },
}]);

if (totalOnlyStatistics.totalTokens !== 42)
    throw new Error(`Total-only usage was lost: ${JSON.stringify(totalOnlyStatistics)}`);

const localTimestamp = (year, month, day, hour = 12) => (
    new Date(year, month - 1, day, hour).toISOString()
);
const dashboard = summarizeUsageDashboard([
    {
        id: 'chat-openai',
        providerId: 'openai',
        modelId: 'gpt-5',
        messages: [
            {
                role: 'assistant',
                createdAt: localTimestamp(2026, 8, 9, 5),
                usage: {
                    inputTokens: 120,
                    cachedInputTokens: 80,
                    outputTokens: 30,
                    totalTokens: 150,
                },
            },
            {
                role: 'assistant',
                createdAt: localTimestamp(2026, 8, 8, 5),
                usage: {
                    inputTokens: 50,
                    outputTokens: 10,
                    totalTokens: 60,
                    providerId: 'anthropic',
                    modelId: 'claude-sonnet',
                },
            },
            {
                role: 'assistant',
                createdAt: localTimestamp(2026, 7, 1, 5),
                usage: {
                    inputTokens: 999,
                    outputTokens: 999,
                    totalTokens: 1998,
                },
            },
        ],
    },
    {
        id: 'chat-unreported',
        providerId: 'gemini',
        modelId: 'gemini-pro',
        messages: [{
            role: 'assistant',
            createdAt: localTimestamp(2026, 8, 7, 5),
            content: 'No provider usage metadata',
        }],
    },
], {
    days: 7,
    now: new Date(2026, 7, 9, 12),
});

if (dashboard.days !== 7
    || dashboard.daily.length !== 7
    || dashboard.totalTokens !== 210
    || dashboard.inputTokens !== 170
    || dashboard.cachedInputTokens !== 80
    || dashboard.uncachedInputTokens !== 90
    || dashboard.outputTokens !== 40
    || dashboard.reportedMessages !== 2
    || dashboard.assistantMessages !== 3
    || dashboard.conversationCount !== 2
    || dashboard.providerCount !== 2
    || dashboard.modelCount !== 2) {
    throw new Error(`Unexpected dashboard totals: ${JSON.stringify(dashboard)}`);
}

if (dashboard.breakdown.length !== 2
    || dashboard.breakdown[0].providerId !== 'openai'
    || dashboard.breakdown[0].totalTokens !== 150
    || dashboard.breakdown[1].providerId !== 'anthropic'
    || dashboard.breakdown[1].totalTokens !== 60) {
    throw new Error(`Unexpected dashboard breakdown: ${JSON.stringify(dashboard.breakdown)}`);
}

const identityDashboard = summarizeUsageDashboard([{
    id: 'chat-identities',
    messages: [
        ['openai', 'gpt-5'],
        ['openai', 'gpt-5'],
        ['openai', 'gpt-4.1'],
        ['anthropic', 'claude-sonnet'],
    ].map(([providerId, modelId]) => ({
        role: 'assistant',
        createdAt: localTimestamp(2026, 8, 9, 5),
        usage: {
            providerId,
            modelId,
            totalTokens: 1,
        },
    })),
}], {
    days: 1,
    now: new Date(2026, 7, 9, 12),
});

if (identityDashboard.providerCount !== 2 || identityDashboard.modelCount !== 3) {
    throw new Error(
        `Provider/model counts should use unique identities: ${JSON.stringify(identityDashboard)}`,
    );
}

if (dashboard.daily.at(-1).date !== '2026-08-09'
    || dashboard.daily.at(-1).totalTokens !== 150
    || dashboard.daily.at(-2).totalTokens !== 60) {
    throw new Error(`Unexpected dashboard daily series: ${JSON.stringify(dashboard.daily)}`);
}

const chartDaily = [
    { date: '2026-08-07', totalTokens: 10 },
    { date: '2026-08-08', totalTokens: 20 },
    { date: '2026-08-09', totalTokens: 30 },
];

const chartHitCases = [
    [-100, 0],
    [8, 0],
    [32, 0],
    [33, 1],
    [58, 1],
    [82, 1],
    [83, 2],
    [108, 2],
    [1000, 2],
];
for (const [x, expectedIndex] of chartHitCases) {
    const actual = dailyUsageIndexAtX(chartDaily, 116, x);
    if (actual !== expectedIndex)
        throw new Error(`Unexpected chart index at x=${x}: ${actual}`);
}

if (dailyUsageIndexAtX(chartDaily, 116, 8) !== 0
    || dailyUsageIndexAtX(chartDaily, 116, 58) !== 1
    || dailyUsageIndexAtX(chartDaily, 116, 108) !== 2
    || dailyUsageIndexAtX([], 116, 58) !== -1) {
    throw new Error('Chart hover indices should track the nearest date across the full plot width');
}

if (!shouldKeepDailyUsageTooltipVisible(true, false)
    || !shouldKeepDailyUsageTooltipVisible(false, true)
    || shouldKeepDailyUsageTooltipVisible(false, false)) {
    throw new Error('Chart tooltip should stay visible across chart-to-tooltip pointer handoffs');
}

const chartGeometry = buildDailyUsageChartPoints(chartDaily, 116, 84);
const middleChartPoint = chartGeometry[1];
if (middleChartPoint?.x !== 58 || middleChartPoint?.y !== 34
    || middleChartPoint?.value !== 20
    || buildDailyUsageChartPoints([], 116, 84).length !== 0) {
    throw new Error(`Unexpected hovered chart point: ${JSON.stringify(middleChartPoint)}`);
}

const hiddenChartGeometry = revealDailyUsageChartPoints(chartGeometry, 84, 0);
const halfwayChartGeometry = revealDailyUsageChartPoints(
    chartGeometry,
    84,
    easeOutCubic(0.5),
);
const revealedChartGeometry = revealDailyUsageChartPoints(chartGeometry, 84, 1);
if (hiddenChartGeometry.some((point) => point.y !== 74)
    || halfwayChartGeometry[1]?.y !== 39
    || revealedChartGeometry[1]?.y !== middleChartPoint.y
    || easeOutCubic(0) !== 0
    || easeOutCubic(0.5) !== 0.875
    || easeOutCubic(1) !== 1) {
    throw new Error('Chart reveal should ease from the baseline to its final geometry');
}

const denseDateIndices = dailyUsageDateLabelIndices(30);
if (denseDateIndices.length !== 7
    || denseDateIndices[0] !== 0
    || denseDateIndices.at(-1) !== 29
    || dailyUsageDateLabelIndices(7).join(',') !== '0,1,2,3,4,5,6'
    || dailyUsageDateLabelIndices(0).length !== 0) {
    throw new Error(`Unexpected chart date label density: ${JSON.stringify(denseDateIndices)}`);
}

const chartPoints = [
    { x: 8, y: 70 },
    { x: 58, y: 20 },
    { x: 108, y: 60 },
];
const curveSegments = buildDailyUsageCurveSegments(chartPoints);
if (curveSegments.length !== 2
    || buildDailyUsageCurveSegments([]).length !== 0
    || buildDailyUsageCurveSegments([chartPoints[0]]).length !== 0) {
    throw new Error(`Unexpected curve segment count: ${JSON.stringify(curveSegments)}`);
}

for (let index = 0; index < curveSegments.length; index += 1) {
    const previous = chartPoints[index];
    const point = chartPoints[index + 1];
    const segment = curveSegments[index];
    const minY = Math.min(previous.y, point.y);
    const maxY = Math.max(previous.y, point.y);
    const midpointX = (previous.x + point.x) / 2;
    const yValues = [segment.control1Y, segment.control2Y, segment.endY];

    if (segment.control1X !== midpointX
        || segment.control2X !== midpointX
        || segment.endX !== point.x
        || segment.endY !== point.y
        || yValues.some((value) => value < minY || value > maxY)) {
        throw new Error(`Curve segment overshot its endpoints: ${JSON.stringify(segment)}`);
    }
}

const pileProviderIds = providerIdsForUsageBreakdown([
    { providerId: 'openai', modelId: 'gpt-5' },
    { providerId: 'openai', modelId: 'gpt-4.1' },
    { providerId: '' },
    { providerId: 'anthropic', modelId: 'claude-sonnet' },
]);
if (pileProviderIds.join(',') !== 'openai,anthropic') {
    throw new Error(
        `Provider icon pile should use unique non-empty providers: ${pileProviderIds}`,
    );
}
if (providerIdsForUsageBreakdown([{ providerId: 'openai' }], 0).length !== 0)
    throw new Error('Provider icon pile should honor a zero-icon limit');

const customProviderIcon = customProviderIconSpec({
    id: 'openai-compatible-renamed',
    name: '  renamed API  ',
    customizable: true,
});
const repeatedCustomProviderIcon = customProviderIconSpec({
    id: 'openai-compatible-renamed',
    name: 'Renamed API',
    customizable: true,
});
if (customProviderIcon?.initial !== 'R'
    || JSON.stringify(customProviderIcon.background)
        !== JSON.stringify(repeatedCustomProviderIcon.background)
    || customProviderIconSpec({
        id: 'openai-compatible-unicode',
        name: '  深度 API',
        customizable: true,
    })?.initial !== '深'
    || customProviderIconSpec({
        id: 'openai-compatible-uppercase-expansion',
        name: 'ßystem',
        customizable: true,
    })?.initial !== 'S'
    || customProviderIconSpec({ id: 'openai', name: 'OpenAI' }) !== null) {
    throw new Error(
        `Custom provider icon should use a stable name initial: ${
            JSON.stringify(customProviderIcon)
        }`,
    );
}

const fallingBodies = createProviderIconBodies(pileProviderIds, 220);
if (fallingBodies.length !== 2
    || fallingBodies.some((body) => body.y >= 0)
    || fallingBodies.some((body) => body.x < 0 || body.x + body.size > 220)) {
    throw new Error(`Provider icons should begin above and within the card: ${JSON.stringify(fallingBodies)}`);
}

const initialY = fallingBodies[0].y;
stepProviderIconBodies(fallingBodies, 220, 250, 0.2);
if (fallingBodies[0].y <= initialY) {
    throw new Error(`Gravity should move provider icons downward: ${JSON.stringify(fallingBodies[0])}`);
}

const paintedBounds = (body) => {
    const halfSize = body.size / 2;
    const halfExtent = halfSize * (
        Math.abs(Math.cos(body.angle)) + Math.abs(Math.sin(body.angle))
    );
    const centerX = body.x + halfSize;
    const centerY = body.y + halfSize;

    return {
        left: centerX - halfExtent,
        right: centerX + halfExtent,
        top: centerY - halfExtent,
        bottom: centerY + halfExtent,
    };
};

const projectedBodyRange = (body, axis) => {
    const halfSize = body.size / 2;
    const centerX = body.x + halfSize;
    const centerY = body.y + halfSize;
    const localX = { x: Math.cos(body.angle), y: Math.sin(body.angle) };
    const localY = { x: -localX.y, y: localX.x };
    const center = centerX * axis.x + centerY * axis.y;
    const radius = halfSize * (
        Math.abs(localX.x * axis.x + localX.y * axis.y)
        + Math.abs(localY.x * axis.x + localY.y * axis.y)
    );

    return { minimum: center - radius, maximum: center + radius };
};

const providerBodiesOverlap = (left, right) => {
    const axes = [left.angle, right.angle].flatMap((angle) => [
        { x: Math.cos(angle), y: Math.sin(angle) },
        { x: -Math.sin(angle), y: Math.cos(angle) },
    ]);

    return axes.every((axis) => {
        const leftRange = projectedBodyRange(left, axis);
        const rightRange = projectedBodyRange(right, axis);
        const overlap = Math.min(leftRange.maximum, rightRange.maximum)
            - Math.max(leftRange.minimum, rightRange.minimum);

        return overlap > 0.5;
    });
};

arrangeProviderIconBodies(fallingBodies, 220, 250);
if (Math.abs(Math.max(...fallingBodies.map((body) => paintedBounds(body).bottom)) - 246) > 0.5)
    throw new Error(`Provider icons should settle just inside the card edge: ${JSON.stringify(fallingBodies)}`);

for (const body of fallingBodies) {
    const bounds = paintedBounds(body);

    if (bounds.left < -0.5
        || bounds.right > 220.5
        || bounds.top < -0.5
        || bounds.bottom > 250.5
        || Math.abs(body.vx) > 0.01
        || Math.abs(body.vy) > 0.01
        || Math.abs(body.angularVelocity) > 0.01) {
        throw new Error(`Settled provider icon escaped the card: ${JSON.stringify(body)}`);
    }
}

arrangeProviderIconBodies(fallingBodies, 130, 180);
for (const body of fallingBodies) {
    const bounds = paintedBounds(body);

    if (bounds.left < -0.5
        || bounds.right > 130.5
        || bounds.top < -0.5
        || bounds.bottom > 180.5) {
        throw new Error(`Resized provider icon pile escaped the card: ${JSON.stringify(body)}`);
    }
}

if (providerBodiesOverlap(fallingBodies[0], fallingBodies[1])) {
    throw new Error(`Settled provider icons should not overlap: ${JSON.stringify(fallingBodies)}`);
}

const animatedProviderIds = [
    'openai-compatible',
    'gemini',
    'kimi',
    'openai',
    'deepseek',
    'anthropic',
    'grok',
    'zai',
];

for (const cardWidth of [456, 320, 220, 130]) {
    const animatedBodies = createProviderIconBodies(animatedProviderIds, cardWidth);
    const enteredBodies = new Set();
    let animatedBodiesMoving = true;
    for (let frame = 0; frame < 8 * 120 && animatedBodiesMoving; frame += 1) {
        animatedBodiesMoving = stepProviderIconBodies(
            animatedBodies,
            cardWidth,
            294,
            1 / 120,
        );

        for (const body of animatedBodies) {
            const bounds = paintedBounds(body);

            if (bounds.top >= -0.5)
                enteredBodies.add(body);
            if (bounds.left < -0.5
                || bounds.right > cardWidth + 0.5
                || (enteredBodies.has(body) && bounds.top < -0.5)) {
                throw new Error(
                    `Provider icon escaped during its drop at ${cardWidth}px: ${
                        JSON.stringify(body)
                    }`,
                );
            }
            if (Math.abs(body.vx) > 90.5 || body.vy < -48.5) {
                throw new Error(
                    `Provider icon retained too much rebound energy: ${JSON.stringify(body)}`,
                );
            }
        }
    }

    if (animatedBodiesMoving) {
        throw new Error(
            `Provider icon drop should reach a stable resting state at ${cardWidth}px: ${
                JSON.stringify(animatedBodies)
            }`,
        );
    }

    for (const body of animatedBodies) {
        const bounds = paintedBounds(body);

        if (bounds.left < -0.5
            || bounds.right > cardWidth + 0.5
            || bounds.top < -0.5
            || bounds.bottom > 294.5
            || Math.abs(body.vx) > 0.01
            || Math.abs(body.vy) > 0.01
            || Math.abs(body.angularVelocity) > 0.01) {
            throw new Error(
                `Dropped provider icon should finish at rest inside the card: ${JSON.stringify(body)}`,
            );
        }
    }

    for (let leftIndex = 0; leftIndex < animatedBodies.length; leftIndex += 1) {
        const left = animatedBodies[leftIndex];

        for (let rightIndex = leftIndex + 1; rightIndex < animatedBodies.length; rightIndex += 1) {
            const right = animatedBodies[rightIndex];
            if (providerBodiesOverlap(left, right)) {
                throw new Error(
                    `Dropped provider icons should not overlap at ${cardWidth}px: ${
                        JSON.stringify([left, right])
                    }`,
                );
            }
        }
    }

    if (cardWidth >= 320 && !animatedBodies.some((body) => (
        paintedBounds(body).bottom < 294 - 4 - 4
    ))) {
        throw new Error(
            `Provider-icon physics should retain a visible pile at ${cardWidth}px: ${
                JSON.stringify(animatedBodies)
            }`,
        );
    }
}

const densePileBodies = createProviderIconBodies(
    ['openai-compatible', 'gemini', 'kimi', 'grok', 'deepseek'],
    456,
);
let densePileMoving = true;
for (let frame = 0; frame < 8 * 120 && densePileMoving; frame += 1) {
    densePileMoving = stepProviderIconBodies(
        densePileBodies,
        456,
        294,
        1 / 120,
    );
}
const densePileLeft = Math.min(...densePileBodies.map((body) => paintedBounds(body).left));
const densePileRight = Math.max(...densePileBodies.map((body) => paintedBounds(body).right));
if (densePileMoving || densePileRight - densePileLeft > 456 * 0.68) {
    throw new Error(
        `Provider icons should settle into a compact pile: ${JSON.stringify(densePileBodies)}`,
    );
}

const collisionBodies = [
    {
        providerId: 'collision-left',
        size: 40,
        x: 75,
        y: 80,
        vx: 60,
        vy: 0,
        angle: 0,
        angularVelocity: 0,
    },
    {
        providerId: 'collision-right',
        size: 40,
        x: 125,
        y: 80,
        vx: -60,
        vy: 0,
        angle: 0,
        angularVelocity: 0,
    },
];
for (let step = 0; step < 20; step += 1)
    stepProviderIconBodies(collisionBodies, 220, 250, 1 / 120);
if (collisionBodies[0].vx >= 0 || collisionBodies[1].vx <= 0) {
    throw new Error(`Provider icons should bounce off each other: ${JSON.stringify(collisionBodies)}`);
}

print('Cusco usage smoke passed');
