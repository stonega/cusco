import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { BackgroundAccessibilityProxy } from './backgroundAccessibility.js';
import { BackgroundComputerUseSession } from './backgroundSession.js';
import { createComputerUseError } from './protocol.js';
import { ComputerUseService } from './service.js';

export const COMPUTER_USE_MODE_BACKGROUND = 'background';
export const COMPUTER_USE_MODE_CURRENT_DESKTOP = 'current-desktop';

export function normalizeComputerUseMode(value) {
    return value === COMPUTER_USE_MODE_CURRENT_DESKTOP
        ? COMPUTER_USE_MODE_CURRENT_DESKTOP
        : COMPUTER_USE_MODE_BACKGROUND;
}

class BackgroundComputerUseService extends ComputerUseService {
    constructor(options = {}) {
        super({ ...options, accessibility: null });
        this._runtime = options.runtime ?? new BackgroundComputerUseSession({
            onStarting: () => this._onActiveChanged(this.active),
            onStopped: () => {
                this._registered = false;
                if (this.active) {
                    this.stop();
                    this._onStopRequested();
                }
                this._onActiveChanged(this.active);
            },
        });
    }

    _getProxy() {
        if (!this._proxy)
            throw createComputerUseError('The background desktop is not connected.');
        return this._proxy;
    }

    get running() {
        return this._runtime.running || this._runtime.starting;
    }

    async _register() {
        let proxy;

        try {
            proxy = await this._runtime.start();
        } catch (error) {
            throw createComputerUseError(
                `Could not start the background desktop: ${error.message ?? error}`,
                { cause: error, kind: 'integration' },
            );
        }

        if (this._proxy !== proxy) {
            this._accessibility?.shutdown?.();
            this._accessibility = null;
            this._adoptProxy(proxy);
        }
        if (!this._accessibility && this._runtime.accessibilityProxy)
            this._accessibility = new BackgroundAccessibilityProxy(this._runtime.accessibilityProxy);

        await super._register();
    }

    async status() {
        const runtimeStatus = this._runtime.status();
        if (!runtimeStatus.running)
            return { ...runtimeStatus, registered: false };
        return { ...await super.status(), mode: COMPUTER_USE_MODE_BACKGROUND, running: true };
    }

    async setEnabled(enabled) {
        if (enabled)
            return await this.status();

        this.shutdown();
        return { supported: true, available: false, reason: 'Computer use is disabled.' };
    }

    async launchApplication(appId, executable) {
        await this._register();
        await this._runtime.launchDesktopApp(appId, executable);
    }

    async captureDesktopPreview(cancellable = null) {
        if (!this._runtime.running)
            throw createComputerUseError('The background desktop is not running.');

        await this._register();
        const reply = await this._callRegistered('CaptureDesktop', null, cancellable, 10_000);
        const [json] = reply.deepUnpack();
        const response = JSON.parse(json);
        const bytes = GLib.base64_decode(String(response.imageBase64 ?? ''));
        if (response.mimeType !== 'image/png' || bytes.length === 0 || bytes.length > 25 * 1024 * 1024
            || !Number.isInteger(response.width) || response.width <= 0
            || !Number.isInteger(response.height) || response.height <= 0) {
            throw createComputerUseError('The background desktop returned an invalid preview.');
        }

        return { bytes, width: response.width, height: response.height };
    }

    shutdown() {
        super.shutdown();
        this._accessibility = null;
        this._runtime.stop();
    }
}

export class ComputerUseManager {
    constructor(options = {}) {
        this._settings = options.settings;
        this._onActiveChanged = options.onActiveChanged ?? (() => {});
        this._onStopRequested = options.onStopRequested ?? (() => {});
        this._mode = COMPUTER_USE_MODE_BACKGROUND;
        this._turnCancellable = null;

        const serviceOptions = {
            settings: this._settings,
            onActiveChanged: () => this._onActiveChanged(this.active),
            onStopRequested: () => this._onStopRequested(),
        };
        this._currentDesktop = options.currentDesktop ?? new ComputerUseService(serviceOptions);
        this._background = options.background ?? new BackgroundComputerUseService(serviceOptions);
    }

    get mode() {
        return this._mode;
    }

    get active() {
        return this._currentDesktop.active || this._background.active;
    }

    get backgroundRunning() {
        return this._background.running;
    }

    async captureBackgroundDesktopPreview(cancellable = null) {
        if (this._mode !== COMPUTER_USE_MODE_BACKGROUND || !this._settings?.computerUseCaptureEnabled)
            throw createComputerUseError('Background desktop preview is unavailable.');
        return await this._background.captureDesktopPreview(cancellable);
    }

    get activeTurnCancellable() {
        return this._background.activeTurnCancellable
            ?? this._currentDesktop.activeTurnCancellable;
    }

    isTurnActive(cancellable) {
        return this._currentDesktop.isTurnActive(cancellable)
            || this._background.isTurnActive(cancellable);
    }

    _selected() {
        return this._mode === COMPUTER_USE_MODE_CURRENT_DESKTOP
            ? this._currentDesktop
            : this._background;
    }

    _prepareTurn(options = {}) {
        const cancellable = options.cancellable;
        if (!cancellable || cancellable === this._turnCancellable)
            return;

        if (this._turnCancellable && !this._turnCancellable.is_cancelled?.()) {
            throw createComputerUseError('Computer use is active in another chat. Stop or finish it before continuing here.');
        }
        const owner = this.activeTurnCancellable;
        if (owner && owner !== cancellable && !owner.is_cancelled?.()) {
            throw createComputerUseError('Computer use is active in another chat. Stop or finish it before continuing here.');
        }

        this.setMode(COMPUTER_USE_MODE_BACKGROUND);
        this._turnCancellable = cancellable;
    }

