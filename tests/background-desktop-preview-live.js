import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Graphene from 'gi://Graphene?version=1.0';
import Gtk from 'gi://Gtk?version=4.0';

import { BackgroundDesktopPreview } from '../src/computerUse/desktopPreview.js';

function delay(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

Gtk.init();
const path = GLib.build_filenamev([GLib.get_tmp_dir(), `cusco-preview-${GLib.uuid_string_random()}.png`]);
const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 32, 20);
const context = new Cairo.Context(surface);
context.setSourceRGB(0.1, 0.2, 0.3);
context.paint();
surface.writeToPNG(path);
context.$dispose();
surface.finish();
const [, bytes] = GLib.file_get_contents(path);
GLib.unlink(path);

let captures = 0;
let running = true;
let takenOver = 0;
let released = 0;
const inputs = [];
const parent = new Gtk.Window({ title: 'Preview test' });
const anchor = new Gtk.Box();
anchor.append(new Gtk.Button({ label: 'Stop agent desktop' }));
parent.set_child(anchor);
parent.present();
const preview = new BackgroundDesktopPreview({
    anchor,
    parentWindow: parent,
    manager: {
        async captureBackgroundDesktopPreview() {
            captures++;
            return { bytes, width: 32, height: 20 };
        },
        async takeOverBackgroundDesktop() { takenOver++; },
        async sendBackgroundDesktopInput(event) { inputs.push(event); },
        async releaseBackgroundDesktopControl() { released++; },
    },
    canPreview: () => running,
});

try {
    preview.openWindow();
    await delay(300);
    if (!preview._window || !preview._windowPicture.get_paintable() || captures === 0)
        throw new Error('The preview window did not display the background frame.');

    const footer = preview._popover.get_child().get_last_child();
    if (footer.get_first_child().get_next_sibling() !== preview._takeOverButton
        || preview._takeOverButton.get_next_sibling().get_tooltip_text() !== 'Open in window')
        throw new Error('Take over is not immediately before Open in window.');
    await preview.takeOver();
    if (takenOver !== 1 || !preview._controlling || preview._windowControlButton.get_label() !== 'Stop controlling')
        throw new Error('Take over did not enable desktop interaction.');

    const picture = preview._windowPicture;
    const [, origin] = picture.compute_point(picture.get_native(), new Graphene.Point());
    const pointerEvent = (type, x, y) => ({
        get_event_type: () => type,
        get_position: () => [true, origin.x + x, origin.y + y],
        get_button: () => 1,
        get_deltas: () => [0, 1],
        get_direction: () => Gdk.ScrollDirection.SMOOTH,
    });
    const centerX = picture.get_width() / 2;
    const centerY = picture.get_height() / 2;
    preview._handleDesktopEvent(picture, pointerEvent(Gdk.EventType.BUTTON_PRESS, centerX, centerY));
    preview._handleDesktopEvent(picture, pointerEvent(Gdk.EventType.MOTION_NOTIFY, centerX + 20, centerY));
    preview._handleDesktopEvent(picture, pointerEvent(Gdk.EventType.BUTTON_RELEASE, centerX + 20, centerY));
    preview._handleDesktopEvent(picture, pointerEvent(Gdk.EventType.SCROLL, centerX, centerY));
    const keyEvent = (type, keyval) => ({
        get_event_type: () => type,
        get_keycode: () => 38,
        get_keyval: () => keyval,
    });
    preview._handleDesktopEvent(picture, keyEvent(Gdk.EventType.KEY_PRESS, Gdk.KEY_A));
    preview._handleDesktopEvent(picture, keyEvent(Gdk.EventType.KEY_RELEASE, Gdk.KEY_a));
    await preview._inputQueue;
    if (inputs.length !== 6 || inputs[0].x !== 16 || inputs[0].y !== 10
        || inputs[1].type !== 'motion' || inputs[2].pressed !== false
        || inputs[3].type !== 'scroll' || inputs[3].deltaY !== 15
        || inputs[4].keyval !== Gdk.KEY_A || inputs[5].keyval !== Gdk.KEY_A)
        throw new Error(`Desktop input mapping failed: ${JSON.stringify(inputs)}`);
    const unpositionedScroll = pointerEvent(Gdk.EventType.SCROLL, 0, 0);
    unpositionedScroll.get_position = () => [false, null, null];
    preview._handleDesktopEvent(picture, unpositionedScroll);
    await preview._inputQueue;
    if (inputs.at(-1).type !== 'scroll' || inputs.at(-1).x !== 16 || inputs.at(-1).y !== 10)
        throw new Error('A scroll event without coordinates did not use the last pointer position.');
    const count = inputs.length;
    if (preview._handleDesktopEvent(picture, pointerEvent(Gdk.EventType.BUTTON_PRESS, 0, 0)))
        throw new Error('A click in the picture letterbox was sent to the desktop.');
    preview._releaseHeldInput();
    await preview._inputQueue;
    if (inputs.length !== count + 1 || inputs.at(-1).type !== 'release_all')
        throw new Error('Losing focus did not release desktop input.');

    running = false;
    preview.sync();
    await preview._releasePromise;
    if (preview._window || preview._refreshSourceId)
        throw new Error('Stopping the desktop did not close the preview and its refresh loop.');
    if (preview._controlling || released !== 1)
        throw new Error('Closing the preview did not release desktop control.');
    print('Background desktop preview, takeover input, and cleanup passed.');
} finally {
    preview.dispose();
    parent.close();
}
