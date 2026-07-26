import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

function getModuleDir() {
    const modulePath = Gio.File.new_for_uri(import.meta.url).get_path();

    return modulePath ? GLib.path_get_dirname(modulePath) : null;
}

function getBundledResourceDirs() {
    const moduleDir = getModuleDir();

    if (!moduleDir)
        return [];

    return [
        GLib.build_filenamev([moduleDir, 'resources']),
        GLib.build_filenamev([moduleDir, '..', 'data', 'resources']),
    ];
}

export function getBundledImagePath(filename) {
    const moduleDir = getModuleDir();

    if (!moduleDir)
        return null;

    const candidates = [
        ...getBundledResourceDirs(),
        GLib.build_filenamev([moduleDir, '..', 'assets']),
    ].map((directory) => GLib.build_filenamev([directory, filename]));

    return candidates.find((path) => GLib.file_test(path, GLib.FileTest.EXISTS)) ?? null;
}

export function createBundledIcon(filename, fallbackIconName, { pixelSize = 16 } = {}) {
    const iconPath = getBundledImagePath(filename);
    const image = iconPath
        ? new Gtk.Image({
            gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(iconPath) }),
        })
        : new Gtk.Image({ icon_name: fallbackIconName });

    image.set_pixel_size(pixelSize);
    return image;
}
