import { AppSettingsStore } from '../src/settings/appSettings.js';

class MemorySettings {
    constructor({ booleans = {}, uints = {} } = {}) {
        this._booleans = { ...booleans };
        this._uints = { ...uints };
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

if (appSettings.highContrastEnabled !== true || appSettings.reducedMotionEnabled !== false)
    throw new Error('Accessibility preferences were not loaded');

appSettings.setSendWithEnter(true);
appSettings.setAutoModeEnabled(false);
appSettings.setResponseTimeoutSeconds(2);
appSettings.setProviderFallbackEnabled(false);
appSettings.setHighContrastEnabled(false);
appSettings.setReducedMotionEnabled(true);

if (settings.get_boolean('send-with-enter') !== true)
    throw new Error('Send-with-enter preference was not persisted');

if (settings.get_boolean('auto-mode-enabled') !== false)
    throw new Error('Auto Mode preference was not persisted');

if (settings.get_uint('response-timeout-seconds') !== 5)
    throw new Error(`Timeout preference was not clamped and persisted: ${settings.get_uint('response-timeout-seconds')}`);

if (settings.get_boolean('provider-fallback-enabled') !== false)
    throw new Error('Provider fallback preference was not persisted');

if (settings.get_boolean('high-contrast-enabled') !== false || settings.get_boolean('reduced-motion-enabled') !== true)
    throw new Error('Accessibility preferences were not persisted');

print('Cusco app settings smoke passed');
