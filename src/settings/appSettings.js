import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    DEFAULT_THINKING_LEVEL,
    getThinkingLevelLabel,
    normalizeThinkingLevel,
    THINKING_LEVELS,
} from '../providers/thinking.js';

const SETTINGS_SCHEMA_ID = 'io.github.stonega.Cusco';
const REQUIRED_SETTINGS_KEYS = [
    'send-with-enter',
    'auto-mode-enabled',
    'response-timeout-seconds',
    'provider-fallback-enabled',
    'thinking-level',
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

function createDefaultSettings() {
    const settingsSource = Gio.SettingsSchemaSource.get_default();
    const schema = settingsSource?.lookup(SETTINGS_SCHEMA_ID, true);

    if (!schema || REQUIRED_SETTINGS_KEYS.some((key) => !schema.has_key(key)))
        return null;

    return new Gio.Settings({ schema_id: SETTINGS_SCHEMA_ID });
}

function clampTimeoutSeconds(value) {
    const seconds = Number.isFinite(value) ? Math.round(value) : DEFAULT_RESPONSE_TIMEOUT_SECONDS;
    return Math.min(MAX_RESPONSE_TIMEOUT_SECONDS, Math.max(MIN_RESPONSE_TIMEOUT_SECONDS, seconds));
}

export class AppSettingsStore {
    constructor(options = {}) {
        this._settings = options.settings === undefined ? createDefaultSettings() : options.settings;
        this._sendWithEnter = DEFAULT_SEND_WITH_ENTER;
        this._autoModeEnabled = DEFAULT_AUTO_MODE_ENABLED;
        this._responseTimeoutSeconds = DEFAULT_RESPONSE_TIMEOUT_SECONDS;
        this._providerFallbackEnabled = DEFAULT_PROVIDER_FALLBACK_ENABLED;
        this._thinkingLevel = DEFAULT_THINKING_LEVEL;
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
        this._settings?.set_boolean('send-with-enter', this._sendWithEnter);
        return this._sendWithEnter;
    }

    setAutoModeEnabled(value) {
        this._autoModeEnabled = Boolean(value);
        this._settings?.set_boolean('auto-mode-enabled', this._autoModeEnabled);
        return this._autoModeEnabled;
    }

    get responseTimeoutSeconds() {
        return this._responseTimeoutSeconds;
    }

    setResponseTimeoutSeconds(value) {
        this._responseTimeoutSeconds = clampTimeoutSeconds(value);
        this._settings?.set_uint('response-timeout-seconds', this._responseTimeoutSeconds);
        return this._responseTimeoutSeconds;
    }

    get providerFallbackEnabled() {
        return this._providerFallbackEnabled;
    }

    setProviderFallbackEnabled(value) {
        this._providerFallbackEnabled = Boolean(value);
        this._settings?.set_boolean('provider-fallback-enabled', this._providerFallbackEnabled);
        return this._providerFallbackEnabled;
    }

    get thinkingLevel() {
        return this._thinkingLevel;
    }

    setThinkingLevel(value) {
        this._thinkingLevel = normalizeThinkingLevel(value);
        this._settings?.set_string?.('thinking-level', this._thinkingLevel);
        return this._thinkingLevel;
    }

    get highContrastEnabled() {
        return this._highContrastEnabled;
    }

    setHighContrastEnabled(value) {
        this._highContrastEnabled = Boolean(value);
        this._settings?.set_boolean('high-contrast-enabled', this._highContrastEnabled);
        return this._highContrastEnabled;
    }

    get reducedMotionEnabled() {
        return this._reducedMotionEnabled;
    }

    setReducedMotionEnabled(value) {
        this._reducedMotionEnabled = Boolean(value);
        this._settings?.set_boolean('reduced-motion-enabled', this._reducedMotionEnabled);
        return this._reducedMotionEnabled;
    }

    _loadPersistentState() {
        if (!this._settings)
            return;

        this._sendWithEnter = this._settings.get_boolean('send-with-enter');
        this._autoModeEnabled = this._settings.get_boolean('auto-mode-enabled');
        this._responseTimeoutSeconds = clampTimeoutSeconds(this._settings.get_uint('response-timeout-seconds'));
        this._providerFallbackEnabled = this._settings.get_boolean('provider-fallback-enabled');
        this._thinkingLevel = normalizeThinkingLevel(this._settings.get_string?.('thinking-level'));
        this._highContrastEnabled = this._settings.get_boolean('high-contrast-enabled');
        this._reducedMotionEnabled = this._settings.get_boolean('reduced-motion-enabled');
    }
}

function createThinkingLevelList() {
    const list = new Gtk.StringList();

    for (const level of THINKING_LEVELS)
        list.append(getThinkingLevelLabel(level));

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
        subtitle: 'When off, use the send button.',
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
    page.add(accessibilityGroup);
    return page;
}
