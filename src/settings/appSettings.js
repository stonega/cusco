import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    DEFAULT_THINKING_LEVEL,
    getThinkingLevelLabel,
    normalizeThinkingLevel,
    THINKING_LEVELS,
} from '../providers/thinking.js';
import {
    DEFAULT_MAX_OUTPUT_TOKENS,
    MAX_MAX_OUTPUT_TOKENS,
    MIN_MAX_OUTPUT_TOKENS,
    normalizeMaxOutputTokens,
} from '../providers/outputLimits.js';
import {
    DEFAULT_CODE_THEME_ID,
    getCodeThemeOptions,
    normalizeCodeTheme,
} from '../chat/codeThemes.js';

const SETTINGS_SCHEMA_ID = 'io.github.stonega.Cusco';
const PERSISTENT_SETTINGS_KEYS = [
    'send-with-enter',
    'auto-mode-enabled',
    'response-timeout-seconds',
    'max-output-tokens',
    'provider-fallback-enabled',
    'thinking-level',
    'code-theme',
    'high-contrast-enabled',
    'reduced-motion-enabled',
];

const DEFAULT_SEND_WITH_ENTER = true;
const DEFAULT_AUTO_MODE_ENABLED = true;
const DEFAULT_RESPONSE_TIMEOUT_SECONDS = 45;
const DEFAULT_PROVIDER_FALLBACK_ENABLED = false;
const DEFAULT_HIGH_CONTRAST_ENABLED = false;
const DEFAULT_REDUCED_MOTION_ENABLED = false;
const MIN_RESPONSE_TIMEOUT_SECONDS = 5;
const MAX_RESPONSE_TIMEOUT_SECONDS = 300;
const FALLBACK_SETTINGS_VERSION = 1;
const FALLBACK_BOOLEAN_DEFAULTS = {
    'send-with-enter': DEFAULT_SEND_WITH_ENTER,
    'auto-mode-enabled': DEFAULT_AUTO_MODE_ENABLED,
    'provider-fallback-enabled': DEFAULT_PROVIDER_FALLBACK_ENABLED,
    'high-contrast-enabled': DEFAULT_HIGH_CONTRAST_ENABLED,
    'reduced-motion-enabled': DEFAULT_REDUCED_MOTION_ENABLED,
};
const FALLBACK_UINT_DEFAULTS = {
    'response-timeout-seconds': DEFAULT_RESPONSE_TIMEOUT_SECONDS,
    'max-output-tokens': DEFAULT_MAX_OUTPUT_TOKENS,
};
const FALLBACK_STRING_DEFAULTS = {
    'thinking-level': DEFAULT_THINKING_LEVEL,
    'code-theme': DEFAULT_CODE_THEME_ID,
};

function defaultFallbackSettingsPath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        SETTINGS_SCHEMA_ID,
        'app-settings.json',
    ]);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFallbackBooleans(value) {
    const booleans = {};

    if (!isRecord(value))
        return booleans;

    for (const key of Object.keys(FALLBACK_BOOLEAN_DEFAULTS)) {
        if (typeof value[key] === 'boolean')
            booleans[key] = value[key];
    }

    return booleans;
}

function normalizeFallbackUints(value) {
    const uints = {};

    if (!isRecord(value))
        return uints;

    for (const key of Object.keys(FALLBACK_UINT_DEFAULTS)) {
        if (Number.isFinite(value[key]))
            uints[key] = Math.max(0, Math.round(value[key]));
    }

    return uints;
}

function normalizeFallbackStrings(value) {
    const strings = {};

    if (!isRecord(value))
        return strings;

    for (const key of Object.keys(FALLBACK_STRING_DEFAULTS)) {
        if (typeof value[key] === 'string')
            strings[key] = value[key];
    }

    return strings;
}

function writeFileAtomically(path, contents) {
    const directory = GLib.path_get_dirname(path);
    const basename = GLib.path_get_basename(path);
    const tempPath = GLib.build_filenamev([
        directory,
        `.${basename}.${GLib.uuid_string_random()}.tmp`,
    ]);

    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(tempPath, contents);

    try {
        Gio.File.new_for_path(tempPath).move(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null,
        );
    } finally {
        if (GLib.file_test(tempPath, GLib.FileTest.EXISTS))
            GLib.unlink(tempPath);
    }
}

