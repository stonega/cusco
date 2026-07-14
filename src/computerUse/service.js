import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

export const COMPUTER_USE_BUS_NAME = 'org.gnome.Shell';
export const COMPUTER_USE_OBJECT_PATH = '/io/github/stonega/Cusco/ComputerUse';
export const COMPUTER_USE_INTERFACE = 'io.github.stonega.Cusco.ComputerUse';
export const COMPUTER_USE_PROTOCOL_VERSION = 1;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

function createUserError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
}

function integrationErrorMessage(error) {
    const message = String(error?.message ?? error ?? '');

    if (/UnknownMethod|UnknownObject|Object does not exist|No such interface/i.test(message)) {
        return 'GNOME Shell integration is not installed, enabled, or loaded. Install the current Cusco build, log out and back in, then enable cusco-computer-use@stonega.';
    }

    if (/ServiceUnknown|NameHasNoOwner/i.test(message))
        return 'GNOME Shell is unavailable on this session.';

    return message || 'GNOME Shell integration is unavailable.';
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
        this._onActiveChanged = options.onActiveChanged ?? (() => {});
        this._onStopRequested = options.onStopRequested ?? (() => {});
        this._proxy = options.proxy ?? null;
        this._registered = false;
        this._activeCount = 0;
        this._activeCancellables = new Set();
        this._activeTurnCancellable = null;
        this._observations = new Map();
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
        const environment = environmentStatus();

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
            const result = unpackJson(await callProxy(proxy, 'GetStatus'), 'GetStatus');
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

        const environment = environmentStatus();
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
            throw createUserError(integrationErrorMessage(error));
        }

        if (result.protocolVersion !== COMPUTER_USE_PROTOCOL_VERSION) {
            throw createUserError(
                `GNOME integration protocol mismatch (app ${COMPUTER_USE_PROTOCOL_VERSION}, extension ${result.protocolVersion ?? 'unknown'}).`,
            );
        }

        this._registered = true;
    }

    _requireEnabled() {
        if (!this._settings?.computerUseEnabled)
            throw createUserError('Computer use is disabled. Enable it in Settings → Workspace.');
    }

    async _setRemoteActive(active) {
        if (!this._registered)
            return;

        try {
            await callProxy(
                this._getProxy(),
                'SetActive',
                new GLib.Variant('(b)', [Boolean(active)]),
                null,
                2_000,
            );
        } catch (error) {
            logError(error, 'Failed to update computer-use indicator');
        }
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
        if (!wasActive) {
            this._onActiveChanged(true);
            await this._setRemoteActive(true);
        }

        try {
            return await callProxy(
                this._getProxy(),
                method,
                parameters,
                cancellable,
                Math.max(1_000, (this._settings?.computerUseActionTimeoutSeconds ?? 30) * 1_000),
            );
        } finally {
            this._activeCancellables.delete(cancellable);
            this._activeCount = Math.max(0, this._activeCount - 1);
            if (!this.active) {
                await this._setRemoteActive(false);
                this._onActiveChanged(false);
            }
        }
    }

    async listDesktop(options = {}) {
        return unpackJson(await this._run('ListDesktop', null, options), 'ListDesktop');
    }

    async observe(windowId, options = {}) {
        if (!this._settings?.computerUseCaptureEnabled)
            throw createUserError('Screen capture is disabled in Settings → Workspace.');

        const response = unpackJson(await this._run(
            'CaptureWindow',
            new GLib.Variant('(s)', [String(windowId ?? '')]),
            options,
        ), 'CaptureWindow');
        const encoded = String(response.imageBase64 ?? '');
        const bytes = GLib.base64_decode(encoded);

        if (!encoded || bytes.length === 0)
            throw createUserError('GNOME Shell returned an empty screenshot.');

        if (bytes.length > MAX_SCREENSHOT_BYTES)
            throw createUserError('Screenshot exceeded the 25 MB safety limit.');

        GLib.mkdir_with_parents(this._sessionDirectory, 0o700);
        const path = GLib.build_filenamev([
            this._sessionDirectory,
            `window-${String(windowId).replace(/[^A-Za-z0-9_-]/g, '_')}-${GLib.uuid_string_random()}.png`,
        ]);
        GLib.file_set_contents(path, bytes);
        GLib.chmod(path, 0o600);
        const dimensions = pngDimensions(bytes) ?? {
            width: Number(response.width) || Number(response.window?.width) || 1,
            height: Number(response.height) || Number(response.window?.height) || 1,
        };
        this._observations.set(String(windowId), {
            imageWidth: dimensions.width,
            imageHeight: dimensions.height,
            frameWidth: Number(response.window?.width) || dimensions.width,
            frameHeight: Number(response.window?.height) || dimensions.height,
        });
        delete response.imageBase64;
        return {
            ...response,
            width: dimensions.width,
            height: dimensions.height,
            imagePath: path,
        };
    }

    async act(action, options = {}) {
        if (!this._settings?.computerUseInputEnabled)
            throw createUserError('Computer input control is disabled in Settings → Workspace.');

        if (action?.action === 'switch_workspace' && !this._settings?.computerUseWorkspaceSwitchingEnabled) {
            throw createUserError('Workspace switching is disabled in Settings → Workspace.');
        }

        const request = { ...(action ?? {}) };
        const coordinateActions = new Set(['click', 'double_click', 'move', 'scroll', 'drag']);
        const needsCoordinates = coordinateActions.has(request.action)
            || (request.action === 'type' && (request.x !== undefined || request.y !== undefined));

        if (needsCoordinates) {
            const observation = this._observations.get(String(request.windowId ?? ''));

            if (!observation)
                throw createUserError('Observe this window before using coordinate-based computer actions.');

            const scaleX = observation.frameWidth / Math.max(1, observation.imageWidth);
            const scaleY = observation.frameHeight / Math.max(1, observation.imageHeight);
            if (Number.isFinite(request.x))
                request.x *= scaleX;
            if (Number.isFinite(request.y))
                request.y *= scaleY;
            if (Number.isFinite(request.endX))
                request.endX *= scaleX;
            if (Number.isFinite(request.endY))
                request.endY *= scaleY;
        }

        return unpackJson(await this._run(
            'PerformAction',
            new GLib.Variant('(s)', [JSON.stringify(request)]),
            options,
        ), 'PerformAction');
    }

    finishTurn(cancellable) {
        if (!cancellable || this._activeTurnCancellable !== cancellable)
            return false;

        const wasActive = this.active;
        this._activeTurnCancellable = null;
        if (wasActive && !this.active) {
            this._setRemoteActive(false);
            this._onActiveChanged(false);
        }
        return true;
    }

    stop() {
        const wasActive = this.active;

        for (const cancellable of this._activeCancellables) {
            if (!cancellable.is_cancelled())
                cancellable.cancel();
        }
        if (this._activeTurnCancellable && !this._activeTurnCancellable.is_cancelled())
            this._activeTurnCancellable.cancel();
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
        this._observations.clear();

        try {
            removeDirectory(this._sessionDirectory);
        } catch (error) {
            logError(error, 'Failed to remove computer-use screenshot cache');
        }
    }
}
