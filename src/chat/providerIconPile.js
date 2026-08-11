const DEFAULT_MAX_PROVIDER_ICONS = 8;
const ICON_COLLISION_RADIUS_FACTOR = 0.44;
const ICON_GRAVITY = 980;
const ICON_FLOOR_INSET = 4;
const MAX_PHYSICS_STEP_SECONDS = 1 / 120;

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function stableUnitValue(value) {
    let hash = 2166136261;

    for (const character of String(value)) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0) / 0xffffffff;
}

export function providerIdsForUsageBreakdown(
    breakdown,
    maximum = DEFAULT_MAX_PROVIDER_ICONS,
) {
    const providerIds = [];
    const seen = new Set();
    const limit = Math.max(0, Math.floor(Number(maximum) || 0));

    if (limit === 0)
        return providerIds;

    for (const entry of Array.isArray(breakdown) ? breakdown : []) {
        const providerId = String(entry?.providerId ?? '').trim();

        if (!providerId || seen.has(providerId))
            continue;

        seen.add(providerId);
        providerIds.push(providerId);

        if (providerIds.length >= limit)
            break;
    }

    return providerIds;
}

export function createProviderIconBodies(providerIds, width) {
    const cardWidth = Math.max(1, Number(width) || 1);
    const ids = Array.isArray(providerIds) ? providerIds : [];

    return ids.map((providerId, index) => {
        const sizeVariation = stableUnitValue(`${providerId}:${index}:size`);
        const requestedSize = 34 + Math.round(sizeVariation * 8);
        const size = Math.min(requestedSize, cardWidth);
        const maximumX = Math.max(0, cardWidth - size);
        const x = stableUnitValue(`${providerId}:${index}:x`) * maximumX;
        const horizontalDirection = stableUnitValue(`${providerId}:${index}:vx`) - 0.5;
        const angleDirection = stableUnitValue(`${providerId}:${index}:angle`) - 0.5;

        return {
            providerId,
            size,
            x,
            y: -size - index * (size * 0.62 + 14),
            vx: horizontalDirection * 92,
            vy: 12 + stableUnitValue(`${providerId}:${index}:vy`) * 28,
            angle: angleDirection * 0.76,
            angularVelocity: angleDirection * 3.2,
        };
    });
}

function constrainBody(body, width, height, elapsedSeconds) {
    const maximumX = Math.max(0, width - body.size);
    const floorY = Math.max(0, height - ICON_FLOOR_INSET - body.size);

    if (body.x < 0) {
        body.x = 0;
        body.vx = Math.abs(body.vx) * 0.42;
        body.angularVelocity += body.vx * 0.012;
    } else if (body.x > maximumX) {
        body.x = maximumX;
        body.vx = -Math.abs(body.vx) * 0.42;
        body.angularVelocity += body.vx * 0.012;
    }

    if (body.y < floorY)
        return;

    body.y = floorY;
    if (body.vy > 24)
        body.vy *= -0.24;
    else
        body.vy = 0;

    const floorFriction = Math.pow(0.055, elapsedSeconds);
    body.vx *= floorFriction;
    body.angularVelocity *= Math.pow(0.025, elapsedSeconds);

    if (Math.abs(body.vx) < 0.45)
        body.vx = 0;
    if (Math.abs(body.angularVelocity) < 0.018)
        body.angularVelocity = 0;
}

