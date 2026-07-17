import Atspi from 'gi://Atspi?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const DEFAULT_MAX_ELEMENTS = 200;
const DEFAULT_MAX_VISITED_NODES = 2000;
const DEFAULT_MAX_DEPTH = 24;
const NORMALIZED_COORDINATE_SIZE = 1000;
const MAX_EXPOSED_TEXT_CHARACTERS = 200;
const WINDOW_BOUNDS_TOLERANCE = 1;

const INTERACTIVE_ROLES = new Set([
    'check box',
    'combo box',
    'entry',
    'link',
    'menu item',
    'page tab',
    'password text',
    'push button',
    'radio button',
    'slider',
    'spin button',
    'text',
    'toggle button',
]);

function normalizedString(value) {
    return String(value ?? '').trim();
}

function accessibilityBusAvailable() {
    if (GLib.getenv('AT_SPI_BUS_ADDRESS'))
        return true;

    try {
        const result = Gio.DBus.session.call_sync(
            'org.a11y.Bus',
            '/org/a11y/bus',
            'org.a11y.Bus',
            'GetAddress',
            null,
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            1_000,
            null,
        );
        return Boolean(result?.deepUnpack?.()?.[0]);
    } catch (_error) {
        return false;
    }
}

function safely(fallback, callback) {
    try {
        const value = callback();
        return value ?? fallback;
    } catch (_error) {
        return fallback;
    }
}

function hasState(stateSet, state) {
    return Boolean(stateSet && state !== undefined && safely(false, () => stateSet.contains(state)));
}

function stateRecord(stateSet, atspi) {
    return {
        active: hasState(stateSet, atspi.StateType.ACTIVE),
        checked: hasState(stateSet, atspi.StateType.CHECKED),
        editable: hasState(stateSet, atspi.StateType.EDITABLE),
        enabled: hasState(stateSet, atspi.StateType.ENABLED),
        focusable: hasState(stateSet, atspi.StateType.FOCUSABLE),
        focused: hasState(stateSet, atspi.StateType.FOCUSED),
        pressed: hasState(stateSet, atspi.StateType.PRESSED),
        selected: hasState(stateSet, atspi.StateType.SELECTED),
        sensitive: hasState(stateSet, atspi.StateType.SENSITIVE),
        showing: hasState(stateSet, atspi.StateType.SHOWING),
        visible: hasState(stateSet, atspi.StateType.VISIBLE),
    };
}

function screenBounds(accessible, atspi) {
    const component = safely(null, () => accessible.get_component_iface());

    if (!component)
        return null;

    const rect = safely(null, () => component.get_extents(atspi.CoordType.SCREEN));
    const x = Number(rect?.x);
    const y = Number(rect?.y);
    const width = Number(rect?.width);
    const height = Number(rect?.height);

    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
        return null;

    return { x, y, width, height };
}

function intersectsWindow(bounds, window) {
    if (!bounds)
        return false;

    return bounds.x < window.x + window.width
        && bounds.x + bounds.width > window.x
        && bounds.y < window.y + window.height
        && bounds.y + bounds.height > window.y;
}

function containedByWindow(bounds, window) {
    if (!bounds)
        return false;

    const left = Number(window.x) || 0;
    const top = Number(window.y) || 0;
    const right = left + Math.max(1, Number(window.width) || 0);
    const bottom = top + Math.max(1, Number(window.height) || 0);
    return bounds.x >= left - WINDOW_BOUNDS_TOLERANCE
        && bounds.y >= top - WINDOW_BOUNDS_TOLERANCE
        && bounds.x + bounds.width <= right + WINDOW_BOUNDS_TOLERANCE
        && bounds.y + bounds.height <= bottom + WINDOW_BOUNDS_TOLERANCE;
}

function boundsKey(bounds) {
    return [bounds.x, bounds.y, bounds.width, bounds.height].join(':');
}

function geometryIssues(bounds, window, duplicateCount) {
    const issues = [];

    if (!containedByWindow(bounds, window))
        issues.push('outside_window');
    if (duplicateCount > 1)
        issues.push('duplicate_bounds');

    return issues;
}

function normalizedBounds(bounds, window) {
    const relativeX = bounds.x - window.x;
    const relativeY = bounds.y - window.y;
    const scaleX = NORMALIZED_COORDINATE_SIZE / Math.max(1, window.width);
    const scaleY = NORMALIZED_COORDINATE_SIZE / Math.max(1, window.height);

    return {
        x: Math.round(relativeX * scaleX),
        y: Math.round(relativeY * scaleY),
        width: Math.max(1, Math.round(bounds.width * scaleX)),
        height: Math.max(1, Math.round(bounds.height * scaleY)),
    };
}

