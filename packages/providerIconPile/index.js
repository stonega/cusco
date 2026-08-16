import Matter from './matter.js';

const DEFAULT_MAX_PROVIDER_ICONS = 8;
const ICON_FLOOR_INSET = 4;
const MATTER_BASE_STEP_SECONDS = 1 / 120;
const MATTER_BASE_STEP_MILLISECONDS = MATTER_BASE_STEP_SECONDS * 1000;
const MAX_ELAPSED_SECONDS = 0.25;
const MAX_ARRANGE_STEPS = 8 * 120;
const BOUNDARY_THICKNESS = 256;
const WALL_TOP = -1024;
const MATTER_VELOCITY_SCALE = 60;
const MAX_HORIZONTAL_SPEED = 90 / MATTER_VELOCITY_SCALE;
const MAX_UPWARD_SPEED = 48 / MATTER_VELOCITY_SCALE;
const DROP_LANES = [0.28, 0.28, 0.28, 0.48, 0.68, 0.35, 0.58, 0.43];

const { Bodies, Body, Composite, Engine, Sleeping } = Matter;
const simulations = new WeakMap();

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

function normalizedAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function cardDimensions(width, height) {
    return {
        width: Math.max(1, Number(width) || 1),
        height: Math.max(1, Number(height) || 1),
    };
}

function createBoundaries(width, height) {
    const floorTop = height - ICON_FLOOR_INSET;
    const wallBottom = height + BOUNDARY_THICKNESS;
    const wallHeight = wallBottom - WALL_TOP;
    const wallCenterY = WALL_TOP + wallHeight / 2;
    const boundaryOptions = {
        isStatic: true,
        friction: 0.68,
        frictionStatic: 1,
        restitution: 0.05,
    };

    return [
        Bodies.rectangle(
            width / 2,
            floorTop + BOUNDARY_THICKNESS / 2,
            width + BOUNDARY_THICKNESS * 2,
            BOUNDARY_THICKNESS,
            { ...boundaryOptions, label: 'provider-icon-floor' },
        ),
        Bodies.rectangle(
            -BOUNDARY_THICKNESS / 2,
            wallCenterY,
            BOUNDARY_THICKNESS,
            wallHeight,
            { ...boundaryOptions, label: 'provider-icon-left-wall' },
        ),
        Bodies.rectangle(
            width + BOUNDARY_THICKNESS / 2,
            wallCenterY,
            BOUNDARY_THICKNESS,
            wallHeight,
            { ...boundaryOptions, label: 'provider-icon-right-wall' },
        ),
    ];
}

function createMatterBody(viewBody) {
    const physicsBody = Bodies.rectangle(
        viewBody.x + viewBody.size / 2,
        viewBody.y + viewBody.size / 2,
        viewBody.size,
        viewBody.size,
        {
            label: `provider-icon:${viewBody.providerId}`,
            density: 0.001,
            friction: 0.68,
            frictionAir: 0.035,
            frictionStatic: 1.2,
            restitution: 0.05,
            sleepThreshold: 45,
        },
    );

    Body.setAngle(physicsBody, Number(viewBody.angle) || 0);
    Body.setVelocity(physicsBody, {
        x: (Number(viewBody.vx) || 0) / MATTER_VELOCITY_SCALE,
        y: (Number(viewBody.vy) || 0) / MATTER_VELOCITY_SCALE,
    });
    Body.setAngularVelocity(
        physicsBody,
        (Number(viewBody.angularVelocity) || 0) / MATTER_VELOCITY_SCALE,
    );
    physicsBody.plugin.cuscoEnteredCard = physicsBody.bounds.min.y >= 0;

    return physicsBody;
}

function createSimulation(viewBodies, width, height) {
    const engine = Engine.create({
        enableSleeping: true,
        positionIterations: 10,
        velocityIterations: 8,
        constraintIterations: 4,
    });
    engine.gravity.x = 0;
    engine.gravity.y = 1;
    engine.gravity.scale = 0.001;

    const physicsBodies = viewBodies.map(createMatterBody);
    const boundaries = createBoundaries(width, height);
    Composite.add(engine.world, [...boundaries, ...physicsBodies]);

    return {
        engine,
        viewBodies: [...viewBodies],
        physicsBodies,
        boundaries,
        width,
        height,
    };
}

function simulationMatchesBodies(simulation, viewBodies) {
    return simulation.viewBodies.length === viewBodies.length
        && simulation.viewBodies.every((body, index) => body === viewBodies[index]);
}

function constrainBodyAfterResize(physicsBody, width, height) {
    const bodyWidth = physicsBody.bounds.max.x - physicsBody.bounds.min.x;
    let translationX = 0;

    if (bodyWidth > width)
        translationX = width / 2 - physicsBody.position.x;
    else if (physicsBody.bounds.min.x < 0)
        translationX = -physicsBody.bounds.min.x;
    else if (physicsBody.bounds.max.x > width)
        translationX = width - physicsBody.bounds.max.x;

    const floorTop = height - ICON_FLOOR_INSET;
    const translationY = physicsBody.bounds.max.y > floorTop
        ? floorTop - physicsBody.bounds.max.y
        : 0;

    if (translationX !== 0 || translationY !== 0)
        Body.translate(physicsBody, { x: translationX, y: translationY });

    Sleeping.set(physicsBody, false);
}

function resizeSimulation(simulation, width, height) {
    for (const boundary of simulation.boundaries)
        Composite.remove(simulation.engine.world, boundary);

    simulation.boundaries = createBoundaries(width, height);
    Composite.add(simulation.engine.world, simulation.boundaries);
    for (const physicsBody of simulation.physicsBodies)
        constrainBodyAfterResize(physicsBody, width, height);

    simulation.width = width;
    simulation.height = height;
}

