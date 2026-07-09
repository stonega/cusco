import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

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

function getProviderId(providerOrId) {
    return typeof providerOrId === 'string'
        ? providerOrId
        : providerOrId?.id;
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
    const image = new Gtk.Image({
        gicon: getProviderGIcon(provider, fallbackIconName),
    });

    image.set_pixel_size(pixelSize);

    if (provider?.name)
        image.set_tooltip_text(provider.name);

    return image;
}