function flushSettings() {
    try {
        Gio.Settings.sync();
    } catch (_error) {
        // Non-GSettings test doubles and file-backed fallbacks persist synchronously.
    }
}

class JsonAppSettingsStore {
    constructor(path = defaultFallbackSettingsPath()) {
        this.path = path;
        const data = this._load();

        this._booleans = data.booleans;
        this._uints = data.uints;
        this._strings = data.strings;
    }

    has_key(key) {
        return hasOwn(this._booleans, key)
            || hasOwn(this._uints, key)
            || hasOwn(this._strings, key);
    }

    get_boolean(key) {
        return this._booleans[key] ?? FALLBACK_BOOLEAN_DEFAULTS[key] ?? false;
    }

    set_boolean(key, value) {
        if (!hasOwn(FALLBACK_BOOLEAN_DEFAULTS, key))
            return false;

        this._booleans[key] = Boolean(value);
        this._persist();
        return true;
    }

    get_uint(key) {
        return this._uints[key] ?? FALLBACK_UINT_DEFAULTS[key] ?? 0;
    }

    set_uint(key, value) {
        if (!hasOwn(FALLBACK_UINT_DEFAULTS, key))
            return false;

        this._uints[key] = Math.max(0, Math.round(value));
        this._persist();
        return true;
    }

    get_string(key) {
        return this._strings[key] ?? FALLBACK_STRING_DEFAULTS[key] ?? '';
    }

    set_string(key, value) {
        if (!hasOwn(FALLBACK_STRING_DEFAULTS, key))
            return false;

        this._strings[key] = String(value ?? '');
        this._persist();
        return true;
    }

    _load() {
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS)) {
            return {
                booleans: {},
                uints: {},
                strings: {},
            };
        }

        try {
            const [, contents] = GLib.file_get_contents(this.path);
            const parsed = JSON.parse(new TextDecoder().decode(contents));

            return {
                booleans: normalizeFallbackBooleans(parsed?.booleans),
                uints: normalizeFallbackUints(parsed?.uints),
                strings: normalizeFallbackStrings(parsed?.strings),
            };
        } catch (error) {
            logError(error, 'Failed to load app settings fallback');
            return {
                booleans: {},
                uints: {},
                strings: {},
            };
        }
    }

    _persist() {
        const payload = JSON.stringify({
            version: FALLBACK_SETTINGS_VERSION,
            booleans: this._booleans,
            uints: this._uints,
            strings: this._strings,
        }, null, 2);

        writeFileAtomically(this.path, `${payload}\n`);
    }
}

function createDefaultSettingsContext(fallbackPath = null) {
    const settingsSource = Gio.SettingsSchemaSource.get_default();
    const schema = settingsSource?.lookup(SETTINGS_SCHEMA_ID, true);

    if (!schema)
        return {
            settings: null,
            keys: new Set(),
            fallbackSettings: new JsonAppSettingsStore(fallbackPath ?? defaultFallbackSettingsPath()),
        };

    const keys = new Set(PERSISTENT_SETTINGS_KEYS.filter((key) => schema.has_key(key)));

    return {
        settings: new Gio.Settings({ schema_id: SETTINGS_SCHEMA_ID }),
        keys,
        fallbackSettings: keys.size === PERSISTENT_SETTINGS_KEYS.length && !fallbackPath
            ? null
            : new JsonAppSettingsStore(fallbackPath ?? defaultFallbackSettingsPath()),
    };
}

function clampTimeoutSeconds(value) {
    const seconds = Number.isFinite(value) ? Math.round(value) : DEFAULT_RESPONSE_TIMEOUT_SECONDS;
    return Math.min(MAX_RESPONSE_TIMEOUT_SECONDS, Math.max(MIN_RESPONSE_TIMEOUT_SECONDS, seconds));
}

