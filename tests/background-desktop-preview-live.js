import Cairo from 'cairo';
import GLib from 'gi://GLib?version=2.0';
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
    },
    canPreview: () => running,
});

try {
    preview.openWindow();
    await delay(300);
    if (!preview._window || !preview._windowPicture.get_paintable() || captures === 0)
        throw new Error('The preview window did not display the background frame.');

    running = false;
    preview.sync();
    if (preview._window || preview._refreshSourceId)
        throw new Error('Stopping the desktop did not close the preview and its refresh loop.');
    print('Background desktop preview window and cleanup passed.');
} finally {
    preview.dispose();
    parent.close();
}