function accessibleText(accessible, role, states) {
    if (!states.editable || role === 'password text')
        return null;

    const text = safely(null, () => accessible.get_text_iface());

    if (!text)
        return null;

    const count = safely(0, () => text.get_character_count());

    if (!Number.isFinite(count) || count <= 0)
        return '';

    return normalizedString(safely('', () => text.get_text(
        0,
        Math.min(count, MAX_EXPOSED_TEXT_CHARACTERS),
    )));
}

function actionNames(accessible) {
    const action = safely(null, () => accessible.get_action_iface());

    if (!action)
        return [];

    const count = safely(0, () => action.get_n_actions());
    const names = [];

    for (let index = 0; index < Math.min(20, count); index++) {
        const name = normalizedString(safely('', () => action.get_action_name(index)));

        if (name)
            names.push(name);
    }

    return names;
}

function applicationMatches(application, window) {
    const pid = safely(0, () => application.get_process_id());

    if (Number(window.pid) > 0 && pid === Number(window.pid))
        return true;

    const applicationName = normalizedString(safely('', () => application.get_name())).toLowerCase();

    if (!applicationName)
        return false;

    const candidates = [window.appName, window.wmClass, window.appId]
        .map(value => normalizedString(value).toLowerCase())
        .filter(Boolean);
    return candidates.some(candidate => (
        applicationName.includes(candidate)
        || candidate.includes(applicationName)
    ));
}

export class AccessibilitySnapshotService {
    constructor(options = {}) {
        this._atspi = options.atspi ?? Atspi;
        this._maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
        this._maxVisitedNodes = options.maxVisitedNodes ?? DEFAULT_MAX_VISITED_NODES;
        this._maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
        this._initialized = false;
        this._targets = new Map();
        this._latestObservationId = '';
    }

    _initialize() {
        if (this._initialized)
            return true;

        try {
            if (this._atspi === Atspi && !accessibilityBusAvailable())
                return false;

            this._atspi.init();
            this._initialized = true;
            return true;
        } catch (_error) {
            return false;
        }
    }

    observe(window, observationId) {
        this._targets.clear();
        this._latestObservationId = String(observationId ?? '');

        if (!this._initialize()) {
            return {
                available: false,
                source: 'at-spi',
                reason: 'The desktop accessibility service is unavailable.',
                elements: [],
            };
        }

        const desktop = safely(null, () => this._atspi.get_desktop(0));

        if (!desktop) {
            return {
                available: false,
                source: 'at-spi',
                reason: 'The accessibility desktop could not be read.',
                elements: [],
            };
        }

        const applicationCount = safely(0, () => desktop.get_child_count());
        let application = null;

        for (let index = 0; index < applicationCount; index++) {
            const candidate = safely(null, () => desktop.get_child_at_index(index));

            if (candidate && applicationMatches(candidate, window)) {
                application = candidate;
                break;
            }
        }

        if (!application) {
            return {
                available: false,
                source: 'at-spi',
                reason: 'This application does not expose an accessibility tree. Visual targeting is required.',
                elements: [],
            };
        }

        const candidates = [];
        const queue = [{ accessible: application, depth: 0 }];
        let visited = 0;

        while (queue.length > 0
            && visited < this._maxVisitedNodes
            && candidates.length < this._maxElements) {
            const { accessible, depth } = queue.shift();
            visited += 1;
            const role = normalizedString(safely('', () => accessible.get_role_name())).toLowerCase();
            const name = normalizedString(safely('', () => accessible.get_name()));
            const description = normalizedString(safely('', () => accessible.get_description()));
            const states = stateRecord(safely(null, () => accessible.get_state_set()), this._atspi);
            const actions = actionNames(accessible);
            const bounds = screenBounds(accessible, this._atspi);
            const interactive = INTERACTIVE_ROLES.has(role)
                || states.editable
                || states.focusable
                || actions.length > 0;

            if (interactive && intersectsWindow(bounds, window) && (name || description || states.editable)) {
                candidates.push({
                    accessible,
                    role,
                    name,
                    description,
                    states,
                    actions,
                    bounds,
                });
            }

            if (depth >= this._maxDepth)
                continue;

            const childCount = Math.min(500, Math.max(0, safely(0, () => accessible.get_child_count())));

            for (let index = 0; index < childCount; index++) {
                const child = safely(null, () => accessible.get_child_at_index(index));

                if (child)
                    queue.push({ accessible: child, depth: depth + 1 });
            }
        }

        const boundsCounts = new Map();

        for (const candidate of candidates) {
            const key = boundsKey(candidate.bounds);
            boundsCounts.set(key, (boundsCounts.get(key) ?? 0) + 1);
        }

        let unreliableBoundsCount = 0;
        const elements = candidates.map((candidate, index) => {
            const ref = `a11y:${this._latestObservationId}:${index + 1}`;
            const issues = geometryIssues(
                candidate.bounds,
                window,
                boundsCounts.get(boundsKey(candidate.bounds)) ?? 0,
            );
            const element = {
                ref,
                role: candidate.role || 'unknown',
                name: candidate.name,
                description: candidate.description,
                states: candidate.states,
                actions: candidate.actions,
                bounds: issues.length === 0
                    ? normalizedBounds(candidate.bounds, window)
                    : null,
            };
            const value = accessibleText(candidate.accessible, candidate.role, candidate.states);

            if (issues.length > 0) {
                element.geometryIssues = issues;
                unreliableBoundsCount += 1;
            }
            if (value !== null)
                element.value = value;

            this._targets.set(ref, {
                accessible: candidate.accessible,
                element,
                observationId: this._latestObservationId,
            });
            return element;
        });

        return {
            available: true,
            source: 'at-spi',
            application: normalizedString(safely('', () => application.get_name())),
            elements,
            unreliableBoundsCount,
            geometryWarning: unreliableBoundsCount > 0
                ? 'Some accessibility elements reported duplicate or out-of-window geometry. Their bounds are null; target them by ref or use keyboard navigation instead of coordinates.'
                : '',
            truncated: queue.length > 0,
            visitedNodes: visited,
        };
    }

