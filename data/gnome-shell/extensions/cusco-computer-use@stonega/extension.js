import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {clutterKeySuffix} from './keyNames.js';
import {describeComputerUseOperation, ellipsizeIndicatorStatus} from './indicatorStatus.js';

const OBJECT_PATH = '/io/github/stonega/Cusco/ComputerUse';
const PROTOCOL_VERSION = 3;
const MAX_TYPE_CHARACTERS = 10_000;

const INTERFACE_XML = `
<node>
  <interface name="io.github.stonega.Cusco.ComputerUse">
    <method name="Register">
      <arg type="u" name="pid" direction="in"/>
      <arg type="s" name="result" direction="out"/>
    </method>
    <method name="Unregister"/>
    <method name="GetStatus">
      <arg type="s" name="result" direction="out"/>
    </method>
    <method name="SetActive">
      <arg type="b" name="active" direction="in"/>
    </method>
    <method name="ListDesktop">
      <arg type="s" name="result" direction="out"/>
    </method>
    <method name="CaptureWindow">
      <arg type="s" name="window_id" direction="in"/>
      <arg type="s" name="result" direction="out"/>
    </method>
    <method name="PerformAction">
      <arg type="s" name="request" direction="in"/>
      <arg type="s" name="result" direction="out"/>
    </method>
    <signal name="StopRequested"/>
  </interface>
</node>`;

function nowMicros() {
    return GLib.get_monotonic_time();
}

function eventTime() {
    return global.get_current_time();
}

function delay(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, milliseconds), () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function responseVariant(value) {
    return new GLib.Variant('(s)', [JSON.stringify(value)]);
}

function returnError(invocation, error) {
    invocation.return_dbus_error(
        'io.github.stonega.Cusco.ComputerUse.Error',
        String(error?.message ?? error),
    );
}

function windowId(window) {
    return String(window.get_id());
}

function shellMajorVersion() {
    return Number.parseInt(String(Config.PACKAGE_VERSION ?? '').split('.')[0], 10) || 0;
}

function windowIsMaximized(window) {
    try {
        if (typeof window.is_maximized === 'function')
            return Boolean(window.is_maximized());

        if (typeof window.get_maximized === 'function') {
            const flags = window.get_maximized();
            const both = Meta.MaximizeFlags?.BOTH;
            return both === undefined ? Boolean(flags) : (flags & both) === both;
        }
    } catch (_error) {
        // Fall through to properties shared by older Mutter releases.
    }

    return Boolean(window.maximized_horizontally && window.maximized_vertically);
}

function windowCanMaximize(window) {
    if (windowIsMaximized(window))
        return true;

    try {
        return typeof window.can_maximize === 'function'
            ? Boolean(window.can_maximize())
            : true;
    } catch (_error) {
        return false;
    }
}

function maximizeWindow(window) {
    if (windowIsMaximized(window))
        return true;
    if (!windowCanMaximize(window))
        return false;

    if (shellMajorVersion() >= 49)
        window.maximize();
    else
        window.maximize(Meta.MaximizeFlags.BOTH);
    return true;
}

function windowRecord(window, tracker) {
    const rect = window.get_frame_rect();
    const app = tracker.get_window_app(window);
    const workspace = window.get_workspace();

    return {
        id: windowId(window),
        pid: window.get_pid(),
        title: window.get_title() ?? '',
        appId: app?.get_id() ?? '',
        appName: app?.get_name() ?? window.get_wm_class() ?? 'Unknown',
        wmClass: window.get_wm_class() ?? '',
        workspaceIndex: workspace?.index() ?? -1,
        monitorIndex: window.get_monitor(),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        focused: global.display.focus_window === window,
        minimized: window.minimized,
        maximized: windowIsMaximized(window),
        canMaximize: windowCanMaximize(window),
        onAllWorkspaces: window.is_on_all_workspaces(),
    };
}

function unicodeKeysym(character) {
    if (character === '\n')
        return Clutter.KEY_Return;
    if (character === '\t')
        return Clutter.KEY_Tab;

    const codepoint = character.codePointAt(0);
    return codepoint <= 0xff ? codepoint : (0x01000000 | codepoint);
}

