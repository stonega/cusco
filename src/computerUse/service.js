import Gio from 'gi://Gio?version=2.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { AccessibilitySnapshotService } from './accessibility.js';
import {
    accessibilityForRegion,
    compareVisualSignatures,
    createCoordinateGridOverlay,
    createRegionScreenshot,
    createVisualSignature,
    normalizeRegion,
    NORMALIZED_COORDINATE_SIZE,
} from './imageViews.js';
import {
    createComputerUseError,
    hasComputerUseCoordinates,
    isComputerUseError,
    isComputerUseTextInputAction,
    isNormalizedComputerUseCoordinateSpace,
    validateComputerUseAction,
    validateComputerUseStepActions,
} from './protocol.js';

export const COMPUTER_USE_BUS_NAME = 'org.gnome.Shell';
export const COMPUTER_USE_OBJECT_PATH = '/io/github/stonega/Cusco/ComputerUse';
export const COMPUTER_USE_INTERFACE = 'io.github.stonega.Cusco.ComputerUse';
export const COMPUTER_USE_PROTOCOL_VERSION = 6;
export const COMPUTER_USE_AGENT_PROTOCOL_VERSION = 4;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const MAX_MODEL_SCREENSHOT_DIMENSION = 1600;
const MAX_STEP_SETTLE_MS = 2_000;
const STALLED_STEP_THRESHOLD = 2;
const VISUAL_STATE_HISTORY_LIMIT = 8;
const AUTO_ZOOM_PADDING = 40;
const AUTO_ZOOM_MINIMUM_SIZE = 160;
const AUTO_ZOOM_MAXIMUM_DIMENSION = 700;
const AUTO_ZOOM_MAXIMUM_AREA = 200_000;
const AUTO_ZOOM_CLICK_PROXIMITY = 120;
const AUTO_ZOOM_MINIMUM_EXTENSION = 55;
const WORKSPACE_ACTIONS = new Set([
    'create_workspace',
    'move_to_workspace',
    'switch_workspace',
]);

function createUserError(message, options = {}) {
    return createComputerUseError(message, options);
}

function remoteErrorDetails(error) {
    const rawMessage = String(error?.message ?? error ?? '');
    const remoteMatch = /^GDBus\.Error:([^:]+):\s*(.*)$/s.exec(rawMessage);

    return {
        message: (remoteMatch?.[2] ?? rawMessage).trim(),
        name: remoteMatch?.[1] ?? '',
        rawMessage,
    };
}

function integrationErrorMessage(error) {
    const details = remoteErrorDetails(error);
    const message = details.rawMessage;

    if (/UnknownMethod|UnknownObject|Object does not exist|No such interface/i.test(message)) {
        return 'GNOME Shell integration is not installed, enabled, or loaded. Install the current Cusco build, log out and back in, then enable cusco-computer-use@stonega.';
    }

    if (/ServiceUnknown|NameHasNoOwner/i.test(message))
        return 'GNOME Shell is unavailable on this session.';

    if (/NoReply|TimedOut|timed out/i.test(message))
        return 'GNOME Shell did not finish the computer-use operation before it timed out.';

    return details.message || 'GNOME Shell integration is unavailable.';
}