    _target(ref) {
        const target = this._targets.get(String(ref ?? ''));

        if (!target)
            throw new Error('The accessibility element reference is missing or stale. Observe the window again.');

        return target;
    }

    activate(ref) {
        const target = this._target(ref);
        const action = safely(null, () => target.accessible.get_action_iface());
        const actionCount = action ? safely(0, () => action.get_n_actions()) : 0;

        if (action && actionCount > 0) {
            const preferredNames = ['click', 'press', 'activate', 'jump'];
            let actionIndex = 0;

            for (let index = 0; index < actionCount; index++) {
                const name = normalizedString(safely('', () => action.get_action_name(index))).toLowerCase();

                if (preferredNames.some(preferred => name.includes(preferred))) {
                    actionIndex = index;
                    break;
                }
            }

            const verified = Boolean(safely(false, () => action.do_action(actionIndex)));
            return {
                performed: 'click_element',
                dispatchStatus: verified ? 'verified' : 'failed',
                verified,
                element: target.element,
            };
        }

        const component = safely(null, () => target.accessible.get_component_iface());
        const focusVerified = Boolean(component && safely(false, () => component.grab_focus()));
        return {
            performed: 'click_element',
            dispatchStatus: focusVerified ? 'focused' : 'failed',
            verified: false,
            focusVerified,
            activationKey: focusVerified ? 'Return' : undefined,
            verificationReason: focusVerified
                ? 'The element accepted keyboard focus and requires Return to activate.'
                : 'The element exposes neither an action nor focus support.',
            element: target.element,
        };
    }

    setText(ref, value) {
        const target = this._target(ref);
        const editable = safely(null, () => target.accessible.get_editable_text_iface());

        if (!editable)
            throw new Error('The referenced accessibility element is not editable.');

        const component = safely(null, () => target.accessible.get_component_iface());

        if (component)
            safely(false, () => component.grab_focus());

        const text = String(value ?? '');
        const dispatched = Boolean(safely(false, () => editable.set_text_contents(text)));
        const textInterface = safely(null, () => target.accessible.get_text_iface());
        let valueMatches = false;

        if (dispatched && textInterface && target.element.role !== 'password text') {
            const count = safely(0, () => textInterface.get_character_count());
            const actual = safely('', () => textInterface.get_text(0, count));
            valueMatches = String(actual) === text;
        } else if (dispatched && target.element.role === 'password text') {
            valueMatches = true;
        }

        return {
            performed: 'set_text_element',
            dispatchStatus: dispatched ? 'dispatched' : 'failed',
            verified: dispatched && valueMatches,
            valueMatches,
            element: {
                ...target.element,
                value: target.element.role === 'password text' ? undefined : text.slice(0, MAX_EXPOSED_TEXT_CHARACTERS),
            },
        };
    }

    shutdown() {
        this._targets.clear();
        this._latestObservationId = '';
    }
}
