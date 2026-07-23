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
        'hooks-enabled': false,
        'high-contrast-enabled': true,
        'reduced-motion-enabled': false,
        'computer-use-enabled': true,
        'computer-use-capture-enabled': true,
        'computer-use-input-enabled': false,
        'computer-use-workspace-switching-enabled': true,
    },
    uints: {
        'response-timeout-seconds': 90,
        'computer-use-action-timeout-seconds': 35,
    },
    strings: {
        'thinking-level': 'high',
        'code-theme': initialCodeTheme,
        'empty-chat-image-path': '/tmp/custom-empty-chat.png',
    },
});
const appSettings = new AppSettingsStore({ settings });

if (appSettings.sendWithEnter !== false)
    throw new Error('Send-with-enter preference was not loaded');

if (appSettings.autoModeEnabled !== true)
    throw new Error('Auto Mode preference was not loaded');

if (appSettings.responseTimeoutSeconds !== 90)
    throw new Error(`Timeout preference was not loaded: ${appSettings.responseTimeoutSeconds}`);

if (appSettings.providerFallbackEnabled !== true)
    throw new Error('Provider fallback preference was not loaded');

if (appSettings.hooksEnabled !== false)
    throw new Error('Hooks preference was not loaded');

if (appSettings.thinkingLevel !== 'high')
    throw new Error(`Thinking level preference was not loaded: ${appSettings.thinkingLevel}`);

if (appSettings.codeTheme !== initialCodeTheme)
    throw new Error(`Code theme preference was not loaded: ${appSettings.codeTheme}`);

if (appSettings.emptyChatImagePath !== '/tmp/custom-empty-chat.png')
    throw new Error('Empty chat image preference was not loaded');

if (appSettings.highContrastEnabled !== true || appSettings.reducedMotionEnabled !== false)
    throw new Error('Accessibility preferences were not loaded');

if (!appSettings.computerUseEnabled
    || !appSettings.computerUseCaptureEnabled
    || appSettings.computerUseInputEnabled
    || !appSettings.computerUseWorkspaceSwitchingEnabled
    || appSettings.computerUseActionTimeoutSeconds !== 35)
    throw new Error('Computer-use preferences were not loaded');

appSettings.setSendWithEnter(true);
appSettings.setAutoModeEnabled(false);
appSettings.setResponseTimeoutSeconds(2);
appSettings.setProviderFallbackEnabled(false);
appSettings.setHooksEnabled(true);
appSettings.setThinkingLevel('low');
appSettings.setCodeTheme(nextCodeTheme);
appSettings.setEmptyChatImagePath('/tmp/next-empty-chat.webp');
appSettings.setHighContrastEnabled(false);
appSettings.setReducedMotionEnabled(true);
appSettings.setComputerUseEnabled(false);
appSettings.setComputerUseCaptureEnabled(false);
appSettings.setComputerUseInputEnabled(true);
appSettings.setComputerUseWorkspaceSwitchingEnabled(false);
appSettings.setComputerUseActionTimeoutSeconds(500);

if (settings.get_boolean('send-with-enter') !== true)
    throw new Error('Send-with-enter preference was not persisted');

if (settings.get_boolean('auto-mode-enabled') !== false)
    throw new Error('Auto Mode preference was not persisted');

if (settings.get_uint('response-timeout-seconds') !== 5)
    throw new Error(`Timeout preference was not clamped and persisted: ${settings.get_uint('response-timeout-seconds')}`);

if (settings.get_boolean('provider-fallback-enabled') !== false)
    throw new Error('Provider fallback preference was not persisted');

if (settings.get_boolean('hooks-enabled') !== true)
    throw new Error('Hooks preference was not persisted');

if (settings.get_string('thinking-level') !== 'low')
    throw new Error('Thinking level preference was not persisted');

if (settings.get_string('code-theme') !== nextCodeTheme)
    throw new Error('Code theme preference was not persisted');

if (settings.get_string('empty-chat-image-path') !== '/tmp/next-empty-chat.webp')
    throw new Error('Empty chat image preference was not persisted');

if (settings.get_boolean('high-contrast-enabled') !== false || settings.get_boolean('reduced-motion-enabled') !== true)
    throw new Error('Accessibility preferences were not persisted');

if (settings.get_boolean('computer-use-enabled') !== false
    || settings.get_boolean('computer-use-capture-enabled') !== false
    || settings.get_boolean('computer-use-input-enabled') !== true
    || settings.get_boolean('computer-use-workspace-switching-enabled') !== false
    || settings.get_uint('computer-use-action-timeout-seconds') !== 120)
    throw new Error('Computer-use preferences were not clamped and persisted');

const partialSettings = new MemorySettings({
    uints: {
        'response-timeout-seconds': 120,
    },
});
const partialAppSettings = new AppSettingsStore({
    settings: partialSettings,
    settingsKeys: ['response-timeout-seconds'],
});

if (partialAppSettings.responseTimeoutSeconds !== 120)
    throw new Error(`Timeout did not load with partial schema support: ${partialAppSettings.responseTimeoutSeconds}`);

partialAppSettings.setResponseTimeoutSeconds(240);
partialAppSettings.setCodeTheme(nextCodeTheme);

if (partialSettings.get_uint('response-timeout-seconds') !== 240)
    throw new Error('Timeout did not persist when unrelated schema keys were missing');

if (partialSettings.get_string('code-theme') !== '')
    throw new Error('Missing schema keys should not be written');

const fallbackSettingsPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-app-settings-${GLib.uuid_string_random()}.json`,
]);
const staleSchemaSettings = new MemorySettings({
    uints: {
        'response-timeout-seconds': 120,
    },
});

try {
    const staleSchemaAppSettings = new AppSettingsStore({
        settings: staleSchemaSettings,
        settingsKeys: ['response-timeout-seconds'],
        settingsPath: fallbackSettingsPath,
    });

    staleSchemaAppSettings.setResponseTimeoutSeconds(240);
    staleSchemaAppSettings.setCodeTheme(nextCodeTheme);
    staleSchemaAppSettings.setEmptyChatImagePath('/tmp/fallback-empty-chat.jpg');
    staleSchemaAppSettings.setHighContrastEnabled(true);

    const reloadedStaleSchemaAppSettings = new AppSettingsStore({
        settings: staleSchemaSettings,
        settingsKeys: ['response-timeout-seconds'],
        settingsPath: fallbackSettingsPath,
    });

    if (reloadedStaleSchemaAppSettings.responseTimeoutSeconds !== 240)
        throw new Error(`Schema-backed setting did not reload: ${reloadedStaleSchemaAppSettings.responseTimeoutSeconds}`);

    if (reloadedStaleSchemaAppSettings.codeTheme !== nextCodeTheme)
        throw new Error(`Fallback code theme preference was not reloaded: ${reloadedStaleSchemaAppSettings.codeTheme}`);

    if (reloadedStaleSchemaAppSettings.emptyChatImagePath !== '/tmp/fallback-empty-chat.jpg')
        throw new Error('Fallback empty chat image preference was not reloaded');

    if (reloadedStaleSchemaAppSettings.highContrastEnabled !== true)
        throw new Error('Fallback boolean preference was not reloaded');
} finally {
    if (GLib.file_test(fallbackSettingsPath, GLib.FileTest.EXISTS))
        GLib.unlink(fallbackSettingsPath);
}

print('Cusco app settings smoke passed');