function isCancelledOperation(error, cancellable = null) {
    return Boolean(cancellable?.is_cancelled?.())
        || (typeof error?.matches === 'function'
            && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
}

function remoteComputerUseError(error) {
    if (isComputerUseError(error))
        return error;

    return createUserError(integrationErrorMessage(error), {
        cause: error,
        kind: 'remote',
    });
}

function logRecoverableComputerUseError(error, context) {
    console.info(`${context}: ${String(error?.message ?? error)}`);
}

function unpackJson(result, method) {
    const values = result?.deepUnpack?.() ?? [];
    const payload = Array.isArray(values) ? values[0] : values;

    if (typeof payload !== 'string')
        throw createUserError(`GNOME integration returned an invalid response for ${method}.`);

    try {
        return JSON.parse(payload);
    } catch (_error) {
        throw createUserError(`GNOME integration returned malformed JSON for ${method}.`);
    }
}

function callProxy(proxy, method, parameters = null, cancellable = null, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        proxy.call(
            method,
            parameters,
            Gio.DBusCallFlags.NONE,
            timeoutMs,
            cancellable,
            (_proxy, result) => {
                try {
                    resolve(proxy.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

function isStaleRegistrationError(error) {
    return /Caller is not the registered Cusco process/i.test(
        String(error?.message ?? error ?? ''),
    );
}

function environmentStatus() {
    const sessionType = String(GLib.getenv('XDG_SESSION_TYPE') ?? '').toLowerCase();
    const desktop = String(GLib.getenv('XDG_CURRENT_DESKTOP') ?? '').toLowerCase();

    if (sessionType !== 'wayland') {
        return {
            supported: false,
            reason: 'Computer use requires a Wayland session.',
        };
    }

    if (!desktop.split(':').includes('gnome')) {
        return {
            supported: false,
            reason: 'Computer use currently requires GNOME Shell.',
        };
    }

    return { supported: true, reason: '' };
}

function pngDimensions(bytes) {
    if (bytes.length < 24
        || bytes[0] !== 0x89
        || bytes[1] !== 0x50
        || bytes[2] !== 0x4e
        || bytes[3] !== 0x47)
        return null;

    const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    return width > 0 && height > 0 ? { width, height } : null;
}

function delay(milliseconds) {
    const duration = Math.max(0, Math.round(Number(milliseconds) || 0));

    if (duration === 0)
        return Promise.resolve();

    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function prepareModelScreenshot(path, bytes, dimensions) {
    const largestDimension = Math.max(dimensions.width, dimensions.height);

    if (largestDimension <= MAX_MODEL_SCREENSHOT_DIMENSION) {
        return {
            bytes,
            dimensions,
        };
    }

    try {
        const source = GdkPixbuf.Pixbuf.new_from_file(path);
        const scale = MAX_MODEL_SCREENSHOT_DIMENSION / largestDimension;
        const width = Math.max(1, Math.round(source.get_width() * scale));
        const height = Math.max(1, Math.round(source.get_height() * scale));
        const scaled = source.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR);

        scaled.savev(path, 'png', [], []);
        GLib.chmod(path, 0o600);
        const [, scaledBytes] = GLib.file_get_contents(path);
        return {
            bytes: scaledBytes,
            dimensions: { width, height },
        };
    } catch (error) {
        logRecoverableComputerUseError(error, 'Failed to resize computer-use screenshot');
        return {
            bytes,
            dimensions,
        };
    }
}

function derivedImagePath(path, suffix) {
    return String(path).replace(/\.png$/i, `${suffix}.png`);
}

function coordinateSpaceMetadata(width, height) {
    return {
        screenshot: {
            type: 'screenshot_pixels',
            width,
            height,
        },
        normalized: {
            type: 'normalized_1000',
            width: NORMALIZED_COORDINATE_SIZE,
            height: NORMALIZED_COORDINATE_SIZE,
        },
    };
}

function modelGridFor(path) {
    const outputPath = derivedImagePath(path, '-grid');

    try {
        const grid = createCoordinateGridOverlay(path, outputPath);
        return {
            modelImagePath: outputPath,
            grid: {
                enabled: true,
                synthetic: true,
                coordinateSpace: grid.coordinateSpace,
                majorStep: grid.majorStep,
                minorStep: grid.minorStep,
            },
        };
    } catch (error) {
        logRecoverableComputerUseError(error, 'Failed to add the computer-use coordinate grid');
        return {
            modelImagePath: path,
            grid: {
                enabled: false,
                synthetic: true,
                reason: 'The coordinate grid could not be rendered.',
            },
        };
    }
}

function visualSignatureFor(path) {
    try {
        return createVisualSignature(path);
    } catch (error) {
        logRecoverableComputerUseError(error, 'Failed to create a computer-use visual signature');
        return null;
    }
}

function removeFile(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
        return;

    try {
        Gio.File.new_for_path(path).delete(null);
    } catch (error) {
        logRecoverableComputerUseError(error, 'Failed to remove a temporary computer-use screenshot');
    }
}

function mapActionCoordinates(request, observation) {
    const normalized = isNormalizedComputerUseCoordinateSpace(request.coordinateSpace);
    const coordinateWidth = normalized
        ? NORMALIZED_COORDINATE_SIZE
        : observation.imageWidth;
    const coordinateHeight = normalized
        ? NORMALIZED_COORDINATE_SIZE
        : observation.imageHeight;
    const trace = {
        observationId: observation.observationId,
        rootObservationId: observation.rootObservationId,
        coordinateSpace: normalized ? 'normalized_1000' : 'screenshot_pixels',
        requested: {},
        screenshot: {},
        window: {},
        desktop: null,
        view: observation.view,
    };
    const mapAxis = (name, size, imageSize, frameOffset, frameSize) => {
        if (!Number.isFinite(request[name]))
            return;

        const value = Number(request[name]);
        trace.requested[name] = value;
        trace.screenshot[name] = normalized
            ? (value / NORMALIZED_COORDINATE_SIZE) * imageSize
            : value;
        trace.window[name] = frameOffset + ((value / Math.max(1, size)) * frameSize);
        request[name] = trace.window[name];
    };

    mapAxis('x', coordinateWidth, observation.imageWidth, observation.frameX, observation.frameWidth);
    mapAxis('y', coordinateHeight, observation.imageHeight, observation.frameY, observation.frameHeight);
    mapAxis('endX', coordinateWidth, observation.imageWidth, observation.frameX, observation.frameWidth);
    mapAxis('endY', coordinateHeight, observation.imageHeight, observation.frameY, observation.frameHeight);
    return trace;
}

function elapsedMilliseconds(startedAt) {
    return Math.max(0, Math.round((GLib.get_monotonic_time() - startedAt) / 1000));
}

function observationVisualState(observation) {
    if (!observation)
        return null;

    return {
        fingerprint: observation.fingerprint ?? '',
        visualSignature: observation.visualSignature ?? null,
    };
}

function visualStatesMatch(first, second) {
    if (!first || !second)
        return false;

    const comparison = compareVisualSignatures(
        first.visualSignature,
        second.visualSignature,
    );

    if (comparison.changed !== null)
        return comparison.changed === false;

    return Boolean(first.fingerprint)
        && first.fingerprint === second.fingerprint;
}

function hasAlternatingVisualStateCycle(history) {
    if (!Array.isArray(history) || history.length < 4)
        return false;

    const [first, second, third, fourth] = history.slice(-4);
    return !visualStatesMatch(first, second)
        && visualStatesMatch(first, third)
        && visualStatesMatch(second, fourth);
}

function normalizedRootPoint(coordinates) {
    if (coordinates?.coordinateSpace !== 'normalized_1000')
        return null;

    const requestedX = Number(coordinates.requested?.x);
    const requestedY = Number(coordinates.requested?.y);
    const view = coordinates.view?.normalized;

    if (!Number.isFinite(requestedX)
        || !Number.isFinite(requestedY)
        || !view
        || ![view.x, view.y, view.width, view.height].every(Number.isFinite)) {
        return null;
    }

    return {
        x: view.x + ((requestedX / NORMALIZED_COORDINATE_SIZE) * view.width),
        y: view.y + ((requestedY / NORMALIZED_COORDINATE_SIZE) * view.height),
    };
}

function expandedAxis(start, end, minimumSize) {
    let nextStart = Math.max(0, start);
    let nextEnd = Math.min(NORMALIZED_COORDINATE_SIZE, end);
    const currentSize = nextEnd - nextStart;

    if (currentSize < minimumSize) {
        const center = (nextStart + nextEnd) / 2;
        nextStart = center - (minimumSize / 2);
        nextEnd = center + (minimumSize / 2);

        if (nextStart < 0) {
            nextEnd -= nextStart;
            nextStart = 0;
        }
        if (nextEnd > NORMALIZED_COORDINATE_SIZE) {
            nextStart -= nextEnd - NORMALIZED_COORDINATE_SIZE;
            nextEnd = NORMALIZED_COORDINATE_SIZE;
        }
    }

    return {
        start: Math.max(0, nextStart),
        end: Math.min(NORMALIZED_COORDINATE_SIZE, nextEnd),
    };
}

function automaticZoomRegion(visualChange, actionResult) {
    const bounds = visualChange?.changedBounds;
    const point = normalizedRootPoint(actionResult?.coordinates);

    if (visualChange?.changed !== true || !bounds || !point)
        return null;

    const left = Number(bounds.x);
    const top = Number(bounds.y);
    const right = left + Number(bounds.width);
    const bottom = top + Number(bounds.height);

    if (![left, top, right, bottom].every(Number.isFinite)
        || right <= left || bottom <= top) {
        return null;
    }

    const nearChange = point.x >= left - AUTO_ZOOM_CLICK_PROXIMITY
        && point.x <= right + AUTO_ZOOM_CLICK_PROXIMITY
        && point.y >= top - AUTO_ZOOM_CLICK_PROXIMITY
        && point.y <= bottom + AUTO_ZOOM_CLICK_PROXIMITY;
    const extensionFromClick = Math.max(
        Math.abs(point.x - left),
        Math.abs(point.x - right),
        Math.abs(point.y - top),
        Math.abs(point.y - bottom),
    );

    if (!nearChange || extensionFromClick < AUTO_ZOOM_MINIMUM_EXTENSION)
        return null;

    const horizontal = expandedAxis(
        Math.min(left, point.x) - AUTO_ZOOM_PADDING,
        Math.max(right, point.x) + AUTO_ZOOM_PADDING,
        AUTO_ZOOM_MINIMUM_SIZE,
    );
    const vertical = expandedAxis(
        Math.min(top, point.y) - AUTO_ZOOM_PADDING,
        Math.max(bottom, point.y) + AUTO_ZOOM_PADDING,
        AUTO_ZOOM_MINIMUM_SIZE,
    );
    const region = {
        x: Math.floor(horizontal.start),
        y: Math.floor(vertical.start),
        width: Math.ceil(horizontal.end) - Math.floor(horizontal.start),
        height: Math.ceil(vertical.end) - Math.floor(vertical.start),
    };

    if (region.width > AUTO_ZOOM_MAXIMUM_DIMENSION
        || region.height > AUTO_ZOOM_MAXIMUM_DIMENSION
        || region.width * region.height > AUTO_ZOOM_MAXIMUM_AREA) {
        return null;
    }

    return {
        region: normalizeRegion(region),
        changedBounds: bounds,
        triggerPoint: point,
    };
}

function coordinateRetryBlockMessage(reason) {
    if (reason === 'visual_state_cycle') {
        return 'Coordinate targeting is blocked after the UI repeated an alternating visual-state cycle. Use an enlarged region from the current observation, accessibility, keyboard navigation, a fresh observation, or ask the user for help.';
    }

    return 'Coordinate targeting is blocked after repeated unchanged steps. Request a screenshot region, use accessibility or keyboard navigation, or ask the user for help.';
}

function matchingAccessibilityElement(elements, expectation) {
    const expectedName = String(expectation?.name ?? '').trim().toLowerCase();
    const expectedRole = String(expectation?.role ?? '').trim().toLowerCase();

    return (elements ?? []).find((element) => {
        const name = String(element?.name ?? '').trim().toLowerCase();
        const role = String(element?.role ?? '').trim().toLowerCase();
        return (!expectedName || name === expectedName)
            && (!expectedRole || role === expectedRole);
    }) ?? null;
}

export function evaluateComputerUseExpectations(observation, expectations = []) {
    const elements = observation?.accessibility?.elements ?? [];
    const results = expectations.map((expectation) => {
        const element = matchingAccessibilityElement(elements, expectation);
        const state = String(expectation?.state ?? 'present').trim().toLowerCase();
        const expectedValue = String(expectation?.value ?? '');
        let passed = false;

        switch (state) {
        case 'absent':
            passed = !element;
            break;
        case 'enabled':
        case 'editable':
        case 'focused':
            passed = Boolean(element?.states?.[state]);
            break;
        case 'value_equals':
            passed = element && String(element.value ?? '') === expectedValue;
            break;
        case 'value_contains':
            passed = element && String(element.value ?? '').includes(expectedValue);
            break;
        case 'present':
        default:
            passed = Boolean(element);
            break;
        }

        return {
            ...expectation,
            state,
            passed,
            matchedRef: element?.ref ?? null,
            actualValue: element?.value,
            actualStates: element?.states ?? null,
        };
    });

    return {
        met: results.every(result => result.passed),
        results,
    };
}

function removeDirectory(path) {
    if (!path || !GLib.file_test(path, GLib.FileTest.IS_DIR))
        return;

    const directory = Gio.File.new_for_path(path);
    const enumerator = directory.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
    );

    try {
        let info;

        while ((info = enumerator.next_file(null))) {
            const childPath = GLib.build_filenamev([path, info.get_name()]);

            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                removeDirectory(childPath);
            else
                Gio.File.new_for_path(childPath).delete(null);
        }
    } finally {
        enumerator.close(null);
    }

    directory.delete(null);
}

export class ComputerUseService {
    constructor(options = {}) {
        this._settings = options.settings;
        this._environmentStatus = options.environmentStatus ?? environmentStatus;
        this._onActiveChanged = options.onActiveChanged ?? (() => {});
        this._onStopRequested = options.onStopRequested ?? (() => {});
        this._accessibility = options.accessibility === undefined
            ? new AccessibilitySnapshotService()
            : options.accessibility;
        this._proxy = options.proxy ?? null;
        this._registered = false;
        this._activeCount = 0;
        this._activeCancellables = new Set();
        this._activeTurnCancellable = null;
        this._presentedActive = false;
        this._observations = new Map();
        this._observationViews = new Map();
        this._unchangedStepCounts = new Map();
        this._unchangedCoordinateStepCounts = new Map();
        this._coordinateRetryBlocked = new Set();
        this._coordinateRetryBlockReasons = new Map();
        this._visualStateHistories = new Map();
        this._sessionDirectory = options.cacheDirectory ?? GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'io.github.stonega.Cusco',
            'computer-use',
            GLib.uuid_string_random(),
        ]);
        this._proxySignalId = 0;
        this._proxyOwnerSignalId = 0;
    }

    get active() {
        return this._activeCount > 0 || this._activeTurnCancellable !== null;
    }

    _getProxy() {
        if (this._proxy)
            return this._proxy;

        this._proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            null,
            COMPUTER_USE_BUS_NAME,
            COMPUTER_USE_OBJECT_PATH,
            COMPUTER_USE_INTERFACE,
            null,
        );
        this._proxySignalId = this._proxy.connect('g-signal', (_proxy, _sender, signalName) => {
            if (signalName !== 'StopRequested')
                return;

            this.stop();
            this._onStopRequested();
        });
        this._proxyOwnerSignalId = this._proxy.connect('notify::g-name-owner', () => {
            if (this._proxy?.get_name_owner())
                return;

            this._registered = false;
            if (this.active) {
                this.stop();
                this._onStopRequested();
            }
        });
        return this._proxy;
    }

    async status() {
        const environment = this._environmentStatus();

        if (!environment.supported)
            return { ...environment, available: false, registered: false };

        try {
            const proxy = this._getProxy();

            if (!proxy.get_name_owner()) {
                return {
                    supported: true,
                    available: false,
                    registered: false,
                    reason: 'GNOME Shell integration is not installed or enabled.',
                };
            }

            await this._register();
            const result = unpackJson(await this._callRegistered('GetStatus'), 'GetStatus');
            return {
                supported: true,
                available: result.protocolVersion === COMPUTER_USE_PROTOCOL_VERSION,
                registered: true,
                reason: result.protocolVersion === COMPUTER_USE_PROTOCOL_VERSION
                    ? ''
                    : 'GNOME Shell integration protocol is out of date.',
                ...result,
            };
        } catch (error) {
            return {
                supported: true,
                available: false,
                registered: false,
                reason: integrationErrorMessage(error),
            };
        }
    }

    async _register() {
        if (this._registered)
            return;

        const environment = this._environmentStatus();
        if (!environment.supported)
            throw createUserError(environment.reason);

        const proxy = this._getProxy();

        if (!proxy.get_name_owner())
            throw createUserError('GNOME Shell integration is not installed or enabled.');

        let result;
        try {
            result = unpackJson(await callProxy(
                proxy,
                'Register',
                new GLib.Variant('(u)', [new Gio.Credentials().get_unix_pid()]),
            ), 'Register');
        } catch (error) {
            throw createUserError(integrationErrorMessage(error), {
                cause: error,
                kind: 'remote',
            });
        }

        if (result.protocolVersion !== COMPUTER_USE_PROTOCOL_VERSION) {
            throw createUserError(
                `GNOME integration protocol mismatch (app ${COMPUTER_USE_PROTOCOL_VERSION}, extension ${result.protocolVersion ?? 'unknown'}).`,
            );
        }

        this._registered = true;
    }

    async _callRegistered(method, parameters = null, cancellable = null, timeoutMs = DEFAULT_TIMEOUT_MS) {
        const call = () => callProxy(
            this._getProxy(),
            method,
            parameters,
            cancellable,
            timeoutMs,
        );

        try {
            return await call();
        } catch (error) {
            if (!isStaleRegistrationError(error))
                throw error;

            this._registered = false;
            await this._register();
            return await call();
        }
    }

    _requireEnabled() {
        if (!this._settings?.computerUseEnabled)
            throw createUserError('Computer use is disabled. Enable it in Settings → Workspace.');
    }

    async _setRemoteActive(active) {
        if (!this._registered)
            return;

        try {
            await this._callRegistered(
                'SetActive',
                new GLib.Variant('(b)', [Boolean(active)]),
                null,
                2_000,
            );
        } catch (error) {
            logRecoverableComputerUseError(error, 'Failed to update computer-use indicator');
        }
    }

    async _setActivePresentation(active) {
        const nextActive = Boolean(active);

        if (nextActive === this._presentedActive)
            return false;

        this._presentedActive = nextActive;
        this._onActiveChanged(nextActive);
        await this._setRemoteActive(nextActive);
        return true;
    }

    async _run(method, parameters, options = {}) {
        this._requireEnabled();
        await this._register();
        const cancellable = options.cancellable ?? new Gio.Cancellable();
        const wasActive = this.active;

        if (options.cancellable)
            this._activeTurnCancellable = cancellable;
        this._activeCancellables.add(cancellable);
        this._activeCount += 1;
        if (!wasActive)
            await this._setActivePresentation(true);

        try {
            return await this._callRegistered(
                method,
                parameters,
                cancellable,
                Math.max(1_000, (this._settings?.computerUseActionTimeoutSeconds ?? 30) * 1_000),
            );
        } catch (error) {
            if (isCancelledOperation(error, cancellable))
                throw error;

            throw remoteComputerUseError(error);
        } finally {
            this._activeCancellables.delete(cancellable);
            this._activeCount = Math.max(0, this._activeCount - 1);
            if (!this.active)
                await this._setActivePresentation(false);
        }
    }

    async listDesktop(options = {}) {
        return unpackJson(await this._run('ListDesktop', null, options), 'ListDesktop');
    }

    _invalidateObservationViews(windowId) {
        const id = String(windowId ?? '');

        for (const [observationId, observation] of this._observationViews) {
            if (observation.windowId === id)
                this._observationViews.delete(observationId);
        }
    }

    _registerFullObservation(observation) {
        this._invalidateObservationViews(observation.windowId);
        this._observations.set(observation.windowId, observation);
        this._observationViews.set(observation.observationId, observation);
    }

    _resolveObservation(windowId, observationId = '') {
        const id = String(windowId ?? '');
        const current = this._observations.get(id) ?? null;
        const requestedId = String(observationId ?? '').trim();

        if (!requestedId)
            return current;

        const requested = this._observationViews.get(requestedId) ?? null;
        if (!current || !requested
            || requested.windowId !== id
            || requested.rootObservationId !== current.rootObservationId) {
            throw createUserError('This action references a stale observation. Observe the window again before acting.');
        }

        return requested;
    }

    _observationPayload(observation) {
        return {
            window: observation.window,
            width: observation.imageWidth,
            height: observation.imageHeight,
            mimeType: observation.mimeType,
            agentProtocolVersion: COMPUTER_USE_AGENT_PROTOCOL_VERSION,
            observationId: observation.observationId,
            parentObservationId: observation.parentObservationId ?? null,
            rootObservationId: observation.rootObservationId,
            coordinateSpace: coordinateSpaceMetadata(
                observation.imageWidth,
                observation.imageHeight,
            ),
            capture: observation.capture,
            accessibility: observation.accessibility,
            imagePath: observation.imagePath,
            modelImagePath: observation.modelImagePath,
            grid: observation.grid,
            view: observation.view,
        };
    }

    async _captureWindowState(windowId, options = {}) {
        if (!this._settings?.computerUseCaptureEnabled)
            throw createUserError('Screen capture is disabled in Settings → Workspace.');

        const normalizedWindowId = String(windowId ?? '');
        const method = options.passive ? 'CaptureWindowPassive' : 'CaptureWindow';
        const response = unpackJson(await this._run(
            method,
            new GLib.Variant('(s)', [normalizedWindowId]),
            options,
        ), method);
        const encoded = String(response.imageBase64 ?? '');
        const bytes = GLib.base64_decode(encoded);

        if (!encoded || bytes.length === 0)
            throw createUserError('GNOME Shell returned an empty screenshot.');

        if (bytes.length > MAX_SCREENSHOT_BYTES)
            throw createUserError('Screenshot exceeded the 25 MB safety limit.');

        GLib.mkdir_with_parents(this._sessionDirectory, 0o700);
        const path = GLib.build_filenamev([
            this._sessionDirectory,
            `window-${normalizedWindowId.replace(/[^A-Za-z0-9_-]/g, '_')}-${GLib.uuid_string_random()}.png`,
        ]);
        GLib.file_set_contents(path, bytes);
        GLib.chmod(path, 0o600);
        const capturedDimensions = pngDimensions(bytes) ?? {
            width: Number(response.width) || Number(response.window?.width) || 1,
            height: Number(response.height) || Number(response.window?.height) || 1,
        };
        const prepared = prepareModelScreenshot(path, bytes, capturedDimensions);
        const dimensions = prepared.dimensions;
        const observationId = GLib.uuid_string_random();
        const fingerprint = GLib.compute_checksum_for_data(
            GLib.ChecksumType.SHA256,
            prepared.bytes,
        );
        const capture = {
            sourceWidth: capturedDimensions.width,
            sourceHeight: capturedDimensions.height,
            sourceBytes: bytes.length,
            modelWidth: dimensions.width,
            modelHeight: dimensions.height,
            modelBytes: prepared.bytes.length,
        };

        delete response.imageBase64;
        return {
            normalizedWindowId,
            response,
            path,
            dimensions,
            observationId,
            fingerprint,
            visualSignature: visualSignatureFor(path),
            capture,
        };
    }

    _observationFromCapture(captured, options = {}) {
        const {
            normalizedWindowId,
            response,
            path,
            dimensions,
            observationId,
            fingerprint,
            visualSignature,
            capture,
        } = captured;
        const accessibility = this._accessibility?.observe
            ? this._accessibility.observe(response.window ?? {}, observationId)
            : {
                available: false,
                source: 'at-spi',
                reason: 'Semantic accessibility observation is disabled.',
                elements: [],
            };
        const modelView = modelGridFor(path);
        const frameWidth = Number(response.window?.width) || dimensions.width;
        const frameHeight = Number(response.window?.height) || dimensions.height;
        const observation = {
            windowId: normalizedWindowId,
            observationId,
            rootObservationId: observationId,
            parentObservationId: null,
            fingerprint,
            visualSignature,
            imagePath: path,
            modelImagePath: modelView.modelImagePath,
            grid: modelView.grid,
            imageWidth: dimensions.width,
            imageHeight: dimensions.height,
            frameX: 0,
            frameY: 0,
            frameWidth,
            frameHeight,
            rootFrameWidth: frameWidth,
            rootFrameHeight: frameHeight,
            window: response.window ?? { id: normalizedWindowId },
            mimeType: response.mimeType ?? 'image/png',
            accessibility,
            capture,
            view: {
                type: 'full',
                normalized: {
                    x: 0,
                    y: 0,
                    width: NORMALIZED_COORDINATE_SIZE,
                    height: NORMALIZED_COORDINATE_SIZE,
                },
            },
        };

        this._registerFullObservation(observation);
        if (!options.preserveCoordinateBlock) {
            this._unchangedStepCounts.set(normalizedWindowId, 0);
            this._unchangedCoordinateStepCounts.set(normalizedWindowId, 0);
            this._coordinateRetryBlocked.delete(normalizedWindowId);
            this._coordinateRetryBlockReasons.delete(normalizedWindowId);
            this._visualStateHistories.set(
                normalizedWindowId,
                [observationVisualState(observation)],
            );
        }
        return {
            observation,
            payload: {
                ...response,
                ...this._observationPayload(observation),
            },
        };
    }

    async _verifyLiveCoordinateState(windowId, referencedObservation, options = {}) {
        const normalizedWindowId = String(windowId ?? '');
        const referenceRoot = this._observations.get(normalizedWindowId) ?? null;
        const captured = await this._captureWindowState(normalizedWindowId, {
            ...options,
            passive: true,
        });
        const visualChange = compareVisualSignatures(
            referenceRoot?.visualSignature,
            captured.visualSignature,
        );
        const screenChanged = visualChange.changed
            ?? (referenceRoot?.fingerprint !== captured.fingerprint);
        const focused = captured.response.window?.focused === true;
        const matched = screenChanged === false && focused;

        if (matched) {
            removeFile(captured.path);
            return {
                matched: true,
                screenChanged: false,
                visualChange,
                focused: true,
                referenceObservationId: referencedObservation.observationId,
                referenceRootObservationId: referencedObservation.rootObservationId,
                observation: null,
            };
        }

        const fresh = this._observationFromCapture(captured);
        return {
            matched: false,
            screenChanged,
            visualChange,
            focused,
            referenceObservationId: referencedObservation.observationId,
            referenceRootObservationId: referencedObservation.rootObservationId,
            observation: fresh.payload,
        };
    }

    async observe(windowId, options = {}) {
        const captured = await this._captureWindowState(windowId, options);
        return this._observationFromCapture(captured, options).payload;
    }

    async observeRegion(windowId, observationId, region, options = {}) {
        this._requireEnabled();
        if (!this._settings?.computerUseCaptureEnabled)
            throw createUserError('Screen capture is disabled in Settings → Workspace.');

        const normalizedWindowId = String(windowId ?? '').trim();
        if (!normalizedWindowId)
            throw createUserError('Region observation requires a target window.');

        const parent = this._resolveObservation(normalizedWindowId, observationId);
        if (!parent)
            throw createUserError('Observe this window before requesting a region.');

        let requestedRegion;
        try {
            requestedRegion = normalizeRegion(region);
        } catch (error) {
            throw createUserError(error.message ?? String(error));
        }
        if (requestedRegion.width >= 900 && requestedRegion.height >= 900) {
            throw createUserError(
                'The requested region is too close to the full image. Choose a smaller area so visual targeting is meaningfully enlarged.',
            );
        }

        const parentRegion = parent.view.normalized;
        const rootRegion = normalizeRegion({
            x: parentRegion.x + ((requestedRegion.x / NORMALIZED_COORDINATE_SIZE) * parentRegion.width),
            y: parentRegion.y + ((requestedRegion.y / NORMALIZED_COORDINATE_SIZE) * parentRegion.height),
            width: (requestedRegion.width / NORMALIZED_COORDINATE_SIZE) * parentRegion.width,
            height: (requestedRegion.height / NORMALIZED_COORDINATE_SIZE) * parentRegion.height,
        });
        const root = this._observations.get(normalizedWindowId);
        const viewId = GLib.uuid_string_random();
        const cleanPath = derivedImagePath(root.imagePath, `-region-${viewId}`);
        let image;

        try {
            image = createRegionScreenshot(root.imagePath, cleanPath, rootRegion);
        } catch (error) {
            throw createUserError(`Could not create the requested screenshot region: ${error.message ?? error}`);
        }

        const modelView = modelGridFor(cleanPath);
        const effectiveRegion = {
            x: (image.sourcePixels.x / root.imageWidth) * NORMALIZED_COORDINATE_SIZE,
            y: (image.sourcePixels.y / root.imageHeight) * NORMALIZED_COORDINATE_SIZE,
            width: (image.sourcePixels.width / root.imageWidth) * NORMALIZED_COORDINATE_SIZE,
            height: (image.sourcePixels.height / root.imageHeight) * NORMALIZED_COORDINATE_SIZE,
        };
        const frameX = (effectiveRegion.x / NORMALIZED_COORDINATE_SIZE) * root.rootFrameWidth;
        const frameY = (effectiveRegion.y / NORMALIZED_COORDINATE_SIZE) * root.rootFrameHeight;
        const frameWidth = (effectiveRegion.width / NORMALIZED_COORDINATE_SIZE) * root.rootFrameWidth;
        const frameHeight = (effectiveRegion.height / NORMALIZED_COORDINATE_SIZE) * root.rootFrameHeight;
        const view = {
            windowId: normalizedWindowId,
            observationId: viewId,
            rootObservationId: root.rootObservationId,
            parentObservationId: parent.observationId,
            fingerprint: root.fingerprint,
            visualSignature: root.visualSignature,
            imagePath: cleanPath,
            modelImagePath: modelView.modelImagePath,
            grid: modelView.grid,
            imageWidth: image.width,
            imageHeight: image.height,
            frameX,
            frameY,
            frameWidth,
            frameHeight,
            rootFrameWidth: root.rootFrameWidth,
            rootFrameHeight: root.rootFrameHeight,
            window: root.window,
            mimeType: root.mimeType,
            accessibility: accessibilityForRegion(root.accessibility, effectiveRegion),
            capture: {
                source: options.source ?? 'observation_region',
                rootWidth: root.imageWidth,
                rootHeight: root.imageHeight,
                sourcePixels: image.sourcePixels,
                modelWidth: image.width,
                modelHeight: image.height,
            },
            view: {
                type: 'region',
                normalized: effectiveRegion,
                requested: requestedRegion,
                requestedInRoot: rootRegion,
                ...(options.autoZoom ? { autoZoom: options.autoZoom } : {}),
            },
        };

        this._observationViews.set(viewId, view);
        if (options.unlockCoordinateRetry !== false) {
            this._unchangedCoordinateStepCounts.set(normalizedWindowId, 0);
            this._coordinateRetryBlocked.delete(normalizedWindowId);
            this._coordinateRetryBlockReasons.delete(normalizedWindowId);
            this._visualStateHistories.set(
                normalizedWindowId,
                [observationVisualState(root)],
            );
        }
        return this._observationPayload(view);
    }

    async act(action, options = {}) {
        if (!this._settings?.computerUseInputEnabled)
            throw createUserError('Computer input control is disabled in Settings → Workspace.');

        validateComputerUseAction(action);

        if (WORKSPACE_ACTIONS.has(action?.action)
            && !this._settings?.computerUseWorkspaceSwitchingEnabled) {
            throw createUserError('Workspace switching is disabled in Settings → Workspace.');
        }

        const actionWindowId = String(action?.windowId ?? '');

        if (isComputerUseTextInputAction(action)
            && (action.x !== undefined || action.y !== undefined)
            && (!Number.isFinite(action.x) || !Number.isFinite(action.y))) {
            throw createUserError(
                'A coordinate-targeted text input action requires both x and y as finite numbers.',
            );
        }

        if (action?.replace !== undefined
            && (typeof action.replace !== 'boolean'
                || !isComputerUseTextInputAction(action)
                || (action.replace === true
                    && (!Number.isFinite(action.x) || !Number.isFinite(action.y))))) {
            throw createUserError(
                'replace is only supported as a boolean on a coordinate-targeted text input action with both x and y.',
            );
        }

        const referencedObservation = actionWindowId
            ? this._resolveObservation(actionWindowId, action?.observationId)
            : null;

        if (action?.action === 'click_element' || action?.action === 'set_text_element') {
            if (!this._accessibility)
                throw createUserError('Semantic accessibility actions are unavailable.');

            try {
                if (action.action === 'set_text_element')
                    return this._accessibility.setText(action.ref, action.text);

                const result = this._accessibility.activate(action.ref);

                if (!result.activationKey)
                    return result;
                if (!actionWindowId)
                    throw new Error('Keyboard activation requires a target window.');

                const keyboardResult = unpackJson(await this._run(
                    'PerformAction',
                    new GLib.Variant('(s)', [JSON.stringify({
                        action: 'keypress',
                        windowId: actionWindowId,
                        keys: [result.activationKey],
                    })]),
                    options,
                ), 'PerformAction');
                return {
                    ...result,
                    dispatchStatus: keyboardResult.dispatchStatus ?? 'dispatched',
                    verified: false,
                    verificationReason: `The element accepted focus and ${result.activationKey} was dispatched. Verify the resulting screen or an explicit expectation.`,
                    keyboardActivation: {
                        performed: keyboardResult.performed ?? 'keypress',
                        dispatchStatus: keyboardResult.dispatchStatus ?? 'dispatched',
                        verified: keyboardResult.verified ?? false,
                    },
                };
            } catch (error) {
                if (isCancelledOperation(error, options.cancellable))
                    throw error;
                if (isComputerUseError(error))
                    throw error;

                throw createUserError(error.message ?? String(error), {
                    cause: error,
                    kind: 'operation',
                });
            }
        }

        const request = { ...(action ?? {}) };
        const needsCoordinates = hasComputerUseCoordinates(request);
        let coordinateTrace = null;

        if (needsCoordinates) {
            const observation = referencedObservation;

            if (!observation)
                throw createUserError('Observe this window before using coordinate-based computer actions.');

            if (this._coordinateRetryBlocked.has(actionWindowId)
                && observation.view?.type !== 'region') {
                throw createUserError(
                    coordinateRetryBlockMessage(
                        this._coordinateRetryBlockReasons.get(actionWindowId),
                    ),
                );
            }

            coordinateTrace = mapActionCoordinates(request, observation);
        }

        delete request.coordinateSpace;
        delete request.observationId;

        const result = unpackJson(await this._run(
            'PerformAction',
            new GLib.Variant('(s)', [JSON.stringify(request)]),
            options,
        ), 'PerformAction');

        if (!coordinateTrace)
            return result;

        const resolved = result.coordinates ?? {};
        return {
            ...result,
            coordinates: {
                ...coordinateTrace,
                window: resolved.window ?? coordinateTrace.window,
                desktop: resolved.desktop ?? null,
                endWindow: resolved.endWindow ?? null,
                endDesktop: resolved.endDesktop ?? null,
            },
        };
    }

    async step(actions, options = {}) {
        const actionList = Array.isArray(actions) ? actions : [];
        validateComputerUseStepActions(actionList);
        const windowId = String(actionList[0]?.windowId ?? '').trim();
        const requestedCoordinateAction = actionList.some(hasComputerUseCoordinates);
        const actionObservation = this._resolveObservation(
            windowId,
            actionList[0]?.observationId,
        );
        if (requestedCoordinateAction
            && this._coordinateRetryBlocked.has(windowId)
            && actionObservation?.view?.type !== 'region') {
            throw createUserError(
                coordinateRetryBlockMessage(
                    this._coordinateRetryBlockReasons.get(windowId),
                ),
            );
        }

        const previousObservation = this._observations.get(windowId) ?? null;
        const results = [];
        const startedAt = GLib.get_monotonic_time();
        let preActionMilliseconds = 0;
        let actionMilliseconds = 0;
        let failure = null;
        let preActionVerification = null;
        let preconditionObservation = null;

        for (const [index, action] of actionList.entries()) {
            const coordinateAction = hasComputerUseCoordinates(action);

            if (coordinateAction) {
                const preActionStartedAt = GLib.get_monotonic_time();
                const referencedObservation = this._resolveObservation(
                    windowId,
                    action.observationId,
                );
                let liveState;

                try {
                    liveState = await this._verifyLiveCoordinateState(
                        windowId,
                        referencedObservation,
                        options,
                    );
                } finally {
                    preActionMilliseconds += elapsedMilliseconds(preActionStartedAt);
                }

                preActionVerification = {
                    matched: liveState.matched,
                    screenChanged: liveState.screenChanged,
                    visualChange: liveState.visualChange,
                    focused: liveState.focused,
                    referenceObservationId: liveState.referenceObservationId,
                    referenceRootObservationId: liveState.referenceRootObservationId,
                    freshObservationId: liveState.observation?.observationId ?? null,
                    actionIndex: index,
                    action: String(action.action ?? 'unknown'),
                    actionDispatched: false,
                };

                if (!liveState.matched) {
                    const message = liveState.focused
                        ? 'The target UI changed before input could be dispatched. No action was sent.'
                        : 'The target window lost focus before input could be dispatched. No action was sent.';

                    failure = {
                        phase: 'precondition',
                        actionIndex: index,
                        action: String(action.action ?? 'unknown'),
                        kind: 'stale_observation',
                        message,
                    };
                    preconditionObservation = liveState.observation;
                    break;
                }
            }

            const actionStartedAt = GLib.get_monotonic_time();

            try {
                if (coordinateAction)
                    preActionVerification.actionDispatched = true;
                results.push(await this.act(action, options));
            } catch (error) {
                if (isCancelledOperation(error, options.cancellable))
                    throw error;
                if (!isComputerUseError(error)) {
                    logError(
                        error,
                        `Unexpected computer-step failure at action ${index + 1}`,
                    );
                }

                failure = {
                    phase: 'action',
                    actionIndex: index,
                    action: String(action.action ?? 'unknown'),
                    kind: error.computerUseErrorKind ?? 'operation',
                    message: error.userMessage ?? error.message ?? String(error),
                };
                break;
            } finally {
                actionMilliseconds += elapsedMilliseconds(actionStartedAt);
            }
        }

        const settleMs = failure?.phase === 'precondition'
            ? 0
            : Math.min(
                MAX_STEP_SETTLE_MS,
                Math.max(0, Math.round(Number(options.settleMs) || 0)),
            );
        await delay(settleMs);
        const observationStartedAt = GLib.get_monotonic_time();
        let observation = preconditionObservation;
        let observationError = null;

        if (!preconditionObservation) {
            try {
                observation = await this.observe(windowId, {
                    ...options,
                    preserveCoordinateBlock: true,
                });
            } catch (error) {
                if (isCancelledOperation(error, options.cancellable))
                    throw error;
                if (!isComputerUseError(error))
                    logError(error, 'Unexpected computer-step observation failure');

                observationError = error.userMessage ?? error.message ?? String(error);
                if (!failure) {
                    failure = {
                        phase: 'observation',
                        actionIndex: null,
                        action: null,
                        kind: error.computerUseErrorKind ?? 'operation',
                        message: observationError,
                    };
                }
            }
        }

        const expectations = Array.isArray(options.expectations) ? options.expectations : [];
        const waitTimeoutMs = Math.min(
            MAX_STEP_SETTLE_MS,
            Math.max(0, Math.round(Number(options.waitTimeoutMs) || 0)),
        );
        const waitStartedAt = GLib.get_monotonic_time();
        let expectationResult = evaluateComputerUseExpectations(observation, expectations);

        while (!failure
            && observation
            && expectations.length > 0
            && !expectationResult.met
            && elapsedMilliseconds(waitStartedAt) < waitTimeoutMs) {
            const remainingMs = waitTimeoutMs - elapsedMilliseconds(waitStartedAt);
            await delay(Math.min(200, Math.max(0, remainingMs)));

            try {
                observation = await this.observe(windowId, {
                    ...options,
                    preserveCoordinateBlock: true,
                });
            } catch (error) {
                if (isCancelledOperation(error, options.cancellable))
                    throw error;
                if (!isComputerUseError(error)) {
                    logError(
                        error,
                        'Unexpected computer-step expectation observation failure',
                    );
                }

                observationError = error.userMessage ?? error.message ?? String(error);
                failure = {
                    phase: 'observation',
                    actionIndex: null,
                    action: null,
                    kind: error.computerUseErrorKind ?? 'operation',
                    message: observationError,
                };
                break;
            }
            expectationResult = evaluateComputerUseExpectations(observation, expectations);
        }

        if (failure && observationError && failure.phase === 'action')
            failure.observationError = observationError;

        const currentObservation = observation
            ? this._observations.get(windowId) ?? null
            : null;
        const visualChange = compareVisualSignatures(
            previousObservation?.visualSignature,
            currentObservation?.visualSignature,
        );
        const screenChanged = observation && previousObservation
            ? visualChange.changed
                ?? (previousObservation.fingerprint !== currentObservation?.fingerprint)
            : null;
        const semanticActions = results.filter(result => (
            result.performed === 'click_element' || result.performed === 'set_text_element'
        ));
        const semanticActionsVerified = semanticActions.length > 0
            ? semanticActions.every(result => result.verified === true)
            : null;
        const inputResults = results.filter(result => (
            result.performed === 'paste_text'
            || result.performed === 'type'
            || result.performed === 'set_text_element'
        ));
        const semanticInputResults = inputResults.filter(result => (
            result.performed === 'set_text_element'
        ));
        const inputExpectations = expectationResult.results.filter(result => (
            result.state === 'value_equals' || result.state === 'value_contains'
        ));
        let inputVerified = null;

        if (semanticInputResults.length > 0) {
            inputVerified = semanticInputResults.every(result => result.verified === true);
        } else if (inputResults.length > 0 && inputExpectations.length > 0) {
            inputVerified = inputExpectations.every(result => result.passed === true);
        }
        let unchangedCount = this._unchangedStepCounts.get(windowId) ?? 0;
        let coordinateMissCount = this._unchangedCoordinateStepCounts.get(windowId) ?? 0;
        const attemptedActionCount = results.length
            + (failure?.phase === 'action' ? 1 : 0);
        const attemptedCoordinateAction = actionList
            .slice(0, attemptedActionCount)
            .some(hasComputerUseCoordinates);
        let lastPointerResult = null;

        for (let index = 0; index < results.length; index++) {
            if (actionList[index]?.action === 'click'
                || actionList[index]?.action === 'double_click') {
                lastPointerResult = results[index];
            }
        }
        let visualStateCycleDetected = false;

        if (!failure && observation) {
            unchangedCount = screenChanged === false && semanticActionsVerified !== true
                ? unchangedCount + 1
                : 0;

            if (attemptedCoordinateAction) {
                coordinateMissCount = screenChanged === false && semanticActionsVerified !== true
                    ? coordinateMissCount + 1
                    : 0;
            } else if (screenChanged === true || semanticActionsVerified === true) {
                coordinateMissCount = 0;
            }

            if (lastPointerResult && currentObservation) {
                const history = [
                    ...(this._visualStateHistories.get(windowId) ?? []),
                ];

                if (history.length === 0 && previousObservation) {
                    history.push(observationVisualState(previousObservation));
                }
                history.push(observationVisualState(currentObservation));
                while (history.length > VISUAL_STATE_HISTORY_LIMIT)
                    history.shift();

                visualStateCycleDetected = hasAlternatingVisualStateCycle(history);
                this._visualStateHistories.set(windowId, history);
            } else if (currentObservation && screenChanged === true) {
                this._visualStateHistories.set(
                    windowId,
                    [observationVisualState(currentObservation)],
                );
            }

            this._unchangedStepCounts.set(windowId, unchangedCount);
            this._unchangedCoordinateStepCounts.set(windowId, coordinateMissCount);
            if (visualStateCycleDetected) {
                this._coordinateRetryBlocked.add(windowId);
                this._coordinateRetryBlockReasons.set(windowId, 'visual_state_cycle');
            } else if (coordinateMissCount >= STALLED_STEP_THRESHOLD) {
                this._coordinateRetryBlocked.add(windowId);
                this._coordinateRetryBlockReasons.set(windowId, 'unchanged_steps');
            } else if (coordinateMissCount === 0) {
                this._coordinateRetryBlocked.delete(windowId);
                this._coordinateRetryBlockReasons.delete(windowId);
            }
        }

        let autoZoom = null;

        if (!failure
            && observation
            && currentObservation
            && lastPointerResult
            && expectations.length === 0) {
            const zoom = automaticZoomRegion(visualChange, lastPointerResult);

            if (zoom) {
                try {
                    const rootObservationId = currentObservation.observationId;
                    const zoomMetadata = {
                        reason: 'localized_post_click_change',
                        changedBounds: zoom.changedBounds,
                        triggerPoint: zoom.triggerPoint,
                    };
                    observation = await this.observeRegion(
                        windowId,
                        rootObservationId,
                        zoom.region,
                        {
                            source: 'localized_change_region',
                            unlockCoordinateRetry: false,
                            autoZoom: zoomMetadata,
                        },
                    );
                    autoZoom = {
                        applied: true,
                        ...zoomMetadata,
                        observationId: observation.observationId,
                        rootObservationId,
                        region: observation.view?.normalized ?? zoom.region,
                    };
                } catch (error) {
                    logRecoverableComputerUseError(
                        error,
                        'Failed to enlarge a localized post-click change',
                    );
                }
            }
        }

        const observationMilliseconds = elapsedMilliseconds(observationStartedAt);

        return {
            failed: Boolean(failure),
            partial: Boolean(failure && results.length > 0),
            failedActionIndex: failure?.actionIndex ?? null,
            completedActionCount: results.length,
            failure,
            performed: results.map(result => result.performed ?? 'unknown'),
            results,
            observation,
            autoZoom,
            verification: {
                screenChanged,
                visualChange,
                focused: observation ? Boolean(observation.window?.focused) : null,
                unchangedCount,
                stalled: unchangedCount >= STALLED_STEP_THRESHOLD,
                coordinateMissCount,
                coordinateRetryBlocked: this._coordinateRetryBlocked.has(windowId),
                coordinateRetryBlockReason: this._coordinateRetryBlockReasons.get(windowId) ?? null,
                visualStateCycleDetected,
                visualStateCycleLength: visualStateCycleDetected ? 2 : null,
                semanticActionsVerified,
                inputVerified,
                preAction: preActionVerification,
                expectationsMet: observation && expectations.length > 0
                    ? expectationResult.met
                    : null,
                expectations: expectationResult.results,
            },
            timing: {
                totalMs: elapsedMilliseconds(startedAt),
                preActionMs: preActionMilliseconds,
                actionMs: actionMilliseconds,
                settleMs,
                observationMs: observationMilliseconds,
            },
        };
    }

    finishTurn(cancellable) {
        if (!cancellable || this._activeTurnCancellable !== cancellable)
            return false;

        const wasActive = this.active;
        this._activeTurnCancellable = null;
        if (wasActive && !this.active)
            this._setActivePresentation(false);
        return true;
    }

    stop() {
        const wasActive = this.active || this._presentedActive;

        for (const cancellable of this._activeCancellables) {
            if (!cancellable.is_cancelled())
                cancellable.cancel();
        }
        if (this._activeTurnCancellable && !this._activeTurnCancellable.is_cancelled())
            this._activeTurnCancellable.cancel();
        this._activeTurnCancellable = null;
        if (wasActive)
            this._setActivePresentation(false);
        return wasActive;
    }

    async setEnabled(enabled) {
        if (enabled)
            return await this.status();

        this.stop();
        await this._setRemoteActive(false);
        return { available: false, reason: 'Computer use is disabled.' };
    }

    shutdown() {
        this.stop();

        if (this._registered && this._proxy) {
            try {
                this._proxy.call_sync('Unregister', null, Gio.DBusCallFlags.NONE, 1_000, null);
            } catch (_error) {
                // GNOME Shell may already be shutting down.
            }
        }

        if (this._proxySignalId && this._proxy)
            this._proxy.disconnect(this._proxySignalId);
        if (this._proxyOwnerSignalId && this._proxy)
            this._proxy.disconnect(this._proxyOwnerSignalId);

        this._proxySignalId = 0;
        this._proxyOwnerSignalId = 0;
        this._registered = false;
        this._proxy = null;
        this._activeTurnCancellable = null;
        this._presentedActive = false;
        this._observations.clear();
        this._observationViews.clear();
        this._unchangedStepCounts.clear();
        this._unchangedCoordinateStepCounts.clear();
        this._coordinateRetryBlocked.clear();
        this._coordinateRetryBlockReasons.clear();
        this._visualStateHistories.clear();
        this._accessibility?.shutdown?.();

        try {
            removeDirectory(this._sessionDirectory);
        } catch (error) {
            logError(error, 'Failed to remove computer-use screenshot cache');
        }
    }
}