export class AppSettingsStore {
    constructor(options = {}) {
        const settingsContext = options.settings === undefined
            ? createDefaultSettingsContext(options.settingsPath)
            : {
                settings: options.settings,
                keys: options.settingsKeys ? new Set(options.settingsKeys) : null,
                fallbackSettings: options.settingsPath ? new JsonAppSettingsStore(options.settingsPath) : null,
            };

        this._settings = settingsContext.settings;
        this._settingsKeys = settingsContext.keys;
        this._fallbackSettings = settingsContext.fallbackSettings;
        this._sendWithEnter = DEFAULT_SEND_WITH_ENTER;
        this._autoModeEnabled = DEFAULT_AUTO_MODE_ENABLED;
        this._responseTimeoutSeconds = DEFAULT_RESPONSE_TIMEOUT_SECONDS;
        this._maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
        this._providerFallbackEnabled = DEFAULT_PROVIDER_FALLBACK_ENABLED;
        this._thinkingLevel = DEFAULT_THINKING_LEVEL;
        this._codeTheme = DEFAULT_CODE_THEME_ID;
        this._highContrastEnabled = DEFAULT_HIGH_CONTRAST_ENABLED;
        this._reducedMotionEnabled = DEFAULT_REDUCED_MOTION_ENABLED;
        this._loadPersistentState();
    }

    get sendWithEnter() {
        return this._sendWithEnter;
    }

    get autoModeEnabled() {
        return this._autoModeEnabled;
    }

    setSendWithEnter(value) {
        this._sendWithEnter = Boolean(value);
        this._setBoolean('send-with-enter', this._sendWithEnter);
        return this._sendWithEnter;
    }

    setAutoModeEnabled(value) {
        this._autoModeEnabled = Boolean(value);
        this._setBoolean('auto-mode-enabled', this._autoModeEnabled);
        return this._autoModeEnabled;
    }

    get responseTimeoutSeconds() {
        return this._responseTimeoutSeconds;
    }

    setResponseTimeoutSeconds(value) {
        this._responseTimeoutSeconds = clampTimeoutSeconds(value);
        this._setUint('response-timeout-seconds', this._responseTimeoutSeconds);
        return this._responseTimeoutSeconds;
    }

    get maxOutputTokens() {
        return this._maxOutputTokens;
    }

    setMaxOutputTokens(value) {
        this._maxOutputTokens = normalizeMaxOutputTokens(value);
        this._setUint('max-output-tokens', this._maxOutputTokens);
        return this._maxOutputTokens;
    }

    get providerFallbackEnabled() {
        return this._providerFallbackEnabled;
    }

    setProviderFallbackEnabled(value) {
        this._providerFallbackEnabled = Boolean(value);
        this._setBoolean('provider-fallback-enabled', this._providerFallbackEnabled);
        return this._providerFallbackEnabled;
    }

    get thinkingLevel() {
        return this._thinkingLevel;
    }

    setThinkingLevel(value) {
        this._thinkingLevel = normalizeThinkingLevel(value);
        this._setString('thinking-level', this._thinkingLevel);
        return this._thinkingLevel;
    }

    get codeTheme() {
        return this._codeTheme;
    }

    setCodeTheme(value) {
        this._codeTheme = normalizeCodeTheme(value);
        this._setString('code-theme', this._codeTheme);
        return this._codeTheme;
    }

    get highContrastEnabled() {
        return this._highContrastEnabled;
    }

    setHighContrastEnabled(value) {
        this._highContrastEnabled = Boolean(value);
        this._setBoolean('high-contrast-enabled', this._highContrastEnabled);
        return this._highContrastEnabled;
    }

    get reducedMotionEnabled() {
        return this._reducedMotionEnabled;
    }

    setReducedMotionEnabled(value) {
        this._reducedMotionEnabled = Boolean(value);
        this._setBoolean('reduced-motion-enabled', this._reducedMotionEnabled);
        return this._reducedMotionEnabled;
    }

    _hasSettingsKey(key) {
        return Boolean(this._settings) && (!this._settingsKeys || this._settingsKeys.has(key));
    }

    _getBoolean(key, fallback) {
        if (this._hasSettingsKey(key))
            return this._settings.get_boolean(key);

        return this._fallbackSettings?.has_key(key)
            ? this._fallbackSettings.get_boolean(key)
            : fallback;
    }

    _setBoolean(key, value) {
        let changed = false;

        if (this._hasSettingsKey(key)) {
            this._settings.set_boolean(key, value);
            changed = true;
        } else if (this._fallbackSettings) {
            changed = this._fallbackSettings.set_boolean(key, value);
        }

        if (changed)
            flushSettings();
    }

