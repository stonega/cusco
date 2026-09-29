import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { AccessibilitySnapshotService } from './accessibility.js';
import {
    BACKGROUND_ACCESSIBILITY_BUS_NAME,
    BACKGROUND_ACCESSIBILITY_INTERFACE,
    BACKGROUND_ACCESSIBILITY_OBJECT_PATH,
} from './backgroundAccessibility.js';

const INTERFACE_XML = `<node>
  <interface name="${BACKGROUND_ACCESSIBILITY_INTERFACE}">
    <method name="Observe">
      <arg type="s" direction="in" name="window_json"/>
      <arg type="s" direction="in" name="observation_id"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="Activate">
      <arg type="s" direction="in" name="ref"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="SetText">
      <arg type="s" direction="in" name="ref"/>
      <arg type="s" direction="in" name="value"/>
      <arg type="s" direction="out" name="result"/>
    </method>
  </interface>
</node>`;

const accessibility = new AccessibilitySnapshotService();
const bridge = {
    ObserveAsync([windowJson, observationId], invocation) {
        try {
            const result = accessibility.observe(JSON.parse(windowJson), observationId);
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)]));
        } catch (error) {
            invocation.return_dbus_error(BACKGROUND_ACCESSIBILITY_BUS_NAME + '.Error', String(error.message ?? error));
        }
    },

    ActivateAsync([ref], invocation) {
        try {
            const result = accessibility.activate(ref);
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)]));
        } catch (error) {
            invocation.return_dbus_error(BACKGROUND_ACCESSIBILITY_BUS_NAME + '.Error', String(error.message ?? error));
        }
    },

    SetTextAsync([ref, value], invocation) {
        try {
            const result = accessibility.setText(ref, value);
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)]));
        } catch (error) {
            invocation.return_dbus_error(BACKGROUND_ACCESSIBILITY_BUS_NAME + '.Error', String(error.message ?? error));
        }
    },
};

const connection = Gio.DBus.session;
const requested = connection.call_sync(
    'org.freedesktop.DBus',
    '/org/freedesktop/DBus',
    'org.freedesktop.DBus',
    'RequestName',
    new GLib.Variant('(su)', [BACKGROUND_ACCESSIBILITY_BUS_NAME, 0]),
    new GLib.VariantType('(u)'),
    Gio.DBusCallFlags.NONE,
    2_000,
    null,
).deepUnpack()[0];

if (requested !== 1)
    throw new Error('Another background accessibility bridge is already running.');

const exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, bridge);
exported.export(connection, BACKGROUND_ACCESSIBILITY_OBJECT_PATH);

const loop = GLib.MainLoop.new(null, false);
loop.run();

exported.unexport();
accessibility.shutdown();
