import Gio from 'gi://Gio?version=2.0';

import { getBundledIconForeground } from '../src/bundledIcons.js';

if (getBundledIconForeground() !== '#2e3436'
    || getBundledIconForeground({ dark: true }) !== '#deddda'
    || getBundledIconForeground({ highContrast: true }) !== '#000000'
    || getBundledIconForeground({ dark: true, highContrast: true }) !== '#ffffff') {
    throw new Error('Bundled icon theme foreground colors are invalid');
}

const resourceDirectory = Gio.File.new_for_path('data/resources');
const multicolorIconPalettes = new Map([
    ['usage-symbolic.svg', ['#3584e4', '#ff7800', '#9141ac']],
]);
const files = resourceDirectory.enumerate_children(
    'standard::name,standard::type',
    Gio.FileQueryInfoFlags.NONE,
    null
);
let symbolicIconCount = 0;

for (let info = files.next_file(null); info; info = files.next_file(null)) {
    const filename = info.get_name();

    if (info.get_file_type() !== Gio.FileType.REGULAR || !filename.endsWith('-symbolic.svg'))
        continue;

    const icon = resourceDirectory.get_child(filename);
    const [, contents] = icon.load_contents(null);
    const svg = new TextDecoder().decode(contents);

    if (svg.includes('currentColor')) {
        throw new Error(
            `${filename} uses currentColor, which is not reliably resolved before `
            + 'GTK symbolic recoloring on Ubuntu'
        );
    }

    const multicolorPalette = multicolorIconPalettes.get(filename);
    if (multicolorPalette) {
        for (const color of multicolorPalette) {
            if (!svg.includes(color))
                throw new Error(`${filename} is missing its expected ${color} color`);
        }
        multicolorIconPalettes.delete(filename);
    } else if (!svg.includes('#2e3436')) {
        throw new Error(`${filename} does not use GTK's symbolic foreground base color`);
    }

    symbolicIconCount++;
}

if (symbolicIconCount === 0)
    throw new Error('No bundled symbolic SVG icons were checked');
if (multicolorIconPalettes.size > 0)
    throw new Error(`Missing bundled multicolor icons: ${[...multicolorIconPalettes.keys()].join(', ')}`);

files.close(null);
print(`bundled icon smoke checks passed (${symbolicIconCount} icons)`);
