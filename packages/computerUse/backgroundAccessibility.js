import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

export const BACKGROUND_ACCESSIBILITY_BUS_NAME = 'io.github.stonega.Cusco.BackgroundAccessibility';
export const BACKGROUND_ACCESSIBILITY_OBJECT_PATH = '/io/github/stonega/Cusco/BackgroundAccessibility';
export const BACKGROUND_ACCESSIBILITY_INTERFACE = BACKGROUND_ACCESSIBILITY_BUS_NAME;

export class BackgroundAccessibilityProxy {
    constructor(proxy) {
        this._proxy = proxy;
    }

    _call(method, signature, values) {
        const response = this._proxy.call_sync(
            method,
            new GLib.Variant(signature, values),
            Gio.DBusCallFlags.NONE,
            5_000,
            null,
        ).deepUnpack()[0];
        return JSON.parse(response);
    }

    observe(window, observationId) {
        return this._call('Observe', '(ss)', [JSON.stringify(window), String(observationId)]);
    }

    activate(ref) {
        return this._call('Activate', '(s)', [String(ref)]);
    }

    setText(ref, value) {
        return this._call('SetText', '(ss)', [String(ref), String(value ?? '')]);
    }

    shutdown() {
        this._proxy = null;
    }
}