    setMode(value, options = {}) {
        const mode = normalizeComputerUseMode(value);
        if (mode === this._mode)
            return mode;

        if (this._turnCancellable && this._turnCancellable !== options.cancellable
            && !this._turnCancellable.is_cancelled?.()) {
            throw createComputerUseError('Computer use is active in another chat. Stop or finish it before changing desktops.');
        }
        const owner = this.activeTurnCancellable;
        if (owner && owner !== options.cancellable && !owner.is_cancelled?.()) {
            throw createComputerUseError('Computer use is active in another chat. Stop or finish it before changing desktops.');
        }
        if (owner === options.cancellable)
            this._selected().finishTurn(options.cancellable);
        this._selected().shutdown();
        this._mode = mode;
        this._onActiveChanged(this.active);
        return mode;
    }

    async status() {
        return await (this._turnCancellable ? this._selected() : this._background).status();
    }

    async setEnabled(enabled) {
        if (!enabled) {
            this._currentDesktop.stop();
            this._background.shutdown();
            this._mode = COMPUTER_USE_MODE_BACKGROUND;
            this._turnCancellable = null;
            this._onActiveChanged(this.active);
            return { supported: true, available: false, reason: 'Computer use is disabled.' };
        }
        return await (this._turnCancellable ? this._selected() : this._background).setEnabled(enabled);
    }

    async listDesktop(options = {}) {
        if (options.mode !== undefined) {
            if (options.mode !== COMPUTER_USE_MODE_BACKGROUND
                && options.mode !== COMPUTER_USE_MODE_CURRENT_DESKTOP) {
                throw createComputerUseError('Computer use mode must be background or current-desktop.');
            }
        }
        this._prepareTurn(options);
        if (options.mode !== undefined)
            this.setMode(options.mode, options);
        const desktop = await this._selected().listDesktop(options);
        return { ...desktop, mode: this._mode };
    }

    async launchApplication(query, options = {}) {
        this._prepareTurn(options);
        if (!this._settings?.computerUseEnabled || !this._settings?.computerUseInputEnabled)
            throw createComputerUseError('Enable Computer Use and pointer and keyboard input before opening an application.');

        const requested = String(query ?? '').trim();
        if (!requested)
            throw createComputerUseError('Specify an application name or desktop ID.');

        const apps = Gio.AppInfo.get_all().filter(app => app.get_id()?.endsWith('.desktop'));
        const normalized = requested.toLowerCase();
        const exact = apps.filter(app => (
            app.get_id()?.toLowerCase() === normalized
            || app.get_display_name()?.toLowerCase() === normalized
            || app.get_name()?.toLowerCase() === normalized
        ));
        const matches = exact.length > 0
            ? exact
            : apps.filter(app => (
                app.get_display_name()?.toLowerCase().includes(normalized)
                || app.get_name()?.toLowerCase().includes(normalized)
            ));

        if (matches.length !== 1) {
            const names = matches.slice(0, 8).map(app => app.get_display_name()).join(', ');
            throw createComputerUseError(matches.length === 0
                ? `No installed application matches “${requested}”.`
                : `Several applications match “${requested}”: ${names}. Use a desktop ID or exact name.`);
        }

        const app = matches[0];
        if (this._mode === COMPUTER_USE_MODE_BACKGROUND)
            await this._background.launchApplication(app.get_id(), app.get_executable());
        else if (!app.launch([], null))
            throw createComputerUseError(`Could not open ${app.get_display_name()}.`);

        return {
            application: app.get_display_name(),
            appId: app.get_id(),
            mode: this._mode,
            launched: true,
        };
    }

    async observe(windowId, options = {}) {
        this._prepareTurn(options);
        return await this._selected().observe(windowId, options);
    }

    async observeRegion(windowId, observationId, region, options = {}) {
        this._prepareTurn(options);
        return await this._selected().observeRegion(windowId, observationId, region, options);
    }

    async act(action, options = {}) {
        this._prepareTurn(options);
        return await this._selected().act(action, options);
    }

    async step(actions, options = {}) {
        this._prepareTurn(options);
        return await this._selected().step(actions, options);
    }

    finishTurn(cancellable) {
        const finished = this._currentDesktop.finishTurn(cancellable)
            || this._background.finishTurn(cancellable);
        if (cancellable && this._turnCancellable === cancellable)
            this._turnCancellable = null;
        return finished;
    }

    async exitTurn(cancellable) {
        const exited = await this._currentDesktop.exitTurn(cancellable)
            || await this._background.exitTurn(cancellable);
        if (cancellable && this._turnCancellable === cancellable)
            this._turnCancellable = null;
        return exited;
    }

    stop() {
        this._turnCancellable = null;
        const currentStopped = this._currentDesktop.stop();
        const backgroundStopped = this._background.stop();
        const backgroundRunning = this._background.running;
        if (backgroundRunning)
            this._background.shutdown();
        this._onActiveChanged(this.active);
        return currentStopped || backgroundStopped || backgroundRunning;
    }

    shutdown() {
        this._turnCancellable = null;
        this._mode = COMPUTER_USE_MODE_BACKGROUND;
        this._currentDesktop.shutdown();
        this._background.shutdown();
    }
}