function namedKeysym(name) {
    const suffix = clutterKeySuffix(name);
    const value = Clutter[`KEY_${suffix}`];

    if (Number.isFinite(value))
        return value;
    if ([...name].length === 1)
        return unicodeKeysym(name);
    throw new Error(`Unsupported key: ${name}`);
}

class ComputerUseBridge {
    constructor(indicator, statusLabel) {
        this._indicator = indicator;
        this._statusLabel = statusLabel;
        this._tracker = Shell.WindowTracker.get_default();
        this._clientSender = '';
        this._clientPid = 0;
        this._generation = 0;
        const seat = Clutter.get_default_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }

    _setStatus(description) {
        const status = ellipsizeIndicatorStatus(description);

        this._statusLabel.text = status;
        this._indicator.accessible_name = `${status}. Click to stop computer use and return to Cusco.`;
    }

    _senderPid(sender) {
        const result = Gio.DBus.session.call_sync(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'GetConnectionUnixProcessID',
            new GLib.Variant('(s)', [sender]),
            new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE,
            1_000,
            null,
        );
        return result.deepUnpack()[0];
    }

    _isCuscoProcess(pid) {
        try {
            const [ok, contents] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
            const commandLine = ok ? new TextDecoder().decode(contents).replaceAll('\0', ' ') : '';
            return commandLine.includes('io.github.stonega.Cusco')
                || commandLine.includes('/cusco/')
                || commandLine.includes('src/main.js');
        } catch (_error) {
            return false;
        }
    }

    _requireClient(invocation) {
        if (!this._clientSender || invocation.get_sender() !== this._clientSender)
            throw new Error('Caller is not the registered Cusco process.');
    }

    _windows() {
        return global.display
            .get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .filter(window => !window.is_skip_taskbar());
    }

    _window(id) {
        const found = this._windows().find(window => windowId(window) === String(id));
        if (!found)
            throw new Error(`Window ${id} was not found.`);
        return found;
    }

    _workspace(indexValue) {
        const index = Number(indexValue);
        if (!Number.isInteger(index) || index < 0)
            throw new Error('workspaceIndex must be a non-negative integer.');
        const workspace = global.workspace_manager.get_workspace_by_index(index);
        if (!workspace)
            throw new Error(`Workspace ${indexValue} was not found.`);
        return workspace;
    }

    _activate(window) {
        if (window.minimized)
            window.unminimize();
        window.activate(eventTime());
    }

    _cancel() {
        this._generation += 1;
        this._indicator.visible = false;
        this._setStatus(describeComputerUseOperation('idle'));
    }

    onClientVanished(sender) {
        if (sender !== this._clientSender)
            return;
        this._clientSender = '';
        this._clientPid = 0;
        this._cancel();
    }

    stopAndFocusCusco() {
        this._cancel();
        this._exported?.emit_signal('StopRequested', null);
        const target = this._windows().find(window => window.get_pid() === this._clientPid)
            ?? this._windows().find(window => this._tracker.get_window_app(window)?.get_id() === 'io.github.stonega.Cusco.desktop');
        if (target)
            this._activate(target);
    }

    RegisterAsync([pid], invocation) {
        try {
            const sender = invocation.get_sender();
            const senderPid = this._senderPid(sender);
            if (senderPid !== pid || !this._isCuscoProcess(pid))
                throw new Error('Only the running Cusco process may register computer use.');
            if (this._clientSender && this._clientSender !== sender)
                throw new Error('Another Cusco process already owns computer use.');
            this._clientSender = sender;
            this._clientPid = pid;
            invocation.return_value(responseVariant({protocolVersion: PROTOCOL_VERSION, registered: true}));
        } catch (error) {
            returnError(invocation, error);
        }
    }

    UnregisterAsync(_parameters, invocation) {
        try {
            this._requireClient(invocation);
            this._clientSender = '';
            this._clientPid = 0;
            this._cancel();
            invocation.return_value(null);
        } catch (error) {
            returnError(invocation, error);
        }
    }

