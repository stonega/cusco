import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

let bundledIconThemePathsInstalled = false;

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

function bundledIconName(filename) {
    return String(filename ?? '').replace(/\.svg$/i, '');
}

function installBundledIconThemePaths() {
    const display = Gdk.Display.get_default();

    if (!display)
        return null;

    const iconTheme = Gtk.IconTheme.get_for_display(display);

    if (bundledIconThemePathsInstalled)
        return iconTheme;

    for (const directory of getBundledResourceDirs()) {
        if (GLib.file_test(directory, GLib.FileTest.IS_DIR))
            iconTheme.add_search_path(directory);
    }

    bundledIconThemePathsInstalled = true;
    return iconTheme;
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
    const iconTheme = installBundledIconThemePaths();
    const iconName = bundledIconName(filename);
    const image = iconTheme?.has_icon(iconName)
        ? new Gtk.Image({ icon_name: iconName })
        : new Gtk.Image({ icon_name: fallbackIconName });

    image.set_pixel_size(pixelSize);
    return image;
}
