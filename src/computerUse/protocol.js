export const COMPUTER_USE_ACTION_NAMES = Object.freeze([
    'create_workspace',
    'focus',
    'maximize',
    'move_to_workspace',
    'click_element',
    'set_text_element',
    'click',
    'double_click',
    'move',
    'paste_text',
    'type',
    'keypress',
    'scroll',
    'drag',
    'switch_workspace',
]);
export const COMPUTER_USE_DESKTOP_ACTION_NAMES = Object.freeze([
    'create_workspace',
    'switch_workspace',
]);
export const COMPUTER_USE_WINDOW_ACTION_NAMES = Object.freeze(
    COMPUTER_USE_ACTION_NAMES.filter(action => !COMPUTER_USE_DESKTOP_ACTION_NAMES.includes(action)),
);
export const MAX_COMPUTER_USE_STEP_ACTIONS = 8;
export const MAX_COMPUTER_USE_TYPE_CHARACTERS = 10_000;
export const MAX_COMPUTER_USE_KEYPRESS_KEYS = 16;

const COORDINATE_ACTION_NAMES = new Set(['click', 'double_click', 'move', 'scroll', 'drag']);
const CLICK_ACTION_NAMES = new Set(['click', 'double_click']);
const TEXT_INPUT_ACTION_NAMES = new Set(['paste_text', 'type']);
const FOLLOWUP_INPUT_ACTION_NAMES = new Set([...TEXT_INPUT_ACTION_NAMES, 'keypress']);
const WINDOW_REQUIRED_ACTION_NAMES = new Set([
    'focus',
    'maximize',
    'move_to_workspace',
    'click',
    'double_click',
    'move',
    'scroll',
    'drag',
]);
const COORDINATE_SPACES = new Set([
    'normalized',
    'normalized_1000',
    'screenshot_pixels',
]);
const POINTER_BUTTON_NAMES = new Set(['left', 'middle', 'right']);
const SUPPORTED_KEYPRESS_NAMES = new Set([
    'CTRL',
    'CONTROL',
    'ALT',
    'SHIFT',
    'SUPER',
    'META',
    'ENTER',
    'RETURN',
    'ESC',
    'ESCAPE',
    'TAB',
    'BACKSPACE',
    'BACK_SPACE',
    'DELETE',
    'DEL',
    'INSERT',
    'INS',
    'HOME',
    'END',
    'SPACE',
    'PAGEUP',
    'PAGE_UP',
    'PAGEDOWN',
    'PAGE_DOWN',
    'UP',
    'DOWN',
    'LEFT',
    'RIGHT',
]);

export class ComputerUseError extends Error {
    constructor(message, {
        cause = null,
        details = null,
        kind = 'operation',
    } = {}) {
        super(String(message ?? 'Computer use failed.'));
        this.name = 'ComputerUseError';
        this.userMessage = this.message;
        this.computerUseErrorKind = String(kind || 'operation');

        if (cause)
            this.cause = cause;
        if (details)
            this.computerUseDetails = details;
    }
}

export function createComputerUseError(message, options = {}) {
    return new ComputerUseError(message, options);
}

export function isComputerUseError(error) {
    return error instanceof ComputerUseError
        || String(error?.name ?? '') === 'ComputerUseError'
        || typeof error?.computerUseErrorKind === 'string';
}

export function isNormalizedComputerUseCoordinateSpace(value) {
    return ['normalized', 'normalized_1000'].includes(
        String(value ?? '').trim().toLowerCase(),
    );
}

export function isComputerUseTextInputAction(action) {
    const actionName = typeof action === 'string' ? action : action?.action;
    return TEXT_INPUT_ACTION_NAMES.has(actionName);
}

export function hasComputerUseCoordinates(action) {
    return COORDINATE_ACTION_NAMES.has(action?.action)
        || (isComputerUseTextInputAction(action)
            && (action.x !== undefined || action.y !== undefined));
}