function resolveBodyCollision(left, right) {
    const leftRadius = left.size * ICON_COLLISION_RADIUS_FACTOR;
    const rightRadius = right.size * ICON_COLLISION_RADIUS_FACTOR;
    const leftCenterX = left.x + left.size / 2;
    const leftCenterY = left.y + left.size / 2;
    const rightCenterX = right.x + right.size / 2;
    const rightCenterY = right.y + right.size / 2;
    let differenceX = rightCenterX - leftCenterX;
    let differenceY = rightCenterY - leftCenterY;
    let distance = Math.hypot(differenceX, differenceY);
    const minimumDistance = leftRadius + rightRadius;

    if (distance >= minimumDistance)
        return;

    if (distance < 0.001) {
        differenceX = stableUnitValue(`${left.providerId}:${right.providerId}`) < 0.5 ? -1 : 1;
        differenceY = 0;
        distance = 1;
    }

    const normalX = differenceX / distance;
    const normalY = differenceY / distance;
    const correction = (minimumDistance - distance) / 2;
    left.x -= normalX * correction;
    left.y -= normalY * correction;
    right.x += normalX * correction;
    right.y += normalY * correction;

    const relativeVelocityX = right.vx - left.vx;
    const relativeVelocityY = right.vy - left.vy;
    const normalVelocity = relativeVelocityX * normalX + relativeVelocityY * normalY;

    if (normalVelocity >= 0)
        return;

    const impulse = -(1 + 0.34) * normalVelocity / 2;
    left.vx -= impulse * normalX;
    left.vy -= impulse * normalY;
    right.vx += impulse * normalX;
    right.vy += impulse * normalY;

    const tangentX = -normalY;
    const tangentY = normalX;
    const tangentVelocity = relativeVelocityX * tangentX + relativeVelocityY * tangentY;
    const frictionImpulse = clamp(-tangentVelocity / 2, -impulse * 0.24, impulse * 0.24);
    left.vx -= frictionImpulse * tangentX;
    left.vy -= frictionImpulse * tangentY;
    right.vx += frictionImpulse * tangentX;
    right.vy += frictionImpulse * tangentY;
    left.angularVelocity -= frictionImpulse * 0.018;
    right.angularVelocity += frictionImpulse * 0.018;
}

function stepProviderIconBodiesOnce(bodies, width, height, elapsedSeconds) {
    for (const body of bodies) {
        body.vy += ICON_GRAVITY * elapsedSeconds;
        body.x += body.vx * elapsedSeconds;
        body.y += body.vy * elapsedSeconds;
        body.angle += body.angularVelocity * elapsedSeconds;
        constrainBody(body, width, height, elapsedSeconds);
    }

    for (let pass = 0; pass < 2; pass += 1) {
        for (let leftIndex = 0; leftIndex < bodies.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < bodies.length; rightIndex += 1)
                resolveBodyCollision(bodies[leftIndex], bodies[rightIndex]);
        }

        for (const body of bodies)
            constrainBody(body, width, height, elapsedSeconds);
    }
}

export function stepProviderIconBodies(bodies, width, height, elapsedSeconds) {
    if (!Array.isArray(bodies) || bodies.length === 0)
        return false;

    const cardWidth = Math.max(1, Number(width) || 1);
    const cardHeight = Math.max(1, Number(height) || 1);
    let remaining = clamp(Number(elapsedSeconds) || 0, 0, 0.25);

    while (remaining > 0) {
        const step = Math.min(MAX_PHYSICS_STEP_SECONDS, remaining);
        stepProviderIconBodiesOnce(bodies, cardWidth, cardHeight, step);
        remaining -= step;
    }

    return bodies.some((body) => {
        const floorY = Math.max(0, cardHeight - ICON_FLOOR_INSET - body.size);
        return body.y < floorY - 0.5
            || Math.abs(body.vx) > 0.5
            || Math.abs(body.vy) > 0.5
            || Math.abs(body.angularVelocity) > 0.02;
    });
}

export function arrangeProviderIconBodies(bodies, width, height) {
    if (!Array.isArray(bodies) || bodies.length === 0)
        return [];

    const cardWidth = Math.max(1, Number(width) || 1);
    const cardHeight = Math.max(1, Number(height) || 1);
    const gap = 4;
    const rows = [];
    let row = [];
    let rowWidth = 0;

    for (const body of [...bodies].sort((left, right) => left.x - right.x)) {
        const nextWidth = row.length === 0
            ? body.size
            : rowWidth + gap + body.size;

        if (row.length > 0 && nextWidth > cardWidth) {
            rows.push({ bodies: row, width: rowWidth });
            row = [];
            rowWidth = 0;
        }

        rowWidth += (row.length === 0 ? 0 : gap) + body.size;
        row.push(body);
    }

    if (row.length > 0)
        rows.push({ bodies: row, width: rowWidth });

    let rowBottom = cardHeight - ICON_FLOOR_INSET;
    for (const packedRow of rows) {
        const rowHeight = Math.max(...packedRow.bodies.map((body) => body.size));
        let x = Math.max(0, (cardWidth - packedRow.width) / 2);

        for (const body of packedRow.bodies) {
            body.x = clamp(x, 0, Math.max(0, cardWidth - body.size));
            body.y = clamp(rowBottom - body.size, 0, Math.max(0, cardHeight - body.size));
            body.vx = 0;
            body.vy = 0;
            body.angularVelocity = 0;
            x += body.size + gap;
        }

        rowBottom -= rowHeight + gap;
    }

    return bodies;
}