    GetStatusAsync(_parameters, invocation) {
        try {
            this._requireClient(invocation);
            invocation.return_value(responseVariant({
                protocolVersion: PROTOCOL_VERSION,
                shellVersion: String(Config.PACKAGE_VERSION ?? ''),
                sessionType: 'wayland',
                windowCapture: true,
                virtualInput: true,
                workspaceSwitching: true,
                workspaceCreation: true,
                windowWorkspaceMovement: true,
                windowMaximizing: true,
            }));
        } catch (error) {
            returnError(invocation, error);
        }
    }

    SetActiveAsync([active], invocation) {
        try {
            this._requireClient(invocation);
            if (active && !this._indicator.visible)
                this._setStatus(describeComputerUseOperation('active'));
            this._indicator.visible = Boolean(active);
            if (!active)
                this._generation += 1;
            invocation.return_value(null);
        } catch (error) {
            returnError(invocation, error);
        }
    }

    ListDesktopAsync(_parameters, invocation) {
        try {
            this._requireClient(invocation);
            this._setStatus(describeComputerUseOperation('list_desktop'));
            const manager = global.workspace_manager;
            const activeIndex = manager.get_active_workspace_index();
            const workspaces = [];
            for (let index = 0; index < manager.get_n_workspaces(); index++) {
                workspaces.push({
                    index,
                    active: index === activeIndex,
                    windowCount: this._windows().filter(window => window.get_workspace()?.index() === index).length,
                });
            }
            invocation.return_value(responseVariant({
                workspaces,
                windows: this._windows().map(window => windowRecord(window, this._tracker)),
                screen: {width: global.stage.width, height: global.stage.height},
            }));
        } catch (error) {
            returnError(invocation, error);
        }
    }

    async CaptureWindowAsync([id], invocation) {
        try {
            this._requireClient(invocation);
            const generation = this._generation;
            const window = this._window(id);
            this._setStatus(describeComputerUseOperation('capture', {
                windowTitle: window.get_title(),
            }));
            this._activate(window);
            await delay(180);
            if (generation !== this._generation)
                throw new Error('Computer use was stopped.');
            const rect = window.get_frame_rect();
            const stream = Gio.MemoryOutputStream.new_resizable();
            const screenshot = new Shell.Screenshot();
            await screenshot.screenshot_area(rect.x, rect.y, rect.width, rect.height, stream);
            stream.close(null);
            const bytes = stream.steal_as_bytes().get_data();
            invocation.return_value(responseVariant({
                window: windowRecord(window, this._tracker),
                width: rect.width,
                height: rect.height,
                mimeType: 'image/png',
                imageBase64: GLib.base64_encode(bytes),
            }));
        } catch (error) {
            returnError(invocation, error);
        }
    }

    _point(window, request, xName = 'x', yName = 'y') {
        const rect = window.get_frame_rect();
        if (!Number.isFinite(request[xName]) || !Number.isFinite(request[yName]))
            throw new Error(`${xName} and ${yName} must be finite window-relative coordinates.`);
        const windowPoint = {
            x: clamp(request[xName], 0, Math.max(0, rect.width - 1)),
            y: clamp(request[yName], 0, Math.max(0, rect.height - 1)),
        };
        return {
            window: windowPoint,
            desktop: {
                x: rect.x + windowPoint.x,
                y: rect.y + windowPoint.y,
            },
        };
    }

    _move(point) {
        const desktop = point.desktop ?? point;
        this._pointer.notify_absolute_motion(nowMicros(), desktop.x, desktop.y);
    }

    async _click(point, buttonName = 'left', count = 1) {
        const buttons = {
            left: Clutter.BUTTON_PRIMARY,
            middle: Clutter.BUTTON_MIDDLE,
            right: Clutter.BUTTON_SECONDARY,
        };
        const button = buttons[buttonName] ?? Clutter.BUTTON_PRIMARY;
        this._move(point);
        for (let index = 0; index < count; index++) {
            this._pointer.notify_button(nowMicros(), button, Clutter.ButtonState.PRESSED);
            this._pointer.notify_button(nowMicros(), button, Clutter.ButtonState.RELEASED);
            if (index + 1 < count)
                await delay(70);
        }
    }