export function hasUnsafeComputerUsePointerInputBatch(actions) {
    const coordinateTextInputs = (actions ?? []).filter(action => (
        isComputerUseTextInputAction(action)
        && (action.x !== undefined || action.y !== undefined)
    ));

    if (coordinateTextInputs.length > 0 && actions.length !== 1)
        return true;

    const clickIndex = actions.findIndex(action => CLICK_ACTION_NAMES.has(action?.action));
    return clickIndex >= 0
        && actions.slice(clickIndex + 1).some(action => (
            FOLLOWUP_INPUT_ACTION_NAMES.has(action?.action)
        ));
}

function inputError(message, details = null) {
    throw createComputerUseError(message, {
        details,
        kind: 'input',
    });
}

function requireWindowId(action, label) {
    if (!String(action.windowId ?? '').trim())
        inputError(`${label} requires windowId.`);
}

function requireWorkspaceIndex(action, label) {
    if (!Number.isInteger(action.workspaceIndex) || action.workspaceIndex < 0)
        inputError(`${label} requires a non-negative integer workspaceIndex.`);
}

function requireString(action, property, label, { allowEmpty = true } = {}) {
    if (typeof action[property] !== 'string'
        || (!allowEmpty && !action[property].trim())) {
        inputError(`${label} requires ${property} to be ${allowEmpty ? 'text' : 'non-empty text'}.`);
    }
}

function requireFiniteNumber(action, property, label) {
    if (!Number.isFinite(action[property]))
        inputError(`${label} requires a finite ${property} coordinate.`);
}

function validateCoordinateSpace(action, label) {
    const coordinateSpace = String(action.coordinateSpace ?? '').trim().toLowerCase();

    if (!COORDINATE_SPACES.has(coordinateSpace)) {
        inputError(
            `${label} requires coordinateSpace to be screenshot_pixels or normalized_1000.`,
        );
    }

    return coordinateSpace;
}

function validatePoint(action, label, names = ['x', 'y']) {
    const coordinateSpace = validateCoordinateSpace(action, label);
    const normalized = isNormalizedComputerUseCoordinateSpace(coordinateSpace);

    for (const name of names) {
        requireFiniteNumber(action, name, label);
        const value = Number(action[name]);

        if (value < 0 || (normalized && value > 1000)) {
            inputError(
                normalized
                    ? `${label} ${name} must be between 0 and 1000.`
                    : `${label} ${name} must be non-negative.`,
            );
        }
    }
}

function validateText(action, label) {
    requireString(action, 'text', label);

    if ([...action.text].length > MAX_COMPUTER_USE_TYPE_CHARACTERS) {
        inputError(
            `${label} text is limited to ${MAX_COMPUTER_USE_TYPE_CHARACTERS} characters.`,
        );
    }
}

export function isSupportedComputerUseKeyName(name) {
    const key = String(name ?? '').trim();

    if ([...key].length === 1)
        return true;

    const normalized = key.toUpperCase().replaceAll('-', '_');
    return SUPPORTED_KEYPRESS_NAMES.has(normalized)
        || /^F(?:[1-9]|[12][0-9]|3[0-5])$/.test(normalized);
}

