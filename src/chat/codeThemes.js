import GtkSource from 'gi://GtkSource?version=5';

export const DEFAULT_CODE_THEME_ID = 'Adwaita';

const PREFERRED_CODE_THEME_IDS = [
    'Adwaita',
    'Adwaita-dark',
    'solarized-light',
    'solarized-dark',
    'cobalt',
    'cobalt-light',
    'classic',
    'classic-dark',
    'kate',
    'kate-dark',
    'oblivion',
    'tango',
];

function getStyleSchemeManager() {
    return GtkSource.StyleSchemeManager.get_default();
}

function getStyleSchemeName(manager, id) {
    return manager.get_scheme(id)?.get_name?.() ?? id;
}

function compareStyleSchemeNames(manager, left, right) {
    return getStyleSchemeName(manager, left).localeCompare(getStyleSchemeName(manager, right));
}

export function getCodeThemeOptions() {
    const manager = getStyleSchemeManager();
    const installedIds = manager.get_scheme_ids();
    const installed = new Set(installedIds);
    const preferredIds = PREFERRED_CODE_THEME_IDS.filter((id) => installed.has(id));
    const remainingIds = installedIds
        .filter((id) => !PREFERRED_CODE_THEME_IDS.includes(id))
        .sort((left, right) => compareStyleSchemeNames(manager, left, right));
    const ids = [...preferredIds, ...remainingIds];

    if (ids.length === 0)
        ids.push(DEFAULT_CODE_THEME_ID);

    return ids.map((id) => ({
        id,
        label: getStyleSchemeName(manager, id),
    }));
}

export function normalizeCodeTheme(themeId) {
    const manager = getStyleSchemeManager();
    const id = String(themeId ?? '').trim();

    if (id && manager.get_scheme(id))
        return id;

    if (manager.get_scheme(DEFAULT_CODE_THEME_ID))
        return DEFAULT_CODE_THEME_ID;

    return manager.get_scheme_ids()[0] ?? DEFAULT_CODE_THEME_ID;
}

export function getCodeThemeStyleScheme(themeId) {
    return getStyleSchemeManager().get_scheme(normalizeCodeTheme(themeId));
}

function parseHexColor(value) {
    const match = String(value ?? '').trim().match(/^#([0-9a-f]{6})$/i);

    if (!match)
        return null;

    const hex = match[1];
    return {
        red: parseInt(hex.slice(0, 2), 16) / 255,
        green: parseInt(hex.slice(2, 4), 16) / 255,
        blue: parseInt(hex.slice(4, 6), 16) / 255,
    };
}

function relativeLuminance({ red, green, blue }) {
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function getCodeThemeVariant(themeId) {
    const normalizedId = normalizeCodeTheme(themeId);
    const background = getCodeThemeStyleScheme(normalizedId)?.get_style('text')?.background;
    const color = parseHexColor(background);

    if (color)
        return relativeLuminance(color) < 0.45 ? 'dark' : 'light';

    return normalizedId.toLowerCase().includes('dark') || normalizedId === 'oblivion'
        ? 'dark'
        : 'light';
}
