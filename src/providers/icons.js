import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    customProviderIconSpec,
    drawCustomProviderIcon,
} from './providerIconAvatar.js';

const PROVIDER_ICON_FILES = {
    openai: 'provider-openai.svg',
    anthropic: 'provider-anthropic.svg',
    gemini: 'provider-gemini.svg',
    kimi: 'provider-kimi.svg',
    deepseek: 'provider-deepseek.svg',
    grok: 'provider-grok.svg',
    zai: 'provider-zai.svg',
    'openai-compatible': 'provider-custom.svg',
};
const providerIconUpdaters = new WeakMap();

function getProviderId(providerOrId) {
    const providerId = typeof providerOrId === 'string'
        ? providerOrId
        : providerOrId?.id;

    if (providerOrId?.customizable
        || providerId === 'openai-compatible'
        || providerId?.startsWith('openai-compatible-')) {
        return 'openai-compatible';
    }

    return providerId;
}

export function getProviderIconPath(providerOrId) {
    const iconFile = PROVIDER_ICON_FILES[getProviderId(providerOrId)];

    if (!iconFile)
        return null;

    const modulePath = Gio.File.new_for_uri(import.meta.url).get_path();

    if (!modulePath)
        return null;

    const moduleDir = GLib.path_get_dirname(modulePath);
    const candidates = [
        GLib.build_filenamev([moduleDir, '..', 'resources', 'providers', iconFile]),
        GLib.build_filenamev([moduleDir, '..', '..', 'data', 'resources', 'providers', iconFile]),
    ];

    return candidates.find((path) => GLib.file_test(path, GLib.FileTest.EXISTS)) ?? null;
}

export function getProviderGIcon(providerOrId, fallbackIconName = 'network-server-symbolic') {
    const iconPath = getProviderIconPath(providerOrId);

    return iconPath
        ? new Gio.FileIcon({ file: Gio.File.new_for_path(iconPath) })
        : new Gio.ThemedIcon({ name: fallbackIconName });
}

export function createProviderIcon(provider, {
    pixelSize = 16,
    fallbackIconName = 'network-server-symbolic',
} = {}) {
    const customIcon = customProviderIconSpec(provider);

    if (customIcon) {
        const iconSize = Math.max(1, Math.round(Number(pixelSize) || 16));
        let icon = customIcon;
        const drawing = new Gtk.DrawingArea({
            width_request: iconSize,
            height_request: iconSize,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            can_target: false,
        });
        drawing.add_css_class('provider-initial-icon');
        drawing.set_draw_func((_widget, cr, width, height) => {
            const size = Math.min(width, height);

            cr.save();
            cr.translate((width - size) / 2, (height - size) / 2);
            drawCustomProviderIcon(cr, icon, size);
            cr.restore();
        });
        providerIconUpdaters.set(drawing, (currentProvider) => {
            const nextIcon = customProviderIconSpec(currentProvider);

            if (!nextIcon)
                return;

            icon = nextIcon;
            drawing.set_tooltip_text(currentProvider.name);
            drawing.queue_draw();
        });
        drawing.set_tooltip_text(provider.name);
        return drawing;
    }

    const image = new Gtk.Image({
        gicon: getProviderGIcon(provider, fallbackIconName),
    });

    image.set_pixel_size(pixelSize);

    if (provider?.name)
        image.set_tooltip_text(provider.name);

    return image;
}

export function updateProviderIcon(icon, provider) {
    providerIconUpdaters.get(icon)?.(provider);

    if (!providerIconUpdaters.has(icon) && provider?.name)
        icon.set_tooltip_text(provider.name);
}