export function validateComputerUseAction(action, {
    allowedActions = COMPUTER_USE_ACTION_NAMES,
    label = 'Computer action',
} = {}) {
    if (!action || typeof action !== 'object' || Array.isArray(action))
        inputError(`${label} must be an object.`);

    const actionName = String(action.action ?? '').trim();
    const allowed = allowedActions instanceof Set
        ? allowedActions
        : new Set(allowedActions ?? []);

    if (!actionName)
        inputError(`${label} requires action.`);
    if (typeof action.action !== 'string' || action.action !== actionName)
        inputError(`${label} action must be an exact supported action name.`);
    if (!allowed.has(actionName))
        inputError(`${label} does not support action ${actionName}.`);

    if (WINDOW_REQUIRED_ACTION_NAMES.has(actionName))
        requireWindowId(action, label);

    if (actionName === 'switch_workspace' || actionName === 'move_to_workspace')
        requireWorkspaceIndex(action, label);

    if (actionName === 'click_element' || actionName === 'set_text_element')
        requireString(action, 'ref', label, { allowEmpty: false });

    if (actionName === 'set_text_element')
        validateText(action, label);

    if (COORDINATE_ACTION_NAMES.has(actionName)) {
        validatePoint(
            action,
            label,
            actionName === 'drag' ? ['x', 'y', 'endX', 'endY'] : ['x', 'y'],
        );
    }

    if ((actionName === 'click' || actionName === 'double_click')
        && action.button !== undefined
        && !POINTER_BUTTON_NAMES.has(String(action.button))) {
        inputError(`${label} button must be left, middle, or right.`);
    }

    if (actionName === 'scroll') {
        for (const name of ['deltaX', 'deltaY']) {
            if (action[name] !== undefined && !Number.isFinite(action[name]))
                inputError(`${label} requires ${name} to be finite when provided.`);
        }

        if (Number(action.deltaX ?? 0) === 0 && Number(action.deltaY ?? 0) === 0)
            inputError(`${label} requires a non-zero deltaX or deltaY.`);
    }

    if (isComputerUseTextInputAction(actionName)) {
        validateText(action, label);
        const hasX = action.x !== undefined;
        const hasY = action.y !== undefined;

        if (hasX !== hasY)
            inputError(`A coordinate-targeted ${actionName} action requires both x and y.`);
        if (hasX) {
            requireWindowId(action, label);
            validatePoint(action, label);
        } else if (action.coordinateSpace !== undefined) {
            inputError(`${label} cannot specify coordinateSpace without x and y.`);
        }

        if (action.replace !== undefined
            && (typeof action.replace !== 'boolean'
                || (action.replace === true && !hasX))) {
            inputError(
                `${label} replace is only supported as a boolean on a coordinate-targeted text input action.`,
            );
        }
    }

    if (actionName === 'keypress') {
        if (!Array.isArray(action.keys) || action.keys.length === 0)
            inputError(`${label} keypress requires at least one key.`);
        if (action.keys.length > MAX_COMPUTER_USE_KEYPRESS_KEYS) {
            inputError(
                `${label} keypress is limited to ${MAX_COMPUTER_USE_KEYPRESS_KEYS} keys.`,
            );
        }
        if (action.keys.some(key => typeof key !== 'string' || !key.trim()))
            inputError(`${label} keypress keys must be non-empty strings.`);
        const unsupportedKey = action.keys.find(key => !isSupportedComputerUseKeyName(key));
        if (unsupportedKey !== undefined) {
            inputError(
                `${label} keypress does not support key ${String(unsupportedKey)}.`,
            );
        }
    }

    return action;
}

export function validateComputerUseStepActions(actions, {
    expectedWindowId = '',
    unsafeBatchMessage = 'Do not batch an explicit coordinate click with text input or key presses. Use one coordinate-targeted paste_text or type action for a visual field, or click and inspect before a later keyboard step.',
} = {}) {
    if (!Array.isArray(actions)
        || actions.length === 0
        || actions.length > MAX_COMPUTER_USE_STEP_ACTIONS) {
        inputError(
            `Computer step requires 1 to ${MAX_COMPUTER_USE_STEP_ACTIONS} actions.`,
        );
    }

    const windowId = String(expectedWindowId || actions[0]?.windowId || '').trim();

    if (!windowId)
        inputError('Computer step requires a target window.');

    if (hasUnsafeComputerUsePointerInputBatch(actions))
        inputError(unsafeBatchMessage);

    const observationIds = new Set(actions.map(action => (
        String(action?.observationId ?? '').trim()
    )));
    if (observationIds.size > 1) {
        inputError(
            'Every action in a computer step must use the same observationId.',
        );
    }

    for (const [index, action] of actions.entries()) {
        validateComputerUseAction(action, {
            allowedActions: COMPUTER_USE_WINDOW_ACTION_NAMES,
            label: `Computer step action ${index + 1}`,
        });

        if (String(action.windowId ?? '').trim() !== windowId) {
            inputError('Every action in a computer step must target the same window.');
        }
    }

    return actions;
}
