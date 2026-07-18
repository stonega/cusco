function userError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
}

function parseObject(input, label, { allowEmpty = false } = {}) {
    const source = String(input ?? '').trim();

    if (!source && allowEmpty)
        return {};

    try {
        const value = JSON.parse(source);

        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('expected an object');

        return value;
    } catch (error) {
        throw userError(`${label} expects a JSON object: ${error.message}.`);
    }
}

function formatted(value) {
    return JSON.stringify(value, null, 2);
}

const OBJECT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {},
};

const ACTION_NAMES = [
    'create_workspace',
    'focus',
    'maximize',
    'move_to_workspace',
    'click_element',
    'set_text_element',
    'click',
    'double_click',
    'move',
    'type',
    'keypress',
    'scroll',
    'drag',
    'switch_workspace',
];
const DESKTOP_ACTION_NAMES = new Set(['create_workspace', 'switch_workspace']);
const WINDOW_ACTION_NAMES = ACTION_NAMES.filter(action => !DESKTOP_ACTION_NAMES.has(action));
const MAX_STEP_ACTIONS = 8;
const DEFAULT_STEP_SETTLE_MS = 250;
const CLICK_ACTION_NAMES = new Set(['click', 'double_click']);
const FOLLOWUP_INPUT_ACTION_NAMES = new Set(['type', 'keypress']);

function hasUnsafePointerInputBatch(actions) {
    const coordinateTypes = actions.filter(action => action?.action === 'type'
        && (action.x !== undefined || action.y !== undefined));

    if (coordinateTypes.length > 0 && actions.length !== 1)
        return true;

    const clickIndex = actions.findIndex(action => CLICK_ACTION_NAMES.has(action?.action));
    return clickIndex >= 0
        && actions.slice(clickIndex + 1).some(action => FOLLOWUP_INPUT_ACTION_NAMES.has(action?.action));
}