    _getUint(key, fallback) {
        if (this._hasSettingsKey(key))
            return this._settings.get_uint(key);

        return this._fallbackSettings?.has_key(key)
            ? this._fallbackSettings.get_uint(key)
            : fallback;
    }

    _setUint(key, value) {
        let changed = false;

        if (this._hasSettingsKey(key)) {
            this._settings.set_uint(key, value);
            changed = true;
        } else if (this._fallbackSettings) {
            changed = this._fallbackSettings.set_uint(key, value);
        }

        if (changed)
            flushSettings();
    }

    _getString(key, fallback) {
        if (this._hasSettingsKey(key) && typeof this._settings.get_string === 'function')
            return this._settings.get_string(key);

        return this._fallbackSettings?.has_key(key)
            ? this._fallbackSettings.get_string(key)
            : fallback;
    }

    _setString(key, value) {
        let changed = false;

        if (this._hasSettingsKey(key) && typeof this._settings.set_string === 'function') {
            this._settings.set_string(key, value);
            changed = true;
        } else if (this._fallbackSettings) {
            changed = this._fallbackSettings.set_string(key, value);
        }

        if (changed)
            flushSettings();
    }

    _loadPersistentState() {
        if (!this._settings && !this._fallbackSettings)
            return;

        this._sendWithEnter = this._getBoolean('send-with-enter', this._sendWithEnter);
        this._autoModeEnabled = this._getBoolean('auto-mode-enabled', this._autoModeEnabled);
        this._responseTimeoutSeconds = clampTimeoutSeconds(
            this._getUint('response-timeout-seconds', this._responseTimeoutSeconds),
        );
        this._maxOutputTokens = normalizeMaxOutputTokens(this._getUint('max-output-tokens', this._maxOutputTokens));
        this._providerFallbackEnabled = this._getBoolean('provider-fallback-enabled', this._providerFallbackEnabled);
        this._thinkingLevel = normalizeThinkingLevel(this._getString('thinking-level', this._thinkingLevel));
        this._codeTheme = normalizeCodeTheme(this._getString('code-theme', this._codeTheme));
        this._highContrastEnabled = this._getBoolean('high-contrast-enabled', this._highContrastEnabled);
        this._reducedMotionEnabled = this._getBoolean('reduced-motion-enabled', this._reducedMotionEnabled);
    }
}

function createThinkingLevelList() {
    const list = new Gtk.StringList();

    for (const level of THINKING_LEVELS)
        list.append(getThinkingLevelLabel(level));

    return list;
}

function createCodeThemeList(options) {
    const list = new Gtk.StringList();

    for (const option of options)
        list.append(option.label);

    return list;
}

