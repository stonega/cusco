import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    BACKGROUND_ACCESSIBILITY_BUS_NAME,
    BACKGROUND_ACCESSIBILITY_INTERFACE,
    BACKGROUND_ACCESSIBILITY_OBJECT_PATH,
} from './backgroundAccessibility.js';
import {
    COMPUTER_USE_BUS_NAME,
    COMPUTER_USE_INTERFACE,
    COMPUTER_USE_OBJECT_PATH,
} from './service.js';

const EXTENSION_UUID = 'cusco-computer-use@stonega';
const START_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;
const VIRTUAL_MONITOR = '1280x800';
const PROCESS_FLAGS = Gio.SubprocessFlags.STDOUT_SILENCE
    | Gio.SubprocessFlags.STDERR_SILENCE;
let headlessSupport = null;

function fileExists(path) {
    return Gio.File.new_for_path(path).query_exists(null);
}

function delay(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function extensionPath() {
    const modulePath = Gio.File.new_for_uri(import.meta.url).get_path();
    const sourcePath = GLib.build_filenamev([
        GLib.path_get_dirname(modulePath), '..', '..', 'data',
        'gnome-shell', 'extensions', EXTENSION_UUID,
    ]);
    const userPath = GLib.build_filenamev([
        GLib.get_user_data_dir(), 'gnome-shell', 'extensions', EXTENSION_UUID,
    ]);
    const systemPath = GLib.build_filenamev([
        '/usr', 'share', 'gnome-shell', 'extensions', EXTENSION_UUID,
    ]);

    return [sourcePath, userPath, systemPath].find(path => (
        fileExists(GLib.build_filenamev([path, 'extension.js']))
    )) ?? null;
}

function accessibilityLauncherPath() {
    return [
        '/usr/libexec/at-spi-bus-launcher',
        '/usr/lib/at-spi2-core/at-spi-bus-launcher',
    ].find(fileExists) ?? null;
}

function accessibilityRegistryPath() {
    return [
        '/usr/libexec/at-spi2-registryd',
        '/usr/lib/at-spi2-core/at-spi2-registryd',
    ].find(fileExists) ?? null;
}

function capability() {
    if (!GLib.find_program_in_path('gnome-shell')
        || !GLib.find_program_in_path('dbus-daemon')
        || !GLib.find_program_in_path('gsettings')
        || !GLib.find_program_in_path('gtk-launch')) {
        return {
            supported: false,
            available: false,
            reason: 'Background computer use requires GNOME Shell, dbus-daemon, gsettings, and gtk-launch.',
        };
    }

    if (!extensionPath()) {
        return {
            supported: false,
            available: false,
            reason: 'The Cusco GNOME Shell extension is not installed.',
        };
    }

    if (headlessSupport === null) {
        try {
            const [spawned, output, , exitStatus] = GLib.spawn_command_line_sync('gnome-shell --help');
            const help = String.fromCharCode(...output);
            headlessSupport = spawned && exitStatus === 0
                && ['--headless', '--virtual-monitor', '--wayland-display'].every(flag => help.includes(flag));
        } catch (_error) {
            headlessSupport = false;
        }
    }
    if (!headlessSupport) {
        return {
            supported: false,
            available: false,
            reason: 'This GNOME Shell build does not provide headless virtual monitors.',
        };
    }

    if (!GLib.get_user_runtime_dir()) {
        return {
            supported: false,
            available: false,
            reason: 'A user runtime directory is required for background computer use.',
        };
    }

    return { supported: true, available: true, reason: '' };
}

function launch(argv, environment, flags = PROCESS_FLAGS) {
    const launcher = new Gio.SubprocessLauncher({ flags });

    for (const name of ['DISPLAY', 'XAUTHORITY', 'AT_SPI_BUS_ADDRESS'])
        launcher.unsetenv(name);

    for (const [name, value] of Object.entries(environment))
        launcher.setenv(name, value, true);

    return launcher.spawnv(argv);
}

function stopProcess(process) {
    if (!process)
        return;

    try {
        process.send_signal(15);
    } catch (_error) {
        // The process may have exited while the runtime was being stopped.
    }
}

function removeRuntimeDirectory(path) {
    if (!path)
        return;

    const directory = Gio.File.new_for_path(path);
    if (!directory.query_exists(null))
        return;

    const children = directory.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
    );
    let info;

    while ((info = children.next_file(null))) {
        const child = directory.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            removeRuntimeDirectory(child.get_path());
        else
            child.delete(null);
    }

    children.close(null);
    directory.delete(null);
}

