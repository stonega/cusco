import GLib from 'gi://GLib?version=2.0';

import { AppSettingsStore } from '../src/settings/appSettings.js';
import {
    DEFAULT_CODE_THEME_ID,
    getCodeThemeOptions,
} from '../src/chat/codeThemes.js';

const availableCodeThemes = getCodeThemeOptions();
const initialCodeTheme = availableCodeThemes.find((option) => option.id !== DEFAULT_CODE_THEME_ID)?.id
    ?? DEFAULT_CODE_THEME_ID;
const nextCodeTheme = availableCodeThemes.find((option) => option.id !== initialCodeTheme)?.id
    ?? initialCodeTheme;

class MemorySettings {
    constructor({ booleans = {}, uints = {}, strings = {} } = {}) {
        this._booleans = { ...booleans };
        this._uints = { ...uints };
        this._strings = { ...strings };
    }

    get_boolean(key) {
        return this._booleans[key] ?? false;
    }

    set_boolean(key, value) {
        this._booleans[key] = Boolean(value);
        return true;
    }

    get_uint(key) {
        return this._uints[key] ?? 0;
    }

    set_uint(key, value) {
        this._uints[key] = value;
        return true;
    }

    get_string(key) {
        return this._strings[key] ?? '';
    }

    set_string(key, value) {
        this._strings[key] = String(value ?? '');
        return true;
    }
}

const settings = new MemorySettings({
    booleans: {
        'send-with-enter': false,
        'auto-mode-enabled': true,
        'provider-fallback-enabled': true,
        'high-contrast-enabled': true,
        'reduced-motion-enabled': false,
    },
    uints: {
        'response-timeout-seconds': 90,
        'max-output-tokens': 16384,
    },
    strings: {
        'thinking-level': 'high',
        'code-theme': initialCodeTheme,
    },
});
const appSettings = new AppSettingsStore({ settings });

if (appSettings.sendWithEnter !== false)
    throw new Error('Send-with-enter preference was not loaded');

if (appSettings.autoModeEnabled !== true)
    throw new Error('Auto Mode preference was not loaded');

if (appSettings.responseTimeoutSeconds !== 90)
    throw new Error(`Timeout preference was not loaded: ${appSettings.responseTimeoutSeconds}`);

if (appSettings.maxOutputTokens !== 16384)
    throw new Error(`Maximum output tokens preference was not loaded: ${appSettings.maxOutputTokens}`);

if (appSettings.providerFallbackEnabled !== true)
    throw new Error('Provider fallback preference was not loaded');

if (appSettings.thinkingLevel !== 'high')
    throw new Error(`Thinking level preference was not loaded: ${appSettings.thinkingLevel}`);

if (appSettings.codeTheme !== initialCodeTheme)
    throw new Error(`Code theme preference was not loaded: ${appSettings.codeTheme}`);

if (appSettings.highContrastEnabled !== true || appSettings.reducedMotionEnabled !== false)
    throw new Error('Accessibility preferences were not loaded');

appSettings.setSendWithEnter(true);
appSettings.setAutoModeEnabled(false);
appSettings.setResponseTimeoutSeconds(2);
appSettings.setMaxOutputTokens(999999);
appSettings.setProviderFallbackEnabled(false);
appSettings.setThinkingLevel('low');
appSettings.setCodeTheme(nextCodeTheme);
appSettings.setHighContrastEnabled(false);
appSettings.setReducedMotionEnabled(true);

if (settings.get_boolean('send-with-enter') !== true)
    throw new Error('Send-with-enter preference was not persisted');

if (settings.get_boolean('auto-mode-enabled') !== false)
    throw new Error('Auto Mode preference was not persisted');

if (settings.get_uint('response-timeout-seconds') !== 5)
    throw new Error(`Timeout preference was not clamped and persisted: ${settings.get_uint('response-timeout-seconds')}`);

if (settings.get_uint('max-output-tokens') !== 32768)
    throw new Error(`Maximum output tokens preference was not clamped and persisted: ${settings.get_uint('max-output-tokens')}`);

if (settings.get_boolean('provider-fallback-enabled') !== false)
    throw new Error('Provider fallback preference was not persisted');

if (settings.get_string('thinking-level') !== 'low')
    throw new Error('Thinking level preference was not persisted');

if (settings.get_string('code-theme') !== nextCodeTheme)
    throw new Error('Code theme preference was not persisted');

if (settings.get_boolean('high-contrast-enabled') !== false || settings.get_boolean('reduced-motion-enabled') !== true)
    throw new Error('Accessibility preferences were not persisted');

const partialSettings = new MemorySettings({
    uints: {
        'max-output-tokens': 12288,
    },
});
const partialAppSettings = new AppSettingsStore({
    settings: partialSettings,
    settingsKeys: ['max-output-tokens'],
});

if (partialAppSettings.maxOutputTokens !== 12288)
    throw new Error(`Maximum output tokens did not load with partial schema support: ${partialAppSettings.maxOutputTokens}`);

partialAppSettings.setMaxOutputTokens(24576);
partialAppSettings.setCodeTheme(nextCodeTheme);

if (partialSettings.get_uint('max-output-tokens') !== 24576)
    throw new Error('Maximum output tokens did not persist when unrelated schema keys were missing');

if (partialSettings.get_string('code-theme') !== '')
    throw new Error('Missing schema keys should not be written');

const fallbackSettingsPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-app-settings-${GLib.uuid_string_random()}.json`,
]);
const staleSchemaSettings = new MemorySettings({
    uints: {
        'max-output-tokens': 12288,
    },
});

try {
    const staleSchemaAppSettings = new AppSettingsStore({
        settings: staleSchemaSettings,
        settingsKeys: ['max-output-tokens'],
        settingsPath: fallbackSettingsPath,
    });

    staleSchemaAppSettings.setMaxOutputTokens(24576);
    staleSchemaAppSettings.setCodeTheme(nextCodeTheme);
    staleSchemaAppSettings.setHighContrastEnabled(true);

    const reloadedStaleSchemaAppSettings = new AppSettingsStore({
        settings: staleSchemaSettings,
        settingsKeys: ['max-output-tokens'],
        settingsPath: fallbackSettingsPath,
    });

    if (reloadedStaleSchemaAppSettings.maxOutputTokens !== 24576)
        throw new Error(`Schema-backed setting did not reload: ${reloadedStaleSchemaAppSettings.maxOutputTokens}`);

    if (reloadedStaleSchemaAppSettings.codeTheme !== nextCodeTheme)
        throw new Error(`Fallback code theme preference was not reloaded: ${reloadedStaleSchemaAppSettings.codeTheme}`);

    if (reloadedStaleSchemaAppSettings.highContrastEnabled !== true)
        throw new Error('Fallback boolean preference was not reloaded');
} finally {
    if (GLib.file_test(fallbackSettingsPath, GLib.FileTest.EXISTS))
        GLib.unlink(fallbackSettingsPath);
}

print('Cusco app settings smoke passed');