export function createApplicationSettingsPage(appSettings, onChanged) {
    const page = new Adw.PreferencesPage({
        title: 'Chat',
        icon_name: 'preferences-system-symbolic',
    });

    const composerGroup = new Adw.PreferencesGroup({
        title: 'Composer',
    });

    const sendWithEnterRow = new Adw.SwitchRow({
        title: 'Send with Enter',
        subtitle: 'When off, use Ctrl+Enter to send.',
        active: appSettings.sendWithEnter,
    });
    sendWithEnterRow.connect('notify::active', () => {
        appSettings.setSendWithEnter(sendWithEnterRow.get_active());
        onChanged?.();
    });
    composerGroup.add(sendWithEnterRow);

    const automationGroup = new Adw.PreferencesGroup({
        title: 'Automation',
    });
    const autoModeRow = new Adw.SwitchRow({
        title: 'Auto Mode',
        subtitle: 'Run tool actions without asking for confirmation.',
        active: appSettings.autoModeEnabled,
    });
    autoModeRow.connect('notify::active', () => {
        appSettings.setAutoModeEnabled(autoModeRow.get_active());
        onChanged?.();
    });
    automationGroup.add(autoModeRow);

    const providerGroup = new Adw.PreferencesGroup({
        title: 'Providers',
    });
    const timeoutAdjustment = new Gtk.Adjustment({
        lower: MIN_RESPONSE_TIMEOUT_SECONDS,
        upper: MAX_RESPONSE_TIMEOUT_SECONDS,
        step_increment: 5,
        page_increment: 30,
        value: appSettings.responseTimeoutSeconds,
    });
    const timeoutRow = new Adw.SpinRow({
        title: 'Response timeout',
        subtitle: 'Seconds before a provider request is cancelled.',
        adjustment: timeoutAdjustment,
        digits: 0,
    });
    timeoutRow.connect('notify::value', () => {
        appSettings.setResponseTimeoutSeconds(timeoutRow.get_value());
        onChanged?.();
    });
    providerGroup.add(timeoutRow);

    const maxOutputAdjustment = new Gtk.Adjustment({
        lower: MIN_MAX_OUTPUT_TOKENS,
        upper: MAX_MAX_OUTPUT_TOKENS,
        step_increment: 1024,
        page_increment: 4096,
        value: appSettings.maxOutputTokens,
    });
    const maxOutputRow = new Adw.SpinRow({
        title: 'Maximum output tokens',
        subtitle: 'Higher values help long answers finish without asking to continue.',
        adjustment: maxOutputAdjustment,
        digits: 0,
    });
    maxOutputRow.connect('notify::value', () => {
        appSettings.setMaxOutputTokens(maxOutputRow.get_value());
        onChanged?.();
    });
    providerGroup.add(maxOutputRow);

    const fallbackRow = new Adw.SwitchRow({
        title: 'Provider fallback',
        subtitle: 'Try another enabled provider when the selected provider fails.',
        active: appSettings.providerFallbackEnabled,
    });
    fallbackRow.connect('notify::active', () => {
        appSettings.setProviderFallbackEnabled(fallbackRow.get_active());
        onChanged?.();
    });
    providerGroup.add(fallbackRow);

    const thinkingLevelRow = new Adw.ComboRow({
        title: 'Default thinking level',
        subtitle: 'Used for new chats when the selected model supports reasoning.',
        model: createThinkingLevelList(),
        selected: THINKING_LEVELS.indexOf(appSettings.thinkingLevel),
    });
    thinkingLevelRow.connect('notify::selected', () => {
        const level = THINKING_LEVELS[thinkingLevelRow.get_selected()];

        if (!level)
            return;

        appSettings.setThinkingLevel(level);
        onChanged?.();
    });
    providerGroup.add(thinkingLevelRow);

    const appearanceGroup = new Adw.PreferencesGroup({
        title: 'Code Blocks',
    });
    const codeThemeOptions = getCodeThemeOptions();
    const selectedCodeTheme = normalizeCodeTheme(appSettings.codeTheme);
    const selectedCodeThemeIndex = Math.max(
        0,
        codeThemeOptions.findIndex((option) => option.id === selectedCodeTheme),
    );
    const codeThemeRow = new Adw.ComboRow({
        title: 'Color scheme',
        subtitle: 'Syntax highlighting theme for markdown code blocks.',
        model: createCodeThemeList(codeThemeOptions),
        selected: selectedCodeThemeIndex,
    });
    codeThemeRow.connect('notify::selected', () => {
        const option = codeThemeOptions[codeThemeRow.get_selected()];

        if (!option)
            return;

        appSettings.setCodeTheme(option.id);
        onChanged?.({ codeThemeChanged: true });
    });
    appearanceGroup.add(codeThemeRow);

    const accessibilityGroup = new Adw.PreferencesGroup({
        title: 'Accessibility',
    });

    const highContrastRow = new Adw.SwitchRow({
        title: 'High contrast',
        subtitle: 'Increase borders and contrast in Cusco surfaces.',
        active: appSettings.highContrastEnabled,
    });
    highContrastRow.connect('notify::active', () => {
        appSettings.setHighContrastEnabled(highContrastRow.get_active());
        onChanged?.();
    });
    accessibilityGroup.add(highContrastRow);

    const reducedMotionRow = new Adw.SwitchRow({
        title: 'Reduced motion',
        subtitle: 'Prefer static interface updates.',
        active: appSettings.reducedMotionEnabled,
    });
    reducedMotionRow.connect('notify::active', () => {
        appSettings.setReducedMotionEnabled(reducedMotionRow.get_active());
        onChanged?.();
    });
    accessibilityGroup.add(reducedMotionRow);

    page.add(composerGroup);
    page.add(automationGroup);
    page.add(providerGroup);
    page.add(appearanceGroup);
    page.add(accessibilityGroup);
    return page;
}