function simulationFor(viewBodies, width, height) {
    let simulation = simulations.get(viewBodies);

    if (!simulation || !simulationMatchesBodies(simulation, viewBodies)) {
        simulation = createSimulation(viewBodies, width, height);
        simulations.set(viewBodies, simulation);
    } else if (simulation.width !== width || simulation.height !== height) {
        resizeSimulation(simulation, width, height);
    }

    return simulation;
}

function syncViewBodies(simulation) {
    for (let index = 0; index < simulation.viewBodies.length; index += 1) {
        const viewBody = simulation.viewBodies[index];
        const physicsBody = simulation.physicsBodies[index];
        const stopped = physicsBody.isSleeping;

        viewBody.x = physicsBody.position.x - viewBody.size / 2;
        viewBody.y = physicsBody.position.y - viewBody.size / 2;
        viewBody.angle = normalizedAngle(physicsBody.angle);
        viewBody.vx = stopped ? 0 : physicsBody.velocity.x * MATTER_VELOCITY_SCALE;
        viewBody.vy = stopped ? 0 : physicsBody.velocity.y * MATTER_VELOCITY_SCALE;
        viewBody.angularVelocity = stopped
            ? 0
            : physicsBody.angularVelocity * MATTER_VELOCITY_SCALE;
    }
}

function containSimulationBodies(simulation) {
    for (const physicsBody of simulation.physicsBodies) {
        if (physicsBody.bounds.min.y >= 0)
            physicsBody.plugin.cuscoEnteredCard = true;

        const bodyWidth = physicsBody.bounds.max.x - physicsBody.bounds.min.x;
        let translationX = 0;
        let translationY = 0;

        if (bodyWidth > simulation.width)
            translationX = simulation.width / 2 - physicsBody.position.x;
        else if (physicsBody.bounds.min.x < 0)
            translationX = -physicsBody.bounds.min.x;
        else if (physicsBody.bounds.max.x > simulation.width)
            translationX = simulation.width - physicsBody.bounds.max.x;

        if (physicsBody.plugin.cuscoEnteredCard && physicsBody.bounds.min.y < 0)
            translationY = -physicsBody.bounds.min.y;

        if (translationX !== 0 || translationY !== 0)
            Body.translate(physicsBody, { x: translationX, y: translationY });

        const velocity = {
            x: clamp(
                physicsBody.velocity.x,
                -MAX_HORIZONTAL_SPEED,
                MAX_HORIZONTAL_SPEED,
            ),
            y: Math.max(physicsBody.velocity.y, -MAX_UPWARD_SPEED),
        };

        if ((translationX < 0 && velocity.x > 0)
            || (translationX > 0 && velocity.x < 0)) {
            velocity.x = 0;
        }
        if (translationY > 0 && velocity.y < 0)
            velocity.y = 0;

        if (velocity.x !== physicsBody.velocity.x
            || velocity.y !== physicsBody.velocity.y) {
            Body.setVelocity(physicsBody, velocity);
        }
    }
}

function advanceSimulation(simulation, elapsedSeconds) {
    let remainingMilliseconds = clamp(
        Number(elapsedSeconds) || 0,
        0,
        MAX_ELAPSED_SECONDS,
    ) * 1000;

    while (remainingMilliseconds > 0.01) {
        const delta = Math.min(MATTER_BASE_STEP_MILLISECONDS, remainingMilliseconds);
        Engine.update(simulation.engine, delta);
        containSimulationBodies(simulation);
        remainingMilliseconds -= delta;
    }

    syncViewBodies(simulation);
    return simulation.physicsBodies.some((body) => !body.isSleeping);
}

function stopSimulation(simulation) {
    for (const physicsBody of simulation.physicsBodies) {
        Body.setVelocity(physicsBody, { x: 0, y: 0 });
        Body.setAngularVelocity(physicsBody, 0);
        Sleeping.set(physicsBody, true);
    }

    syncViewBodies(simulation);
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
        const lane = DROP_LANES[index % DROP_LANES.length];
        const launchCenter = cardWidth * lane;
        const launchOffset = (stableUnitValue(`${providerId}:${index}:x`) - 0.5) * 18;
        const horizontalDirection = stableUnitValue(`${providerId}:${index}:vx`) - 0.5;
        const angleDirection = stableUnitValue(`${providerId}:${index}:angle`) - 0.5;

        return {
            providerId,
            size,
            x: clamp(launchCenter - size / 2 + launchOffset, 0, maximumX),
            y: -size - index * (size * 0.48 + 9),
            vx: horizontalDirection * 24,
            vy: 10 + stableUnitValue(`${providerId}:${index}:vy`) * 30,
            angle: angleDirection * 0.72,
            angularVelocity: angleDirection * 1.6,
        };
    });
}

export function stepProviderIconBodies(bodies, width, height, elapsedSeconds) {
    if (!Array.isArray(bodies) || bodies.length === 0)
        return false;

    const dimensions = cardDimensions(width, height);
    const simulation = simulationFor(bodies, dimensions.width, dimensions.height);
    return advanceSimulation(simulation, elapsedSeconds);
}

export function arrangeProviderIconBodies(bodies, width, height) {
    if (!Array.isArray(bodies) || bodies.length === 0)
        return [];

    const dimensions = cardDimensions(width, height);
    const simulation = simulationFor(bodies, dimensions.width, dimensions.height);
    let moving = true;

    for (let step = 0; step < MAX_ARRANGE_STEPS && moving; step += 1)
        moving = advanceSimulation(simulation, MATTER_BASE_STEP_SECONDS);

    if (moving)
        stopSimulation(simulation);

    return bodies;
}