function runCommand(argv, environment) {
    return new Promise((resolve, reject) => {
        let process;

        try {
            process = launch(argv, environment);
        } catch (error) {
            reject(error);
            return;
        }

        process.wait_async(null, (_process, result) => {
            try {
                process.wait_finish(result);
                if (process.get_exit_status() !== 0)
                    throw new Error(`${argv[0]} exited with status ${process.get_exit_status()}.`);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

export function backgroundBrowserCommand(appId, executable, profileRoot) {
    const id = String(appId ?? '').toLowerCase();
    const program = String(executable ?? '');
    const name = GLib.path_get_basename(program).toLowerCase();
    let profile = '';

    if (id.includes('firefox')) {
        if (!/^firefox(?:-esr|-developer-edition|-nightly)?$/.test(name))
            throw new Error(`Cannot safely open ${appId} with a separate browser profile.`);
        profile = GLib.build_filenamev([profileRoot, 'firefox']);
        GLib.mkdir_with_parents(profile, 0o700);
        return [program, '--no-remote', '--profile', profile];
    }

    if (id.includes('chromium') || id.includes('chrome')) {
        if (!/^(?:chromium(?:-browser)?|google-chrome(?:-stable|-beta|-unstable)?)$/.test(name))
            throw new Error(`Cannot safely open ${appId} with a separate browser profile.`);
        profile = GLib.build_filenamev([profileRoot, 'chromium']);
        GLib.mkdir_with_parents(profile, 0o700);
        return [program, `--user-data-dir=${profile}`, '--no-first-run', '--ozone-platform=wayland'];
    }

    if (/brave|vivaldi|librewolf|microsoft-edge|opera|tor-browser/.test(id))
        throw new Error(`Cannot safely open ${appId} with a separate browser profile.`);

    return null;
}

export class BackgroundComputerUseSession {
    constructor(options = {}) {
        this._onStarting = options.onStarting ?? (() => {});
        this._onStopped = options.onStopped ?? (() => {});
        this._sessionRoot = options.sessionRoot ?? GLib.build_filenamev([
            GLib.get_user_runtime_dir(),
            'cusco-cu',
        ]);
        this._profileRoot = options.profileRoot ?? GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'io.github.stonega.Cusco',
            'computer-use-background',
        ]);
        this._busProcess = null;
        this._shellProcess = null;
        this._accessibilityBusProcess = null;
        this._accessibilityRegistryProcess = null;
        this._accessibilityHostProcess = null;
        this._connection = null;
        this._proxy = null;
        this._accessibilityProxy = null;
        this._startPromise = null;
        this._generation = 0;
        this._runtimeDirectory = null;
        this._busExited = false;
        this._shellExited = false;
        this._lastStartError = '';
        this._environment = null;
        this._applications = new Set();
    }

    get running() {
        return Boolean(this._proxy && this._shellProcess && !this._shellExited && !this._busExited);
    }

    get starting() {
        return this._startPromise !== null;
    }

    get accessibilityProxy() {
        return this._accessibilityProxy;
    }

    status() {
        return {
            ...capability(),
            running: this.running,
            starting: this.starting,
            mode: 'background',
        };
    }

    async start() {
        if (this.running)
            return this._proxy;
        if (this._startPromise)
            return await this._startPromise;

        const status = this.status();
        if (!status.available)
            throw new Error(status.reason);

        const generation = ++this._generation;
        this._startPromise = this._start(generation);
        this._onStarting();

        try {
            return await this._startPromise;
        } catch (error) {
            if (generation === this._generation)
                this.stop();
            throw error;
        } finally {
            this._startPromise = null;
        }
    }

    async _start(generation) {
        const runtimeDirectory = GLib.build_filenamev([
            this._sessionRoot,
            GLib.uuid_string_random().slice(0, 8),
        ]);
        const configDirectory = GLib.build_filenamev([this._profileRoot, 'config']);
        const dataDirectory = GLib.build_filenamev([this._profileRoot, 'data']);
        const cacheDirectory = GLib.build_filenamev([this._profileRoot, 'cache']);
        const extensionDirectory = GLib.build_filenamev([
            dataDirectory, 'gnome-shell', 'extensions', EXTENSION_UUID,
        ]);

        for (const path of [runtimeDirectory, configDirectory, dataDirectory, cacheDirectory]) {
            GLib.mkdir_with_parents(path, 0o700);
            GLib.chmod(path, 0o700);
        }

        GLib.mkdir_with_parents(GLib.path_get_dirname(extensionDirectory), 0o700);
        const extensionFile = Gio.File.new_for_path(extensionDirectory);
        const selectedExtensionPath = extensionPath();
        if (extensionFile.query_exists(null)
            || GLib.file_test(extensionDirectory, GLib.FileTest.IS_SYMLINK)) {
            const extensionInfo = extensionFile.query_info(
                'standard::type,standard::symlink-target',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null,
            );
            if (extensionInfo.get_file_type() === Gio.FileType.SYMBOLIC_LINK
                && extensionInfo.get_symlink_target() !== selectedExtensionPath) {
                extensionFile.delete(null);
            } else if (extensionInfo.get_file_type() !== Gio.FileType.SYMBOLIC_LINK) {
                throw new Error('The background extension path is occupied by a non-symlink file.');
            }
        }
        if (!extensionFile.query_exists(null))
            extensionFile.make_symbolic_link(selectedExtensionPath, null);

        const busAddress = `unix:path=${runtimeDirectory}/bus`;
        const displayName = 'cusco-agent';
        const environment = {
            XDG_RUNTIME_DIR: runtimeDirectory,
            XDG_CONFIG_HOME: configDirectory,
            XDG_DATA_HOME: dataDirectory,
            XDG_CACHE_HOME: cacheDirectory,
            GSETTINGS_BACKEND: 'keyfile',
            GVFS_DISABLE_FUSE: '1',
            GTK_A11Y: 'atspi',
            DBUS_SESSION_BUS_ADDRESS: busAddress,
            WAYLAND_DISPLAY: displayName,
            GDK_BACKEND: 'wayland',
            QT_QPA_PLATFORM: 'wayland',
            MOZ_ENABLE_WAYLAND: '1',
        };

        this._runtimeDirectory = runtimeDirectory;
        this._environment = environment;
        this._busExited = false;
        this._busProcess = launch([
            'dbus-daemon', '--session', `--address=${busAddress}`, '--nofork', '--nopidfile',
        ], environment);
        this._watchProcess(this._busProcess, generation, 'bus');

        const startedAt = GLib.get_monotonic_time();
        while (!fileExists(`${runtimeDirectory}/bus`)) {
            this._checkStarting(generation, startedAt);
            if (this._busExited)
                throw new Error('The private background session bus stopped.');
            await delay(READY_POLL_MS);
        }

        this._connection = Gio.DBusConnection.new_for_address_sync(
            busAddress,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
                | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            null,
            null,
        );
        this._checkStarting(generation, startedAt);

        const accessibilityLauncher = accessibilityLauncherPath();
        if (accessibilityLauncher) {
            try {
                this._accessibilityBusProcess = launch([accessibilityLauncher], environment);
                for (let attempt = 0; attempt < 10; attempt++) {
                    this._checkStarting(generation, startedAt);
                    try {
                        const address = this._connection.call_sync(
                            'org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus',
                            'GetAddress', null, new GLib.VariantType('(s)'),
                            Gio.DBusCallFlags.NO_AUTO_START, 300, null,
                        ).deepUnpack()[0];
                        environment.AT_SPI_BUS_ADDRESS = address;
                        break;
                    } catch (_error) {
                        await delay(READY_POLL_MS);
                    }
                }
                const registry = accessibilityRegistryPath();
                if (environment.AT_SPI_BUS_ADDRESS && registry) {
                    this._accessibilityRegistryProcess = launch([
                        registry, '--use-gnome-session',
                    ], environment);
                }
            } catch (_error) {
                stopProcess(this._accessibilityRegistryProcess);
                stopProcess(this._accessibilityBusProcess);
                this._accessibilityRegistryProcess = null;
                this._accessibilityBusProcess = null;
                delete environment.AT_SPI_BUS_ADDRESS;
            }
        }

        await runCommand([
            'gsettings', 'set', 'org.gnome.shell', 'enabled-extensions',
            `["${EXTENSION_UUID}"]`,
        ], environment);
        this._checkStarting(generation, startedAt);

        this._shellExited = false;
        this._shellProcess = launch([
            'gnome-shell', '--headless', '--wayland', '--no-x11',
            '--virtual-monitor', VIRTUAL_MONITOR,
            '--wayland-display', displayName,
        ], environment);
        this._watchProcess(this._shellProcess, generation, 'shell', this._busProcess);

        while (true) {
            this._checkStarting(generation, startedAt);
            if (this._shellExited)
                throw new Error('The background GNOME Shell stopped during startup.');

            try {
                const introspection = this._connection.call_sync(
                    COMPUTER_USE_BUS_NAME,
                    COMPUTER_USE_OBJECT_PATH,
                    'org.freedesktop.DBus.Introspectable',
                    'Introspect',
                    null,
                    new GLib.VariantType('(s)'),
                    Gio.DBusCallFlags.NO_AUTO_START,
                    500,
                    null,
                ).deepUnpack()[0];

                if (!introspection.includes(COMPUTER_USE_INTERFACE)) {
                    this._lastStartError = `Bridge introspection: ${introspection.slice(0, 200)}`;
                    await delay(READY_POLL_MS);
                    continue;
                }

                const proxy = Gio.DBusProxy.new_sync(
                    this._connection,
                    Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                    null,
                    COMPUTER_USE_BUS_NAME,
                    COMPUTER_USE_OBJECT_PATH,
                    COMPUTER_USE_INTERFACE,
                    null,
                );

                if (proxy.get_name_owner()) {
                    this._proxy = proxy;
                    await this._startAccessibilityHost(generation, environment);
                    this._checkStarting(generation, startedAt);
                    return proxy;
                }
            } catch (error) {
                this._lastStartError = String(error?.message ?? error);
                // Shell has not exported the bridge yet.
            }

            await delay(READY_POLL_MS);
        }
    }

    async _startAccessibilityHost(generation, environment) {
        const modulePath = Gio.File.new_for_uri(import.meta.url).get_path();
        const hostPath = GLib.build_filenamev([
            GLib.path_get_dirname(modulePath), 'backgroundAccessibilityHost.js',
        ]);
        if (!GLib.find_program_in_path('gjs') || !fileExists(hostPath))
            return;

        try {
            this._accessibilityHostProcess = launch(['gjs', '-m', hostPath], environment);
            this._accessibilityHostProcess.wait_async(null, (process, result) => {
                try {
                    process.wait_finish(result);
                } catch (_error) {
                    // The helper can be stopped with its desktop.
                }
                if (generation === this._generation)
                    this._accessibilityProxy = null;
            });

            for (let attempt = 0; attempt < 10; attempt++) {
                if (generation !== this._generation)
                    return;
                try {
                    const introspection = this._connection.call_sync(
                        BACKGROUND_ACCESSIBILITY_BUS_NAME,
                        BACKGROUND_ACCESSIBILITY_OBJECT_PATH,
                        'org.freedesktop.DBus.Introspectable',
                        'Introspect', null, new GLib.VariantType('(s)'),
                        Gio.DBusCallFlags.NO_AUTO_START, 300, null,
                    ).deepUnpack()[0];
                    if (introspection.includes(BACKGROUND_ACCESSIBILITY_INTERFACE)) {
                        this._accessibilityProxy = Gio.DBusProxy.new_sync(
                            this._connection,
                            Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                            null,
                            BACKGROUND_ACCESSIBILITY_BUS_NAME,
                            BACKGROUND_ACCESSIBILITY_OBJECT_PATH,
                            BACKGROUND_ACCESSIBILITY_INTERFACE,
                            null,
                        );
                        return;
                    }
                } catch (_error) {
                    // The helper is not ready yet; visual targeting remains available.
                }
                await delay(READY_POLL_MS);
            }
        } catch (_error) {
            this._accessibilityProxy = null;
        }
    }

    _checkStarting(generation, startedAt) {
        if (generation !== this._generation)
            throw new Error('Background computer use was stopped during startup.');
        if ((GLib.get_monotonic_time() - startedAt) / 1000 > START_TIMEOUT_MS)
            throw new Error(`The background GNOME session did not start in time: ${this._lastStartError}`);
    }

    _watchProcess(process, generation, name, dependentProcess = null) {
        process.wait_async(null, (_process, result) => {
            try {
                process.wait_finish(result);
            } catch (_error) {
                // The process may have been terminated during shutdown.
            }

            if (generation !== this._generation) {
                if (name === 'shell')
                    stopProcess(dependentProcess);
                return;
            }

            if (name === 'bus')
                this._busExited = true;
            else
                this._shellExited = true;

            if (this._proxy)
                this.stop();
        });
    }

    launch(argv) {
        if (!this.running || !this._environment)
            throw new Error('The background desktop is not running.');
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every(value => typeof value === 'string' && value))
            throw new Error('A background application requires a nonempty argument vector.');

        const process = launch(argv, this._environment);
        this._applications.add(process);
        process.wait_async(null, (_process, result) => {
            try {
                process.wait_finish(result);
            } catch (_error) {
                // An application may be terminated when its desktop stops.
            }
            this._applications.delete(process);
        });
        return process;
    }

    async launchDesktopApp(appId, executable) {
        if (!this.running || !this._environment)
            throw new Error('The background desktop is not running.');
        if (!GLib.find_program_in_path('gtk-launch'))
            throw new Error('gtk-launch is required to open an application in the background desktop.');

        const browserCommand = backgroundBrowserCommand(appId, executable, this._profileRoot);
        if (browserCommand) {
            this.launch(browserCommand);
            return;
        }

        await runCommand(['gtk-launch', appId], this._environment);
    }

    stop() {
        ++this._generation;
        const wasRunning = Boolean(this._proxy || this._shellProcess || this._busProcess);
        this._proxy = null;
        this._accessibilityProxy = null;
        stopProcess(this._accessibilityHostProcess);
        stopProcess(this._accessibilityRegistryProcess);
        stopProcess(this._accessibilityBusProcess);
        this._accessibilityHostProcess = null;
        this._accessibilityRegistryProcess = null;
        this._accessibilityBusProcess = null;
        for (const application of this._applications)
            stopProcess(application);
        this._applications.clear();
        if (this._shellProcess && !this._shellExited)
            stopProcess(this._shellProcess);
        stopProcess(this._busProcess);
        this._shellProcess = null;
        this._busProcess = null;
        try {
            this._connection?.close_sync(null);
        } catch (_error) {
            // Closing a failed or already closed bus is harmless.
        }
        this._connection = null;
        this._environment = null;
        const runtimeDirectory = this._runtimeDirectory;
        let cleanupAttempts = 0;
        const cleanup = () => {
            try {
                removeRuntimeDirectory(runtimeDirectory);
                return GLib.SOURCE_REMOVE;
            } catch (_error) {
                cleanupAttempts++;
                return cleanupAttempts < 20 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
            }
        };
        if (cleanup() === GLib.SOURCE_CONTINUE)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, cleanup);
        this._runtimeDirectory = null;
        if (wasRunning)
            this._onStopped();
        return wasRunning;
    }
}
