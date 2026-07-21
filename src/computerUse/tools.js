import {
    COMPUTER_USE_ACTION_NAMES,
    COMPUTER_USE_WINDOW_ACTION_NAMES,
    createComputerUseError,
    hasComputerUseCoordinates,
    hasUnsafeComputerUsePointerInputBatch,
    isComputerUseTextInputAction,
    MAX_COMPUTER_USE_STEP_ACTIONS,
    validateComputerUseAction,
    validateComputerUseStepActions,
} from './protocol.js';

function userError(message) {
    return createComputerUseError(message, { kind: 'input' });
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

const DEFAULT_STEP_SETTLE_MS = 250;

function isPrimaryCoordinateClick(action) {
    return action?.action === 'click'
        && (action.button === undefined || action.button === 'left')
        && Number.isFinite(action.x)
        && Number.isFinite(action.y);
}

function isUnpositionedTextInput(action) {
    return isComputerUseTextInputAction(action)
        && action.x === undefined
        && action.y === undefined;
}

function isSelectAllKeypress(action) {
    if (action?.action !== 'keypress' || !Array.isArray(action.keys) || action.keys.length !== 2)
        return false;

    const keys = action.keys.map(key => String(key ?? '').trim().toUpperCase());
    return keys.includes('A') && keys.some(key => key === 'CTRL' || key === 'CONTROL');
}

function atomicTextInputFromPointerInput(actions) {
    if (!Array.isArray(actions) || ![2, 3].includes(actions.length))
        return { actions, normalization: null };

    const [click, middle, last] = actions;
    const replacing = actions.length === 3;
    const textInput = replacing ? last : middle;

    if (!isPrimaryCoordinateClick(click)
        || !isUnpositionedTextInput(textInput)
        || (replacing && !isSelectAllKeypress(middle))) {
        return { actions, normalization: null };
    }

    const atomicTextInput = {
        ...textInput,
        x: click.x,
        y: click.y,
    };

    for (const property of ['windowId', 'observationId', 'coordinateSpace']) {
        if (click[property] !== undefined)
            atomicTextInput[property] = click[property];
    }

    if (replacing)
        atomicTextInput.replace = true;

    return {
        actions: [atomicTextInput],
        normalization: {
            requestedActions: actions.map(action => action?.action ?? ''),
            performedActions: [textInput.action],
            mode: replacing ? 'replace' : 'insert',
        },
    };
}

function actionProperties(actionNames = COMPUTER_USE_ACTION_NAMES) {
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
        replace: { type: 'boolean' },
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
            description: 'Perform one or more bounded actions on one observed window, wait briefly, and return the updated screenshot plus semantic, coordinate, change, and stall feedback. Before coordinate input, Cusco passively checks that the referenced UI is still visible and focused; stale UI is returned without dispatching the action. After a click produces a localized visual change such as a popup, Cusco may return one automatically enlarged region image; the returned observation ID and coordinates are local to that crop. Prefer accessibility refs when available. Visual coordinates are normalized 0..1000 in the attached full or region grid. Prefer paste_text for non-sensitive text because it copies the complete value to the clipboard and pastes it atomically; use type for sensitive values or fields that reject paste. Either text input action may include x and y to focus a visual field, with replace:true selecting its existing text first. Common click-then-input and click-then-Ctrl+A-then-input calls are normalized to those atomic forms. Other explicit coordinate click and keyboard batches remain unsafe. For small targets or a blocked retry, use computer_observe_region. Coordinate actions that navigate or enter input should include an expect entry when accessibility is available.',
            inputDescription: 'JSON: {"windowId":"ID","observationId":"latest full or region observation ID","actions":[{"action":"click","x":480,"y":280}],"settleMs":250}. For an inaccessible visual text field, prefer exactly one atomic action: {"action":"paste_text","x":480,"y":280,"text":"value","replace":true}; omit replace for an empty field. Use type with the same fields for sensitive values or when paste is rejected. Semantic actions include click_element {ref} and set_text_element {ref,text}; other actions include keypress, maximize, move_to_workspace, scroll, and drag. Arbitrary explicit click and keyboard batches are rejected. All visual coordinates are normalized 0..1000. Maximum 8 actions.',
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
                        maxItems: MAX_COMPUTER_USE_STEP_ACTIONS,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['action'],
                            properties: {
                                ...actionProperties(COMPUTER_USE_WINDOW_ACTION_NAMES),
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
                    || args.actions.length > MAX_COMPUTER_USE_STEP_ACTIONS) {
                    throw userError(`computer_step requires 1 to ${MAX_COMPUTER_USE_STEP_ACTIONS} actions.`);
                }

                const normalizedInput = atomicTextInputFromPointerInput(args.actions);
                const requestedActions = normalizedInput.actions;

                if (hasUnsafeComputerUsePointerInputBatch(requestedActions)) {
                    throw userError(
                        'computer_step cannot safely batch these coordinate click and keyboard actions. Use one coordinate-targeted paste_text or type action, add replace:true when replacing existing field text, or click and inspect before a later keyboard step.',
                    );
                }

                const invalidCoordinateType = requestedActions.some(action => (
                    isComputerUseTextInputAction(action)
                    && (action.x !== undefined || action.y !== undefined)
                    && (!Number.isFinite(action.x) || !Number.isFinite(action.y))
                ));

                if (invalidCoordinateType) {
                    throw userError(
                        'A coordinate-targeted text input action requires both x and y as finite numbers.',
                    );
                }
                const invalidReplace = requestedActions.some(action => (
                    action?.replace !== undefined
                    && (typeof action.replace !== 'boolean'
                        || !isComputerUseTextInputAction(action)
                        || (action.replace === true
                            && (!Number.isFinite(action.x) || !Number.isFinite(action.y))))
                ));

                if (invalidReplace) {
                    throw userError(
                        'replace is only supported as a boolean on a coordinate-targeted text input action with both x and y.',
                    );
                }

                const actions = requestedActions.map((action) => ({
                    ...action,
                    windowId,
                    observationId: args.observationId,
                    coordinateSpace: hasComputerUseCoordinates(action)
                        ? 'normalized_1000'
                        : action.coordinateSpace,
                }));
                validateComputerUseStepActions(actions, {
                    expectedWindowId: windowId,
                    unsafeBatchMessage: 'computer_step cannot safely batch these coordinate click and keyboard actions. Use one coordinate-targeted paste_text or type action, add replace:true when replacing existing field text, or click and inspect before a later keyboard step.',
                });
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
                    || (isComputerUseTextInputAction(action)
                        && action.x !== undefined
                        && action.y !== undefined)
                ));
                stepResult.verification = {
                    ...stepResult.verification,
                    coordinateActionVerified: hasCoordinateTarget
                        && !stepResult.failed
                        && expectations.length > 0
                        ? stepResult.verification?.expectationsMet === true
                        : null,
                    visualConfirmationRequired: hasCoordinateTarget
                        && !stepResult.failed
                        && expectations.length === 0,
                };
                let instruction = 'The post-action screenshot is attached. Check it and the verification fields before continuing or claiming success.';

                if (stepResult.failure?.kind === 'stale_observation') {
                    instruction = 'The visible UI changed or lost focus before coordinate input could be dispatched. No coordinate action was sent. Replan from the attached fresh screenshot and use its new observationId.';
                } else if (stepResult.failed) {
                    const completed = Number(stepResult.completedActionCount) || 0;
                    const failureMessage = stepResult.failure?.message ?? 'The step failed.';
                    instruction = completed > 0
                        ? `${completed} earlier action${completed === 1 ? '' : 's'} completed before this step failed: ${failureMessage} Do not retry the entire batch. Inspect the post-action screenshot and continue from the current state.`
                        : `The step failed before any action was confirmed: ${failureMessage} Correct the failed action before retrying. Inspect the post-action screenshot when attached because the attempted action may still have changed the application.`;
                } else if (stepResult.verification.visualStateCycleDetected) {
                    instruction = stepResult.autoZoom?.applied
                        ? 'The UI repeated an alternating visual-state cycle, so full-window coordinate retries are blocked. The attached image is an automatically enlarged view of the current localized state. Use its local coordinates and returned observationId to select a visible option; do not click the popup trigger again.'
                        : 'The UI repeated an alternating visual-state cycle, so coordinate retries are blocked. Do not repeat the same open/close actions; use accessibility, keyboard navigation, a fresh observation, or ask the user for help.';
                } else if (stepResult.autoZoom?.applied) {
                    instruction = 'A click produced a localized visual change, so the attached image is an automatically enlarged crop of the current state. Coordinates are local from 0 to 1000; use the returned observationId to select a visible option without clicking the trigger again.';
                } else if (stepResult.verification.stalled) {
                    instruction = stepResult.verification.coordinateRetryBlocked
                        ? 'The screen did not change after repeated coordinate steps, so full-window coordinate retries are blocked. Use computer_observe_region, accessibility, keyboard navigation, or ask the user for help.'
                        : 'The screen did not change after repeated steps. Do not retry the same target or coordinates; use a different strategy.';
                } else if (expectations.length > 0
                    && stepResult.verification.expectationsMet !== true) {
                    instruction = 'The post-action screenshot is attached, but the expected target state was not found. Do not treat the action as successful; inspect the screen and change strategy.';
                } else if (hasCoordinateTarget && expectations.length === 0) {
                    instruction = 'The post-action screenshot is attached and visualConfirmationRequired is true because no semantic expectation was available. This does not mean the action failed. Inspect the new UI state; if the intended result is visibly present, continue from it.';
                }
                const transcript = {
                    ...stepResult,
                    observation,
                    ...(normalizedInput.normalization
                        ? { actionNormalization: normalizedInput.normalization }
                        : {}),
                    instruction,
                };
                return {
                    ...observation,
                    ...stepResult,
                    ...(normalizedInput.normalization
                        ? { actionNormalization: normalizedInput.normalization }
                        : {}),
                    output: formatted(transcript),
                };
            },
        },
        {
            name: 'computer_act',
            label: 'Control GNOME desktop',
            description: 'Perform one bounded desktop action without returning a screenshot. Use create_workspace before launching an app, then maximize or move its window as needed. Global paste_text, type, and keypress actions may omit windowId so an app can be launched on the active empty workspace. Prefer paste_text for non-sensitive text and type for sensitive values or fields that reject paste. Prefer computer_step for subsequent window actions. Coordinate actions should specify screenshot_pixels or normalized_1000 explicitly.',
            inputDescription: 'JSON with action. Supported: create_workspace; switch_workspace {workspaceIndex}; move_to_workspace {windowId,workspaceIndex}; maximize {windowId}; focus {windowId}; click/double_click/move {windowId,x,y,coordinateSpace,button?}; paste_text/type {text,windowId?,x?,y?,coordinateSpace?,replace?}; keypress {keys:["CTRL","L"],windowId?}; scroll {windowId,x,y,coordinateSpace,deltaX?,deltaY?}; drag {windowId,x,y,endX,endY,coordinateSpace}. replace:true requires a coordinate-targeted text input action.',
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

                validateComputerUseAction(args, { label: 'computer_act' });
                const result = await service.act(args, options);
                return { result, output: formatted(result) };
            },
        },
    ];
}
