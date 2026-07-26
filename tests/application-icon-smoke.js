import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const APP_ID = 'io.github.stonega.Cusco';
const desktopPath = `data/${APP_ID}.desktop.in`;
const [, desktopBytes] = GLib.file_get_contents(desktopPath);
const desktopEntry = new TextDecoder().decode(desktopBytes);

if (!desktopEntry.includes('Icon=@APP_ID@'))
    throw new Error('Desktop entry does not resolve its icon from the application ID');

for (const size of [64, 128, 256, 512]) {
    const iconPath = `data/icons/hicolor/${size}x${size}/apps/${APP_ID}.png`;

    if (!GLib.file_test(iconPath, GLib.FileTest.IS_REGULAR))
        throw new Error(`Missing ${size}×${size} application icon`);

    const [, png] = GLib.file_get_contents(iconPath);
    const width = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
    const height = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];

    if (width !== size || height !== size)
        throw new Error(`${iconPath} has unexpected dimensions ${width}×${height}`);
}

const obsoleteScalableIcon = Gio.File.new_for_path(
    `data/icons/hicolor/scalable/apps/${APP_ID}.svg`
);

if (obsoleteScalableIcon.query_exists(null)) {
    throw new Error(
        'Obsolete scalable artwork would override the intended application icon on Ubuntu'
    );
}

print('application icon smoke checks passed');