function actionProperties(actionNames = ACTION_NAMES) {
    return {
        action: {
            type: 'string',
            enum: actionNames,
        },
        windowId: { type: 'string' },
        workspaceIndex: { type: 'integer', minimum: 0 },
        observationId: { type: 'string' },
        ref: { type: 'string' },
        coordinateSpace: {
            type: 'string',
            enum: ['screenshot_pixels', 'normalized_1000'],
        },
        x: { type: 'number' },
        y: { type: 'number' },
        endX: { type: 'number' },
        endY: { type: 'number' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        text: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' }, minItems: 1 },
    };
}

export function createComputerUseTools(service) {
    return [
        {
            name: 'computer_list',
            label: 'List desktop windows',
            description: 'List GNOME workspaces and controllable application windows on this Wayland desktop.',
            inputDescription: 'An empty JSON object: {}.',
            inputSchema: OBJECT_SCHEMA,
            permissionPolicy: 'ask',
            concurrencySafe: false,
            async run(input, options) {
                parseObject(input, 'computer_list', { allowEmpty: true });
                const desktop = await service.listDesktop(options);
                return { desktop, output: formatted(desktop) };
            },
        },
        {
            name: 'computer_observe',
            label: 'Observe desktop window',
            description: 'Focus and capture one GNOME window for initial inspection. The screenshot and both pixel and normalized coordinate spaces are returned. Prefer computer_step for subsequent actions because it automatically returns the updated screenshot.',
            inputDescription: 'JSON: {"windowId":"ID from computer_list"}.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['windowId'],
                properties: {
                    windowId: { type: 'string', description: 'Window ID returned by computer_list.' },
                },
            },
            permissionPolicy: 'ask',
            concurrencySafe: false,
            async run(input, options) {
                const args = parseObject(input, 'computer_observe');

                if (!String(args.windowId ?? '').trim())
                    throw userError('computer_observe requires windowId.');

                const observation = await service.observe(args.windowId, options);
                const transcript = {
                    ...observation,
                    imagePath: observation.imagePath,
                    instruction: 'The attached model image has a synthetic normalized coordinate grid. Grid labels and lines are not part of the application. Prefer accessibility refs and computer_step. Bounds are null when the application reports unreliable geometry; use the ref or keyboard navigation instead of inventing coordinates. For small visual targets, request computer_observe_region before clicking. Values run from 0 to 1000.',
                };
                return {
                    ...observation,
                    output: formatted(transcript),
                };
            },
        },
        {
            name: 'computer_observe_region',
            label: 'Zoom into desktop window region',
            description: 'Create an enlarged, gridded visual view of a region from the latest window observation without recapturing the application. Use this for small targets or after an unchanged coordinate click. The returned observation ID makes subsequent computer_step coordinates local to the enlarged region.',
            inputDescription: 'JSON: {"windowId":"ID","observationId":"latest full or region observation ID","region":{"x":350,"y":150,"width":300,"height":300}}. Region values are normalized 0..1000 relative to the referenced image and must remain inside it.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['windowId', 'observationId', 'region'],
                properties: {
                    windowId: { type: 'string' },
                    observationId: { type: 'string' },
                    region: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['x', 'y', 'width', 'height'],
                        properties: {
                            x: { type: 'number', minimum: 0, maximum: 980 },
                            y: { type: 'number', minimum: 0, maximum: 980 },
                            width: { type: 'number', minimum: 20, maximum: 1000 },
                            height: { type: 'number', minimum: 20, maximum: 1000 },
                        },
                    },
                },
            },
            permissionPolicy: 'ask',
            concurrencySafe: false,
            async run(input) {
                const args = parseObject(input, 'computer_observe_region');
                const windowId = String(args.windowId ?? '').trim();
                const observationId = String(args.observationId ?? '').trim();

                if (!windowId || !observationId)
                    throw userError('computer_observe_region requires windowId and observationId.');

                const observation = await service.observeRegion(
                    windowId,
                    observationId,
                    args.region,
                );
                const transcript = {
                    ...observation,
                    instruction: 'The attached image is an enlarged synthetic-grid view. Coordinates in the next computer_step are local to this region and normalized from 0 to 1000; Cusco maps them back to the full window. Do not manually add the region offset.',
                };
                return {
                    ...observation,
                    output: formatted(transcript),
                };
            },
        },
        {
            name: 'computer_step',
            label: 'Act and observe desktop window',
            description: 'Perform one or more bounded actions on one observed window, wait briefly, and return the updated screenshot plus semantic, coordinate, change, and stall feedback. Prefer accessibility refs when available. Visual coordinates are normalized 0..1000 in the attached full or region grid. A single type action may include x and y to focus an empty visual text field and type atomically. Never batch an explicit coordinate click with typing or key presses. For small targets or a blocked retry, use computer_observe_region. Coordinate actions that navigate or enter input should include an expect entry when accessibility is available.',
            inputDescription: 'JSON: {"windowId":"ID","observationId":"latest full or region observation ID","actions":[{"action":"click","x":480,"y":280}],"settleMs":250}. For an inaccessible empty text field, use exactly one atomic action: {"action":"type","x":480,"y":280,"text":"value"}. Semantic actions include click_element {ref} and set_text_element {ref,text}; other actions include type, keypress, maximize, move_to_workspace, scroll, and drag. Never combine an explicit click with keyboard input. All visual coordinates are normalized 0..1000. Maximum 8 actions.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['windowId', 'observationId', 'actions'],
                properties: {
                    windowId: { type: 'string' },
                    observationId: { type: 'string' },
                    actions: {
                        type: 'array',
                        minItems: 1,
                        maxItems: MAX_STEP_ACTIONS,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['action'],
                            properties: {
                                ...actionProperties(WINDOW_ACTION_NAMES),
                                x: { type: 'number', minimum: 0, maximum: 1000 },
                                y: { type: 'number', minimum: 0, maximum: 1000 },
                                endX: { type: 'number', minimum: 0, maximum: 1000 },
                                endY: { type: 'number', minimum: 0, maximum: 1000 },
                            },
                        },
                    },
                    expect: {
                        type: 'array',
                        maxItems: 8,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['state'],
                            properties: {
                                role: { type: 'string' },
                                name: { type: 'string' },
                                state: {
                                    type: 'string',
                                    enum: ['present', 'absent', 'enabled', 'editable', 'focused', 'value_equals', 'value_contains'],
                                },
                                value: { type: 'string' },
                            },
                        },
                    },
                    settleMs: { type: 'integer', minimum: 0, maximum: 2000 },
                    waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 2000 },
                },
            },
            permissionPolicy: 'ask',
            concurrencySafe: false,
            async run(input, options) {
                const args = parseObject(input, 'computer_step');
                const windowId = String(args.windowId ?? '').trim();

                if (!windowId)
                    throw userError('computer_step requires windowId.');

                if (!String(args.observationId ?? '').trim())
                    throw userError('computer_step requires the latest observationId.');

                if (!Array.isArray(args.actions)
                    || args.actions.length === 0
                    || args.actions.length > MAX_STEP_ACTIONS) {
                    throw userError(`computer_step requires 1 to ${MAX_STEP_ACTIONS} actions.`);
                }

                if (hasUnsafePointerInputBatch(args.actions)) {
                    throw userError(
                        'computer_step cannot batch an explicit coordinate click with typing or key presses. Use one coordinate-targeted type action for an empty visual field, or click and inspect before a later keyboard step.',
                    );
                }

                const incompleteCoordinateType = args.actions.some(action => (
                    action?.action === 'type'
                    && ((action.x === undefined) !== (action.y === undefined))
                ));

                if (incompleteCoordinateType) {
                    throw userError(
                        'A coordinate-targeted type action requires both x and y.',
                    );
                }

                const actions = args.actions.map((action) => ({
                    ...action,
                    windowId,
                    observationId: args.observationId,
                    coordinateSpace: 'normalized_1000',
                }));
                const expectations = Array.isArray(args.expect) ? args.expect : [];
                const step = await service.step(actions, {
                    ...options,
                    settleMs: args.settleMs ?? DEFAULT_STEP_SETTLE_MS,
                    waitTimeoutMs: args.waitTimeoutMs ?? 0,
                    expectations,
                });
                const { observation, ...stepResult } = step;
                const hasCoordinateTarget = actions.some(action => (
                    action.action === 'click'
                    || action.action === 'double_click'
                    || (action.action === 'type'
                        && action.x !== undefined
                        && action.y !== undefined)
                ));
                stepResult.verification = {
                    ...stepResult.verification,
                    coordinateActionVerified: hasCoordinateTarget
                        ? expectations.length > 0
                            && stepResult.verification?.expectationsMet === true
                        : null,
                };
                let instruction = 'The post-action screenshot is attached. Check it and the verification fields before continuing or claiming success.';

                if (stepResult.verification.stalled) {
                    instruction = stepResult.verification.coordinateRetryBlocked
                        ? 'The screen did not change after repeated coordinate steps, so full-window coordinate retries are blocked. Use computer_observe_region, accessibility, keyboard navigation, or ask the user for help.'
                        : 'The screen did not change after repeated steps. Do not retry the same target or coordinates; use a different strategy.';
                } else if (expectations.length > 0
                    && stepResult.verification.expectationsMet !== true) {
                    instruction = 'The post-action screenshot is attached, but the expected target state was not found. Do not treat the action as successful; inspect the screen and change strategy.';
                } else if (hasCoordinateTarget && expectations.length === 0) {
                    instruction = 'The post-action screenshot is attached, but this coordinate-targeted action had no semantic expectation and remains visually unverified. Inspect the intended target and any entered value before continuing; prefer a named ref or keyboard navigation when available.';
                }
                const transcript = {
                    ...stepResult,
                    observation,
                    instruction,
                };
                return {
                    ...observation,
                    ...stepResult,
                    output: formatted(transcript),
                };
            },
        },
        {
            name: 'computer_act',
            label: 'Control GNOME desktop',
            description: 'Perform one bounded desktop action without returning a screenshot. Use create_workspace before launching an app, then maximize or move its window as needed. Global type and keypress actions may omit windowId so an app can be launched on the active empty workspace. Prefer computer_step for subsequent window actions. Coordinate actions should specify screenshot_pixels or normalized_1000 explicitly.',
            inputDescription: 'JSON with action. Supported: create_workspace; switch_workspace {workspaceIndex}; move_to_workspace {windowId,workspaceIndex}; maximize {windowId}; focus {windowId}; click/double_click/move {windowId,x,y,coordinateSpace,button?}; type {text,windowId?,x?,y?,coordinateSpace?}; keypress {keys:["CTRL","L"],windowId?}; scroll {windowId,x,y,coordinateSpace,deltaX?,deltaY?}; drag {windowId,x,y,endX,endY,coordinateSpace}.',
            inputSchema: {
                type: 'object',
                additionalProperties: true,
                required: ['action'],
                properties: actionProperties(),
            },
            permissionPolicy: 'ask',
            concurrencySafe: false,
            async run(input, options) {
                const args = parseObject(input, 'computer_act');

                if (!String(args.action ?? '').trim())
                    throw userError('computer_act requires action.');

                const result = await service.act(args, options);
                return { result, output: formatted(result) };
            },
        },
    ];
}