    async _type(text, generation) {
        const characters = [...String(text ?? '')];
        if (characters.length > MAX_TYPE_CHARACTERS)
            throw new Error(`Typing is limited to ${MAX_TYPE_CHARACTERS} characters per action.`);
        for (const character of characters) {
            if (generation !== this._generation)
                throw new Error('Computer use was stopped.');
            const keyval = unicodeKeysym(character);
            this._keyboard.notify_keyval(nowMicros(), keyval, Clutter.KeyState.PRESSED);
            this._keyboard.notify_keyval(nowMicros(), keyval, Clutter.KeyState.RELEASED);
            await delay(4);
        }
    }

    async _keypress(keys) {
        const keyvals = (keys ?? []).map(namedKeysym);
        if (keyvals.length === 0)
            throw new Error('keypress requires at least one key.');
        for (const keyval of keyvals)
            this._keyboard.notify_keyval(nowMicros(), keyval, Clutter.KeyState.PRESSED);
        for (const keyval of [...keyvals].reverse())
            this._keyboard.notify_keyval(nowMicros(), keyval, Clutter.KeyState.RELEASED);
        await delay(20);
    }

    async _scroll(point, request) {
        this._move(point);
        const axes = [
            [Number(request.deltaY ?? 0), Clutter.ScrollDirection.DOWN, Clutter.ScrollDirection.UP],
            [Number(request.deltaX ?? 0), Clutter.ScrollDirection.RIGHT, Clutter.ScrollDirection.LEFT],
        ];
        for (const [amount, positive, negative] of axes) {
            const steps = Math.min(50, Math.max(0, Math.ceil(Math.abs(amount) / 100)));
            const direction = amount >= 0 ? positive : negative;
            for (let index = 0; index < steps; index++) {
                this._pointer.notify_discrete_scroll(nowMicros(), direction, Clutter.ScrollSource.WHEEL);
                await delay(12);
            }
        }
    }

