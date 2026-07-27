import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

const SYMBOLIC_BASE_COLOR = '#2e3436';
const SYMBOLIC_DARK_FOREGROUND = '#deddda';
const SYMBOLIC_HIGH_CONTRAST_DARK_FOREGROUND = '#ffffff';
const SYMBOLIC_HIGH_CONTRAST_LIGHT_FOREGROUND = '#000000';

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

export function getBundledIconForeground({ dark = false, highContrast = false } = {}) {
    if (highContrast)
        return dark
            ? SYMBOLIC_HIGH_CONTRAST_DARK_FOREGROUND
            : SYMBOLIC_HIGH_CONTRAST_LIGHT_FOREGROUND;

    return dark ? SYMBOLIC_DARK_FOREGROUND : SYMBOLIC_BASE_COLOR;
}

function loadSymbolicPaintable(iconPath, foreground) {
    const [, contents] = GLib.file_get_contents(iconPath);
    const svg = new TextDecoder().decode(contents).replaceAll(SYMBOLIC_BASE_COLOR, foreground);
    const loader = GdkPixbuf.PixbufLoader.new_with_type('svg');

    loader.write(new TextEncoder().encode(svg));
    loader.close();

    const pixbuf = loader.get_pixbuf();
    return pixbuf ? Gdk.Texture.new_for_pixbuf(pixbuf) : null;
}

export function createBundledIcon(filename, fallbackIconName, { pixelSize = 16 } = {}) {
    const iconPath = getBundledImagePath(filename);
    const image = new Gtk.Image();

    if (iconPath) {
        const styleManager = Adw.StyleManager.get_default();
        let styleSignalId = 0;

        const updatePaintable = () => {
            try {
                const foreground = getBundledIconForeground({
                    dark: styleManager.get_dark(),
                    highContrast: styleManager.get_high_contrast(),
                });
                const paintable = loadSymbolicPaintable(iconPath, foreground);

                if (paintable)
                    image.set_from_paintable(paintable);
                else
                    image.set_from_icon_name(fallbackIconName);
            } catch (error) {
                logError(error, `Failed to load bundled icon ${filename}`);
                image.set_from_icon_name(fallbackIconName);
            }
        };

        image.connect('realize', () => {
            if (!styleSignalId)
                styleSignalId = styleManager.connect('notify', updatePaintable);
            updatePaintable();
        });
        image.connect('unrealize', () => {
            if (styleSignalId) {
                styleManager.disconnect(styleSignalId);
                styleSignalId = 0;
            }
        });
        updatePaintable();
    } else {
        image.set_from_icon_name(fallbackIconName);
    }

    image.set_pixel_size(pixelSize);
    return image;
}