    async _drag(start, end, generation) {
        this._move(start);
        this._pointer.notify_button(nowMicros(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        try {
            for (let index = 1; index <= 12; index++) {
                if (generation !== this._generation)
                    throw new Error('Computer use was stopped.');
                const fraction = index / 12;
                this._move({
                    x: start.desktop.x + ((end.desktop.x - start.desktop.x) * fraction),
                    y: start.desktop.y + ((end.desktop.y - start.desktop.y) * fraction),
                });
                await delay(12);
            }
        } finally {
            this._pointer.notify_button(nowMicros(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        }
    }

    async PerformActionAsync([payload], invocation) {
        try {
            this._requireClient(invocation);
            const request = JSON.parse(payload);
            const action = String(request.action ?? '');
            const generation = this._generation;
            let coordinates = null;

            if (action === 'create_workspace') {
                this._setStatus(describeComputerUseOperation(action));
                const manager = global.workspace_manager;
                const workspace = manager.append_new_workspace(true, eventTime())
                    ?? manager.get_active_workspace();
                invocation.return_value(responseVariant({
                    performed: action,
                    created: true,
                    workspaceIndex: workspace.index(),
                }));
                return;
            }

            if (action === 'switch_workspace') {
                this._setStatus(describeComputerUseOperation(action, request));
                const workspace = this._workspace(request.workspaceIndex);
                const index = workspace.index();
                workspace.activate(eventTime());
                invocation.return_value(responseVariant({performed: action, workspaceIndex: index}));
                return;
            }

            const hasWindowId = String(request.windowId ?? '').trim().length > 0;
            const isGlobalKeyboardAction = !hasWindowId
                && (action === 'keypress' || action === 'type');
            const window = isGlobalKeyboardAction ? null : this._window(request.windowId);
            const targetWorkspace = action === 'move_to_workspace'
                ? this._workspace(request.workspaceIndex)
                : null;

            this._setStatus(describeComputerUseOperation(action, {
                ...request,
                windowTitle: window?.get_title(),
            }));

            if (window && action !== 'move_to_workspace') {
                this._activate(window);
                await delay(80);
            }
            if (generation !== this._generation)
                throw new Error('Computer use was stopped.');

            switch (action) {
            case 'focus':
                break;
            case 'maximize':
                maximizeWindow(window);
                break;
            case 'move_to_workspace':
                window.change_workspace(targetWorkspace);
                targetWorkspace.activate(eventTime());
                this._activate(window);
                break;
            case 'move':
                coordinates = this._point(window, request);
                this._move(coordinates);
                break;
            case 'click': {
                coordinates = this._point(window, request);
                await this._click(coordinates, request.button, 1);
                break;
            }
            case 'double_click': {
                coordinates = this._point(window, request);
                await this._click(coordinates, request.button, 2);
                break;
            }
            case 'type':
                if ((Number.isFinite(request.x) || Number.isFinite(request.y)) && !window)
                    throw new Error('Global type cannot use window-relative coordinates.');
                if (window && Number.isFinite(request.x) && Number.isFinite(request.y)) {
                    coordinates = this._point(window, request);
                    await this._click(coordinates, 'left', 1);
                }
                await this._type(request.text, generation);
                break;
            case 'keypress':
                await this._keypress(request.keys);
                break;
            case 'scroll':
                coordinates = this._point(window, request);
                await this._scroll(coordinates, request);
                break;
            case 'drag': {
                const start = this._point(window, request);
                const end = this._point(window, request, 'endX', 'endY');
                coordinates = {
                    window: start.window,
                    desktop: start.desktop,
                    endWindow: end.window,
                    endDesktop: end.desktop,
                };
                await this._drag(start, end, generation);
                break;
            }
            default:
                throw new Error(`Unsupported action: ${action}`);
            }

            if (action === 'maximize' || action === 'move_to_workspace')
                await delay(120);
            if (generation !== this._generation)
                throw new Error('Computer use was stopped.');

            const record = window ? windowRecord(window, this._tracker) : null;
            let verified = false;
            let verificationReason = 'The input event was dispatched; application-level effects require a post-action observation.';

            if (action === 'focus') {
                verified = record.focused;
                verificationReason = verified
                    ? 'Window focus was verified.'
                    : 'The focus request was dispatched but the window is not focused.';
            } else if (action === 'maximize') {
                verified = record.maximized;
                verificationReason = verified
                    ? 'The window is maximized.'
                    : (record.canMaximize
                        ? 'The maximize request was dispatched but the window is not maximized.'
                        : 'This window does not support maximizing.');
            } else if (action === 'move_to_workspace') {
                verified = record.workspaceIndex === targetWorkspace.index();
                verificationReason = verified
                    ? `The window is on workspace ${targetWorkspace.index()}.`
                    : 'The workspace move was dispatched but could not be verified.';
            }

            invocation.return_value(responseVariant({
                performed: action,
                dispatchStatus: 'dispatched',
                verified,
                verificationReason,
                window: record,
                coordinates,
            }));
        } catch (error) {
            returnError(invocation, error);
        }
    }
}

export default class CuscoComputerUseExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0, 'Cusco computer use', false);
        this._indicator.add_style_class_name('cusco-computer-use-button');
        const content = new St.BoxLayout({
            style_class: 'cusco-computer-use-content',
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(new St.Icon({
            style_class: 'cusco-computer-use-icon',
            gicon: new Gio.FileIcon({
                file: Gio.File.new_for_path(`${this.path}/computer-use-active-symbolic.svg`),
            }),
            icon_size: 18,
        }));
        this._statusLabel = new St.Label({
            style_class: 'cusco-computer-use-label',
            text: describeComputerUseOperation('idle'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(this._statusLabel);
        this._indicator.add_child(content);
        this._indicator.visible = false;
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._bridge = new ComputerUseBridge(this._indicator, this._statusLabel);
        this._bridge._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this._bridge);
        this._bridge._exported.export(Gio.DBus.session, OBJECT_PATH);
        this._indicator.connect('button-press-event', () => {
            this._bridge.stopAndFocusCusco();
            return Clutter.EVENT_STOP;
        });
        this._nameOwnerSignal = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, parameters) => {
                const [name, _oldOwner, newOwner] = parameters.deepUnpack();
                if (!newOwner)
                    this._bridge?.onClientVanished(name);
            },
        );
    }

    disable() {
        if (this._nameOwnerSignal)
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerSignal);
        this._nameOwnerSignal = 0;
        this._bridge?._exported?.unexport();
        this._indicator?.destroy();
        this._bridge = null;
        this._indicator = null;
        this._statusLabel = null;
    }
}
