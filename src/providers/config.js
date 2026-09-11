import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { BUNDLED_CATALOG, clone } from './catalog.js';
import { PROVIDER_DEFINITIONS } from './providerDefinitions.js';

import {
    AnthropicMessagesProvider,
    discoverAnthropicModels,
    discoverGeminiModels,
    discoverOpenAiCompatibleModels,
    GeminiGenerateContentProvider,
    OpenAiCompatibleChatProvider,
    OpenAiResponsesProvider,
} from './remoteProvider.js';
import {
    discoverGeminiImageModels,
    discoverOpenAiImageModels,
} from './imageGeneration.js';
import {
    getDefaultThinkingLevel,
    getSupportedThinkingLevels,
    normalizeThinkingLevel,
} from './thinking.js';
import { normalizeMaxOutputTokens } from './outputLimits.js';
import { createDefaultApiKeyStore } from '../secrets/apiKeyStore.js';
import {
    createDefaultProviderAuthManager,
    listProviderAuthMethods,
} from './auth.js';

const SETTINGS_SCHEMA_ID = 'io.github.stonega.Cusco';
const LEGACY_CUSTOM_PROVIDER_ID = 'openai-compatible';
const CUSTOM_PROVIDER_ID_PREFIX = `${LEGACY_CUSTOM_PROVIDER_ID}-`;
const REQUIRED_SETTINGS_KEYS = [
    'active-provider',
    'active-model',
    'default-image-provider',
    'default-image-model',
    'web-search-provider',
    'enabled-providers',
    'provider-endpoint-presets',
    'provider-custom-endpoints',
    'provider-default-models',
    'provider-discovered-models',
    'provider-default-image-models',
    'provider-custom-image-models',
    'provider-discovered-image-models',
    'provider-auth-methods',
    'custom-openai-compatible-providers',
    'custom-openai-compatible-base-url',
    'custom-openai-compatible-models',
];
const FALLBACK_SETTINGS_VERSION = 1;
const FALLBACK_STRING_DEFAULTS = {
    'active-provider': '',
    'active-model': '',
    'default-image-provider': '',
    'default-image-model': '',
    'web-search-provider': 'duckduckgo',
    'provider-endpoint-presets': '{}',
    'provider-custom-endpoints': '{}',
    'provider-default-models': '{}',
    'provider-discovered-models': '{}',
    'provider-default-image-models': '{}',
    'provider-custom-image-models': '{}',
    'provider-discovered-image-models': '{}',
    'provider-auth-methods': '{}',
    'custom-openai-compatible-providers': '[]',
    'custom-openai-compatible-base-url': '',
};
const FALLBACK_STRV_DEFAULTS = {
    'enabled-providers': [],
    'custom-openai-compatible-models': [],
};

function defaultFallbackSettingsPath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        SETTINGS_SCHEMA_ID,
        'provider-settings.json',
    ]);
}

function normalizeFallbackStrings(value) {
    const strings = { ...FALLBACK_STRING_DEFAULTS };

    if (!value || typeof value !== 'object' || Array.isArray(value))
        return strings;

    for (const key of Object.keys(strings)) {
        if (typeof value[key] === 'string')
            strings[key] = value[key];
    }

    return strings;
}

function normalizeFallbackStrv(value) {
    const strv = {};

    for (const [key, defaultValue] of Object.entries(FALLBACK_STRV_DEFAULTS)) {
        strv[key] = Array.isArray(value?.[key])
            ? value[key].map(String)
            : [...defaultValue];
    }

    return strv;
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

class JsonSettingsStore {
    constructor(path = defaultFallbackSettingsPath()) {
        this.path = path;
        const data = this._load();

        this._strings = data.strings;
        this._strv = data.strv;
    }

    get_string(key) {
        return this._strings[key] ?? '';
    }

    set_string(key, value) {
        this._strings[key] = String(value ?? '');
        this._persist();
        return true;
    }

    get_strv(key) {
        return [...(this._strv[key] ?? [])];
    }

    set_strv(key, value) {
        this._strv[key] = Array.isArray(value) ? value.map(String) : [];
        this._persist();
        return true;
    }

    _load() {
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS)) {
            return {
                strings: normalizeFallbackStrings(null),
                strv: normalizeFallbackStrv(null),
            };
        }

        try {
            const [, contents] = GLib.file_get_contents(this.path);
            const parsed = JSON.parse(new TextDecoder().decode(contents));

            return {
                strings: normalizeFallbackStrings(parsed?.strings),
                strv: normalizeFallbackStrv(parsed?.strv),
            };
        } catch (error) {
            logError(error, 'Failed to load provider settings fallback');
            return {
                strings: normalizeFallbackStrings(null),
                strv: normalizeFallbackStrv(null),
            };
        }
    }

    _persist() {
        const payload = JSON.stringify({
            version: FALLBACK_SETTINGS_VERSION,
            strings: this._strings,
            strv: this._strv,
        }, null, 2);

        writeFileAtomically(this.path, `${payload}\n`);
    }
}

function flushSettings() {
    try {
        Gio.Settings.sync();
    } catch (_error) {
        // Non-GSettings test doubles and file-backed fallbacks persist synchronously.
    }
}

function createDefaultSettings(fallbackPath = null) {
    if (fallbackPath)
        return new JsonSettingsStore(fallbackPath);

    const settingsSource = Gio.SettingsSchemaSource.get_default();
    const schema = settingsSource?.lookup(SETTINGS_SCHEMA_ID, true);

    if (!schema || REQUIRED_SETTINGS_KEYS.some((key) => !schema.has_key(key)))
        return new JsonSettingsStore(fallbackPath ?? defaultFallbackSettingsPath());

    return new Gio.Settings({ schema_id: SETTINGS_SCHEMA_ID });
}

function parseDefaultModelSettings(value) {
    try {
        const parsed = JSON.parse(value || '{}');

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed;
    } catch (_error) {
        // Invalid settings should not stop the application from opening.
    }

    return {};
}

function normalizeEndpointUrl(value) {
    const endpoint = String(value ?? '').trim();
    let uri;

    try {
        uri = GLib.Uri.parse(endpoint, GLib.UriFlags.NONE);
    } catch (_error) {
        uri = null;
    }

    const scheme = uri?.get_scheme()?.toLowerCase() ?? '';

    if (!endpoint || !uri?.get_host() || (scheme !== 'http' && scheme !== 'https')) {
        const error = new Error('Endpoint must be a complete HTTP or HTTPS URL.');
        error.userMessage = 'Enter a complete endpoint URL beginning with http:// or https://.';
        throw error;
    }

    return endpoint.replace(/\/+$/, '');
}

function endpointUrlsMatch(left, right) {
    return String(left ?? '').trim().replace(/\/+$/, '')
        === String(right ?? '').trim().replace(/\/+$/, '');
}

function applyProviderEndpointUrl(provider, baseUrl) {
    const normalizedBaseUrl = normalizeEndpointUrl(baseUrl);
    const matchingPreset = provider.endpointPresets?.find((preset) => (
        endpointUrlsMatch(preset.baseUrl, normalizedBaseUrl)
    ));

    if (matchingPreset) {
        provider.endpointPresetId = matchingPreset.id;
        provider.baseUrl = matchingPreset.baseUrl;
        provider.usesCustomEndpoint = false;
    } else if (endpointUrlsMatch(provider.defaultBaseUrl, normalizedBaseUrl)) {
        provider.endpointPresetId = provider.defaultEndpointPresetId ?? '';
        provider.baseUrl = provider.defaultBaseUrl;
        provider.usesCustomEndpoint = false;
    } else {
        provider.endpointPresetId = '';
        provider.baseUrl = normalizedBaseUrl;
        provider.usesCustomEndpoint = true;
    }
}

function normalizeCustomModels(models) {
    const modelItems = Array.isArray(models)
        ? models
        : String(models ?? '').split(',');
    const seenIds = new Set();

    return modelItems
        .map((model) => {
            const id = String(model?.id ?? model).trim();

            if (!id || seenIds.has(id))
                return null;

            seenIds.add(id);
            const contextWindowTokens = normalizeContextWindowTokens(
                model?.contextWindowTokens
                ?? model?.contextLengthTokens
                ?? model?.contextLength,
            );

            return {
                id,
                name: String(model?.name ?? id),
                description: 'Custom OpenAI-compatible model.',
                maxOutputTokens: normalizeMaxOutputTokens(model?.maxOutputTokens ?? model?.maxTokens),
                ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
            };
        })
        .filter(Boolean);
}

function isCustomProviderId(providerId) {
    const id = String(providerId ?? '').trim();
    return id === LEGACY_CUSTOM_PROVIDER_ID || id.startsWith(CUSTOM_PROVIDER_ID_PREFIX);
}

function normalizeCustomProviderName(name) {
    return String(name ?? '').trim() || 'Custom API';
}

function createCustomProviderConfig({
    id,
    name,
    baseUrl = '',
    models = [],
} = {}) {
    const normalizedId = String(id ?? '').trim();

    if (!isCustomProviderId(normalizedId))
        throw new Error(`Invalid custom provider identifier: ${normalizedId}`);

    const normalizedModels = normalizeCustomModels(models);

    return {
        id: normalizedId,
        name: normalizeCustomProviderName(name),
        description: 'User-defined OpenAI-compatible chat completions API.',
        themeColor: '#64748B',
        implemented: true,
        enabled: false,
        customizable: true,
        apiFormat: 'openai-chat-completions',
        imageApiFormat: 'openai-images',
        supportsImageModelDiscovery: false,
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'CUSCO_CUSTOM_API_KEY',
        authMethods: [{
            id: 'api-key',
            name: 'API key',
            description: 'Use CUSCO_CUSTOM_API_KEY or a key stored in Secret Service.',
            kind: 'api-key',
            available: true,
            reason: '',
        }],
        authMethodId: 'api-key',
        authConfigured: false,
        baseUrl: String(baseUrl ?? '').trim(),
        chatPath: '/chat/completions',
        defaultModelId: normalizedModels[0]?.id ?? '',
        defaultImageModelId: '',
        models: normalizedModels,
        imageModels: [],
        customImageModels: [],
        discoveredImageModels: [],
    };
}

function parseCustomProviderSettings(value) {
    try {
        const parsed = JSON.parse(value || '[]');

        if (Array.isArray(parsed))
            return parsed;
    } catch (_error) {
        // Invalid settings should not stop the application from opening.
    }

    return [];
}

function normalizeCustomImageModels(models, providerId = '') {
    const modelItems = Array.isArray(models)
        ? models
        : String(models ?? '').split(',');

    return modelItems
        .map((model) => String(model?.id ?? model).trim())
        .filter((model, index, allModels) => model && allModels.indexOf(model) === index)
        .filter((model) => isProviderImageModelSupported(providerId, model, { custom: true }))
        .map((model) => ({
            id: model,
            name: model,
            description: 'Custom image generation model.',
            custom: true,
        }));
}

function normalizeContextWindowTokens(value) {
    const tokens = Number(value);

    if (!Number.isFinite(tokens) || tokens <= 0)
        return undefined;

    return Math.round(tokens);
}

function normalizeProviderModelId(providerId, modelId, catalog = BUNDLED_CATALOG) {
    return catalog.normalizeId(providerId, modelId);
}

function isProviderImageModelSupported(providerId, modelId, options = {}, catalog = BUNDLED_CATALOG) {
    return catalog.isSupported(providerId, modelId, { image: true,
        custom: options.custom && isCustomProviderId(providerId) });
}

function normalizeStoredModels(models, providerId = '', catalog = BUNDLED_CATALOG, image = false) {
    if (!Array.isArray(models))
        return [];

    const seenIds = new Set();
    const normalizedModels = [];
    for (const model of models) {
        const rawId = String(model?.id ?? model).trim();
        const id = catalog.normalizeId(providerId, rawId, image);
        if (!id || seenIds.has(id) || !catalog.isSupported(providerId, id, { image }))
            continue;

        const metadata = catalog.getModel(providerId, id, image);
        // Known catalog models are complete authoritative records. In particular,
        // legacy persisted capabilities must not restore a field removed upstream.
        const normalized = metadata ? clone(metadata)
            : typeof model === 'object' && model ? clone(model) : {};
        normalized.id = id;
        normalized.name = metadata?.name ?? String(model?.name ?? id).replace(rawId, id);
        normalized.description = metadata?.description ?? String(model?.description ?? 'Discovered model.');
        if (!image) {
            const context = normalizeContextWindowTokens(normalized.contextWindowTokens
                ?? normalized.contextLengthTokens ?? normalized.contextLength);
            if (context !== undefined)
                normalized.contextWindowTokens = context;
            if (metadata?.maxOutputTokens !== undefined)
                normalized.documentedMaxOutputTokens = metadata.maxOutputTokens;
            normalized.maxOutputTokens = normalizeMaxOutputTokens(
                normalized.requestDefaults?.maxOutputTokens ?? normalized.maxOutputTokens ?? normalized.maxTokens);
        }
        seenIds.add(id);
        normalizedModels.push(normalized);
    }
    const order = catalog.listModels(providerId, image).map(model => model.id);
    const rank = id => order.includes(id) ? order.indexOf(id) : order.length;
    normalizedModels.sort((a, b) => rank(a.id) - rank(b.id));
    return normalizedModels;
}

function normalizeStoredImageModels(models, providerId = '', catalog = BUNDLED_CATALOG) {
    return normalizeStoredModels(models, providerId, catalog, true);
}

function mergeImageModels(models, customModels = []) {
    const merged = [];
    const seenIds = new Set();

    for (const model of [...models, ...customModels]) {
        const id = String(model?.id ?? '').trim();

        if (!id || seenIds.has(id))
            continue;

        seenIds.add(id);
        merged.push({ ...model });
    }

    return merged;
}

function parseImageModelSettings(value) {
    return parseDiscoveredModelSettings(value);
}

export const EXA_SEARCH_CONFIG = {
    id: 'exa-search',
    name: 'Exa Search',
    apiKeyRequired: true,
    apiKeyConfigured: false,
    apiKeyEnvVar: 'EXA_API_KEY',
};

export const DUCKDUCKGO_SEARCH_CONFIG = {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    apiKeyRequired: false,
    apiKeyConfigured: true,
};

function parseDiscoveredModelSettings(value) {
    try {
        const parsed = JSON.parse(value || '{}');

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed;
    } catch (_error) {
        // Invalid settings should not stop the application from opening.
    }

    return {};
}

export function buildDefaultProviderConfigs(catalog = BUNDLED_CATALOG) {
    return PROVIDER_DEFINITIONS.map(definition => ({
        ...clone(definition), ...catalog.providerDefaults(definition.id),
    }));
}

export const DEFAULT_PROVIDER_CONFIGS = buildDefaultProviderConfigs();

export class ProviderConfigStore {
    constructor(configs = DEFAULT_PROVIDER_CONFIGS, options = {}) {
        this._catalogService = options.catalogService ?? null;
        this._catalog = options.catalog ?? this._catalogService?.snapshot ?? BUNDLED_CATALOG;
        this._catalogListeners = new Set();
        this._discoveryFacts = {};
        this._imageDiscoveryFacts = {};
        this._requestSnapshots = new WeakMap();
        if (configs === DEFAULT_PROVIDER_CONFIGS)
            configs = buildDefaultProviderConfigs(this._catalog);
        this._settings = options.settings === undefined ? createDefaultSettings(options.settingsPath) : options.settings;
        this._explicitDefaultModels = parseDefaultModelSettings(this._settings?.get_string('provider-default-models'));
        this._explicitDefaultImageModels = parseDefaultModelSettings(this._settings?.get_string('provider-default-image-models'));
        this._apiKeyStore = options.apiKeyStore ?? createDefaultApiKeyStore();
        this._envLookup = options.envLookup ?? GLib.getenv;
        this._authManager = options.authManager ?? createDefaultProviderAuthManager({
            envLookup: this._envLookup,
        });
        this._apiKeyStatuses = new Map();
        this._activeProviderId = '';
        this._activeModelId = '';
        this._defaultImageProviderId = '';
        this._defaultImageModelId = '';
        this._webSearchProviderId = DUCKDUCKGO_SEARCH_CONFIG.id;
        this._webSearchConfig = { ...EXA_SEARCH_CONFIG };
        this._webSearchApiKeyStatus = {
            configured: false,
            source: null,
            error: null,
        };
        this._configs = configs.map((config) => ({
            ...config,
            authMethods: [
                ...(config.apiKeyRequired
                    ? [{
                        id: 'api-key',
                        name: 'API key',
                        description: `Use ${config.apiKeyEnvVar} or a key stored in Secret Service.`,
                        kind: 'api-key',
                        available: true,
                        reason: '',
                    }]
                    : []),
                ...listProviderAuthMethods(config.id, this._envLookup),
            ],
            authMethodId: config.apiKeyRequired ? 'api-key' : '',
            authConfigured: false,
            defaultBaseUrl: String(config.defaultBaseUrl ?? config.baseUrl ?? '').trim(),
            usesCustomEndpoint: false,
            endpointPresets: (config.endpointPresets ?? []).map((preset) => ({ ...preset })),
            models: this._normalizeModels(config.models, config.id),
            imageModels: (config.imageModels ?? []).map((model) => ({ ...model })),
            customImageModels: (config.customImageModels ?? []).map((model) => ({ ...model })),
            discoveredImageModels: (config.discoveredImageModels ?? []).map((model) => ({ ...model })),
        }));
        this._loadPersistentState();
        this.refreshApiKeyStatus({ autoEnableEnvironmentProviders: true });
        this.refreshAuthenticationStatus();
        this._unsubscribeCatalog = this._catalogService?.subscribe((_status, changed) => {
            if (changed)
                this.applyCatalog(this._catalogService.snapshot);
        });
    }

    _normalizeModelId(providerId, modelId) {
        return normalizeProviderModelId(providerId, modelId, this._catalog);
    }

    _normalizeModels(models, providerId) {
        return normalizeStoredModels(models, providerId, this._catalog);
    }

    _normalizeImageModels(models, providerId) {
        return normalizeStoredImageModels(models, providerId, this._catalog);
    }

    getCatalogService() { return this._catalogService; }

    subscribeCatalog(callback) {
        this._catalogListeners.add(callback);
        return () => this._catalogListeners.delete(callback);
    }

    dispose() {
        this._unsubscribeCatalog?.();
        this._catalogListeners.clear();
    }

    applyCatalog(catalog) {
        const previousCatalog = this._catalog;
        this._catalog = catalog;
        this._configs = this._configs.map(provider => {
            if (provider.customizable || !catalog.getProvider(provider.id))
                return provider;
            const previousDefaults = previousCatalog.getProvider(provider.id)?.modelDefaults ?? {};
            const next = { ...provider };
            for (const key of Object.keys(previousDefaults))
                delete next[key];
            Object.assign(next, catalog.providerDefaults(provider.id));
            next.models = this._normalizeModels([...next.models, ...(this._discoveryFacts[provider.id] ?? [])], provider.id);
            next.imageModels = mergeImageModels(this._normalizeImageModels(
                [...next.imageModels, ...(this._imageDiscoveryFacts[provider.id] ?? [])], provider.id), provider.customImageModels);
            // Only an explicit saved choice overrides a newly recommended default.
            const saved = this._explicitDefaultModels[provider.id];
            const selected = this._normalizeModelId(provider.id, saved);
            if (next.models.some(model => model.id === selected))
                next.defaultModelId = selected;
            const savedImage = this._explicitDefaultImageModels[provider.id];
            const selectedImage = catalog.normalizeId(provider.id, savedImage, true);
            if (next.imageModels.some(model => model.id === selectedImage))
                next.defaultImageModelId = selectedImage;
            // Keep provider identity for credential/settings operations awaiting I/O.
            // Active turns already own independent model snapshots via forRequest().
            for (const key of Object.keys(previousDefaults))
                delete provider[key];
            Object.assign(provider, next);
            return provider;
        });
        this._activeModelId = this._normalizeModelId(this._activeProviderId, this._activeModelId);
        this._defaultImageModelId = catalog.normalizeId(this._defaultImageProviderId, this._defaultImageModelId, true);
        for (const callback of this._catalogListeners)
            callback(catalog);
    }

    // A cancellable is shared by the entire agent turn, including continuations.
    // Snapshot copies keep catalog updates from changing a running turn's models.
    forRequest(cancellable) {
        if (!cancellable || (typeof cancellable !== 'object' && typeof cancellable !== 'function'))
            return this;
        let snapshot = this._requestSnapshots.get(cancellable);
        if (!snapshot) {
            snapshot = Object.create(this);
            snapshot._configs = this._configs.map(provider => ({ ...provider,
                models: provider.models.map(clone), imageModels: (provider.imageModels ?? []).map(clone) }));
            snapshot._catalog = this._catalog;
            for (const key of ['_activeProviderId', '_activeModelId', '_defaultImageProviderId', '_defaultImageModelId'])
                snapshot[key] = this[key];
            this._requestSnapshots.set(cancellable, snapshot);
        }
        return snapshot;
    }

    refreshApiKeyStatus({ autoEnableEnvironmentProviders = false } = {}) {
        let enabledProvidersChanged = false;

        for (const config of this._configs) {
            const environmentApiKey = this._getEnvironmentApiKey(config);
            const status = this._resolveApiKeyStatus(config, environmentApiKey);
            this._setApiKeyStatus(config, status);

            if (autoEnableEnvironmentProviders
                && environmentApiKey
                && !config.enabled
                && this.canEnableProvider(config.id)) {
                config.enabled = true;
                enabledProvidersChanged = true;
            }
        }

        this._setApiKeyStatus(
            this._webSearchConfig,
            this._resolveApiKeyStatus(this._webSearchConfig),
        );

        if (enabledProvidersChanged)
            this._persistEnabledProviders();

        for (const config of this._configs) {
            if (config.authMethodId === 'api-key') {
                config.authStatus = {
                    ...this.getApiKeyStatus(config.id),
                    methodId: 'api-key',
                    available: true,
                };
                config.authConfigured = Boolean(config.authStatus.configured);
            }
        }

        return this.listProviders();
    }

    listProviders({ enabledOnly = false, usableOnly = enabledOnly } = {}) {
        const providers = this._configs.filter((provider) => (
            (!enabledOnly || provider.enabled)
            && (!usableOnly || this._isProviderUsable(provider))
        ));

        return providers.map((provider) => ({
            ...provider,
            authMethods: (provider.authMethods ?? []).map((method) => ({ ...method })),
            authStatus: provider.authStatus ? { ...provider.authStatus } : null,
            endpointPresets: (provider.endpointPresets ?? []).map((preset) => ({ ...preset })),
            models: provider.models.map((model) => ({ ...model })),
            imageModels: (provider.imageModels ?? []).map((model) => ({ ...model })),
            customImageModels: (provider.customImageModels ?? []).map((model) => ({ ...model })),
            discoveredImageModels: (provider.discoveredImageModels ?? []).map((model) => ({ ...model })),
        }));
    }

    listImageProviders({ configuredOnly = false } = {}) {
        return this._configs
            .filter((provider) => (
                provider.imageApiFormat
                && (!configuredOnly || this._isProviderConfiguredForImageGeneration(provider))
            ))
            .map((provider) => ({
                ...provider,
                authMethods: (provider.authMethods ?? []).map((method) => ({ ...method })),
                authStatus: provider.authStatus ? { ...provider.authStatus } : null,
                endpointPresets: (provider.endpointPresets ?? []).map((preset) => ({ ...preset })),
                models: provider.models.map((model) => ({ ...model })),
                imageModels: (provider.imageModels ?? []).map((model) => ({ ...model })),
                customImageModels: (provider.customImageModels ?? []).map((model) => ({ ...model })),
                discoveredImageModels: (provider.discoveredImageModels ?? []).map((model) => ({ ...model })),
            }));
    }

    getNativeSearchTools(providerId, modelId = '') {
        const { provider, model } = this.resolve(providerId, modelId);
        const configuration = model?.nativeSearch === false
            ? null
            : model?.nativeSearch ?? provider?.nativeSearch;

        return Array.isArray(configuration?.tools)
            ? configuration.tools.map(String)
            : [];
    }

    getWebSearchApiKeyStatus() {
        return { ...this._webSearchApiKeyStatus };
    }

    listWebSearchProviders() {
        return [
            {
                ...DUCKDUCKGO_SEARCH_CONFIG,
                selected: this._webSearchProviderId === DUCKDUCKGO_SEARCH_CONFIG.id,
            },
            {
                ...this._webSearchConfig,
                selected: this._webSearchProviderId === EXA_SEARCH_CONFIG.id,
            },
        ];
    }

    getWebSearchProviderId() {
        return this._webSearchProviderId;
    }

    setWebSearchProviderId(providerId) {
        const normalizedProviderId = String(providerId ?? '').trim();

        if (![DUCKDUCKGO_SEARCH_CONFIG.id, EXA_SEARCH_CONFIG.id].includes(normalizedProviderId))
            throw new Error(`Web search provider does not exist: ${providerId}`);

        this._webSearchProviderId = normalizedProviderId;
        this._settings?.set_string('web-search-provider', normalizedProviderId);
        flushSettings();
        return this._webSearchProviderId;
    }

    async setWebSearchApiKey(apiKey) {
        const normalizedApiKey = String(apiKey ?? '').trim();

        if (!normalizedApiKey)
            return this.clearWebSearchApiKey();

        const stored = await this._apiKeyStore.store(
            this._webSearchConfig.id,
            this._webSearchConfig.name,
            normalizedApiKey,
        );

        if (stored === false)
            throw new Error('Secret Service did not store the Exa Search API key');

        return this._setApiKeyStatus(this._webSearchConfig, {
            configured: true,
            source: 'secret',
            error: null,
        });
    }

    async clearWebSearchApiKey() {
        await this._apiKeyStore.clear(this._webSearchConfig.id);
        return this._setApiKeyStatus(
            this._webSearchConfig,
            this._environmentApiKeyStatus(this._webSearchConfig),
        );
    }

    createWebSearchFallbackConfig() {
        if (this._webSearchProviderId === DUCKDUCKGO_SEARCH_CONFIG.id)
            return { ...DUCKDUCKGO_SEARCH_CONFIG };

        return {
            ...this._webSearchConfig,
            apiKey: this._getApiKey(this._webSearchConfig),
        };
    }

    getProvider(providerId) {
        return this._configs.find((provider) => provider.id === providerId) ?? null;
    }

    listAuthenticationMethods(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        const oauthMethods = new Map(
            this._authManager.listMethods(providerId).map((method) => [method.id, method]),
        );
        return (provider.authMethods ?? []).map((method) => ({
            ...method,
            ...(oauthMethods.get(method.id) ?? {}),
            selected: method.id === provider.authMethodId,
        }));
    }

    getAuthenticationStatus(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (provider.authMethodId === 'api-key')
            return { ...this.getApiKeyStatus(providerId), methodId: 'api-key', available: true };

        return {
            ...this._authManager.getStatus(providerId, provider.authMethodId),
            methodId: provider.authMethodId,
        };
    }

    refreshAuthenticationStatus(providerId = '') {
        const providers = providerId ? [this.getProvider(providerId)].filter(Boolean) : this._configs;

        for (const provider of providers) {
            const status = provider.authMethodId
                ? this.getAuthenticationStatus(provider.id)
                : { configured: true, available: true, methodId: '' };
            provider.authStatus = { ...status };
            provider.authConfigured = Boolean(status.configured);
        }

        return providerId
            ? { ...(this.getProvider(providerId)?.authStatus ?? {}) }
            : this.listProviders();
    }

    setAuthenticationMethod(providerId, methodId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        const method = this.listAuthenticationMethods(providerId)
            .find((item) => item.id === String(methodId));
        if (!method)
            throw new Error(`Authentication method does not exist for ${provider.name}: ${methodId}`);

        provider.authMethodId = method.id;
        this.refreshAuthenticationStatus(providerId);
        if (provider.enabled && !this._isSelectedAuthenticationConfigured(provider))
            provider.enabled = false;
        this._persistAuthenticationMethods();
        this._persistEnabledProviders();
        return this.getProvider(providerId);
    }

    async authenticateProvider(providerId, options = {}) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);
        if (!provider.authMethodId || provider.authMethodId === 'api-key')
            throw new Error(`${provider.name} is configured to use an API key`);

        const status = await this._authManager.authenticate(provider.id, provider.authMethodId, {
            ...options,
            providerName: provider.name,
        });
        provider.authStatus = { ...status, methodId: provider.authMethodId };
        provider.authConfigured = Boolean(status.configured);
        if (!provider.enabled && this.canEnableProvider(provider.id)) {
            provider.enabled = true;
            this._persistEnabledProviders();
        }
        return { ...provider.authStatus };
    }

    async clearProviderAuthorization(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);
        if (!provider.authMethodId || provider.authMethodId === 'api-key')
            return this.clearApiKey(providerId);

        const status = await this._authManager.clear(provider.id, provider.authMethodId);
        provider.authStatus = { ...status, methodId: provider.authMethodId };
        provider.authConfigured = false;
        if (provider.enabled) {
            provider.enabled = false;
            this._persistEnabledProviders();
        }
        return { ...provider.authStatus };
    }

    setProviderEndpointPreset(providerId, presetId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        const normalizedPresetId = String(presetId ?? '').trim()
            || provider.defaultEndpointPresetId;
        const preset = provider.endpointPresets?.find((item) => item.id === normalizedPresetId);

        if (!preset)
            throw new Error(`Endpoint preset does not exist for ${provider.name}: ${normalizedPresetId}`);

        provider.endpointPresetId = preset.id;
        provider.baseUrl = preset.baseUrl;
        provider.usesCustomEndpoint = false;
        this._persistEndpointPresets();
        this._persistCustomEndpoints();
        return provider;
    }

    setProviderCustomEndpoint(providerId, baseUrl) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (provider.customizable)
            throw new Error(`Use custom provider settings to update ${provider.name}`);

        applyProviderEndpointUrl(provider, baseUrl);

        this._persistEndpointPresets();
        this._persistCustomEndpoints();
        return provider;
    }

    resetProviderEndpoint(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (provider.customizable)
            throw new Error(`Provider does not have a built-in endpoint: ${provider.name}`);

        const defaultPreset = provider.endpointPresets?.find((preset) => (
            preset.id === provider.defaultEndpointPresetId
        ));

        provider.endpointPresetId = defaultPreset?.id ?? provider.defaultEndpointPresetId ?? '';
        provider.baseUrl = defaultPreset?.baseUrl ?? provider.defaultBaseUrl;
        provider.usesCustomEndpoint = false;
        this._persistEndpointPresets();
        this._persistCustomEndpoints();
        return provider;
    }

    isProviderEnabled(providerId) {
        return this.getProvider(providerId)?.enabled ?? false;
    }

    isProviderAvailable(providerId) {
        const provider = this.getProvider(providerId);
        return provider ? provider.enabled && this._isProviderUsable(provider) : false;
    }

    canEnableProvider(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider?.implemented)
            return false;

        return this._isProviderConfigured(provider)
            && this._isSelectedAuthenticationConfigured(provider);
    }

    getApiKeyStatus(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        const status = this._apiKeyStatuses.get(providerId) ?? this._resolveApiKeyStatus(provider);
        return { ...status };
    }

    async setApiKey(providerId, apiKey) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.apiKeyRequired)
            throw new Error(`${provider.name} does not use API keys`);

        const normalizedApiKey = String(apiKey ?? '').trim();

        if (!normalizedApiKey)
            return this.clearApiKey(providerId);

        const stored = await this._apiKeyStore.store(provider.id, provider.name, normalizedApiKey);

        if (stored === false)
            throw new Error(`Secret Service did not store the ${provider.name} API key`);

        const status = this._setApiKeyStatus(provider, {
            configured: true,
            source: 'secret',
            error: null,
        });

        if (provider.authMethodId === 'api-key')
            this.refreshAuthenticationStatus(provider.id);

        if (!provider.enabled && this.canEnableProvider(provider.id))
            this.setProviderEnabled(provider.id, true);

        return status;
    }

    async clearApiKey(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        await this._apiKeyStore.clear(provider.id);
        const status = this._setApiKeyStatus(provider, this._environmentApiKeyStatus(provider));

        if (provider.authMethodId === 'api-key')
            this.refreshAuthenticationStatus(provider.id);

        if (provider.enabled && provider.authMethodId === 'api-key' && !status.configured)
            this.setProviderEnabled(provider.id, false);

        return status;
    }

    async addCustomProvider({ name, baseUrl, models = [], apiKey = '' } = {}) {
        let providerId;

        do {
            providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${GLib.uuid_string_random()}`;
        } while (this.getProvider(providerId));

        const provider = createCustomProviderConfig({
            id: providerId,
            name,
            baseUrl,
            models,
        });
        const normalizedApiKey = String(apiKey ?? '').trim();

        if (normalizedApiKey) {
            const stored = await this._apiKeyStore.store(provider.id, provider.name, normalizedApiKey);

            if (stored === false)
                throw new Error(`Secret Service did not store the ${provider.name} API key`);
        }

        this._configs.push(provider);
        this._setApiKeyStatus(
            provider,
            normalizedApiKey
                ? {
                    configured: true,
                    source: 'secret',
                    error: null,
                }
                : this._resolveApiKeyStatus(provider),
        );
        this._persistCustomProviders();
        this._persistDefaultModels();
        return this.listProviders().find((item) => item.id === provider.id);
    }

    async removeCustomProvider(providerId) {
        const providerIndex = this._configs.findIndex((provider) => provider.id === providerId);
        const provider = this._configs[providerIndex];

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.customizable)
            throw new Error(`Provider is not customizable: ${providerId}`);

        await this._apiKeyStore.clear(provider.id);
        this._configs.splice(providerIndex, 1);
        this._apiKeyStatuses.delete(provider.id);

        if (this._activeProviderId === provider.id) {
            this._activeProviderId = '';
            this._activeModelId = '';
            this._settings?.set_string('active-provider', '');
            this._settings?.set_string('active-model', '');
        }

        if (this._defaultImageProviderId === provider.id) {
            this._defaultImageProviderId = '';
            this._defaultImageModelId = '';
            this._persistDefaultImageSelection();
        }

        this._persistCustomProviders();
        this._persistEnabledProviders();
        this._persistDefaultModels();
        this._persistDefaultImageModels();
        this._persistDiscoveredModels();
        this._persistCustomImageModels();
        this._persistDiscoveredImageModels();
        flushSettings();
        return true;
    }

    setCustomProviderConfig(providerId, { name, baseUrl, models } = {}) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.customizable)
            throw new Error(`Provider is not customizable: ${providerId}`);

        if (name !== undefined)
            provider.name = normalizeCustomProviderName(name);

        if (baseUrl !== undefined)
            provider.baseUrl = String(baseUrl ?? '').trim();

        if (models !== undefined) {
            const existingModels = new Map(provider.models.map((model) => [model.id, model]));
            provider.models = normalizeCustomModels(models).map((model) => ({
                ...(existingModels.get(model.id) ?? model),
            }));
        }

        if (!provider.models.some((model) => model.id === provider.defaultModelId))
            provider.defaultModelId = provider.models[0]?.id ?? '';

        this._persistCustomProviders();
        this._persistDiscoveredModels();
        this._persistDefaultModels();

        return this.resolve(provider.id, provider.defaultModelId);
    }

    setCustomImageModels(providerId, models) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.imageApiFormat)
            throw new Error(`Provider does not support image generation: ${provider.name}`);

        provider.customImageModels = normalizeCustomImageModels(models, provider.id);
        provider.imageModels = mergeImageModels(
            (provider.imageModels ?? []).filter((model) => !model.custom),
            provider.customImageModels,
        );

        if (!provider.imageModels.some((model) => model.id === provider.defaultImageModelId))
            provider.defaultImageModelId = provider.imageModels[0]?.id ?? '';

        if (this._defaultImageProviderId === provider.id
            && !provider.imageModels.some((model) => model.id === this._defaultImageModelId)) {
            this._defaultImageModelId = provider.defaultImageModelId;
            this._persistDefaultImageSelection();
        }

        this._persistCustomImageModels();
        this._persistDefaultImageModels();
        return this.resolveImageGeneration(provider.id, provider.defaultImageModelId);
    }

    async discoverModels(providerId, options = {}) {
        let provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (provider.supportsModelDiscovery === false)
            throw new Error(`Provider does not support model discovery: ${provider.name}`);

        if (!provider.apiFormat)
            throw new Error(`Provider does not support model discovery: ${provider.name}`);

        if (!this._isProviderConfiguredForModelDiscovery(provider))
            throw new Error(`Provider is not configured for model discovery: ${provider.name}`);

        const providerConfig = {
            ...provider,
            apiKey: this._providerUsesApiKey(provider) ? this._getApiKey(provider) : '',
            authorizeRequest: this._providerRequestAuthorizer(provider),
        };
        const discoverer = options.discoverer ?? ((config, discoverOptions) => (
            this._discoverModelsForProvider(config, discoverOptions)
        ));
        const discoveredModels = await discoverer(providerConfig, {
            cancellable: options.cancellable ?? null,
            timeoutSeconds: options.timeoutSeconds,
        });
        // Provider settings may change while discovery is awaiting HTTP.
        provider = this.getProvider(providerId);
        if (!provider)
            throw new Error('This provider was removed while discovering models.');
        this._discoveryFacts[providerId] = clone(discoveredModels);
        const models = this._normalizeModels(
            this._catalog.getProvider(provider.id)
                ? [...provider.models, ...discoveredModels]
                : discoveredModels,
            provider.id,
        );

        if (models.length === 0)
            throw new Error(`${provider.name} did not return any models`);

        provider.models = models;

        if (!provider.models.some((model) => model.id === provider.defaultModelId))
            provider.defaultModelId = provider.models[0].id;

        if (provider.customizable)
            this._persistCustomProviders();

        this._persistDiscoveredModels();
        this._persistDefaultModels();
        return this.listProviders().find((item) => item.id === provider.id);
    }

    async discoverImageModels(providerId, options = {}) {
        let provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.imageApiFormat || provider.supportsImageModelDiscovery === false)
            throw new Error(`Provider does not support image model discovery: ${provider.name}`);

        if (!this._isProviderConfiguredForImageGeneration(provider))
            throw new Error(`Provider is not configured for image model discovery: ${provider.name}`);

        const requiresApiKey = provider.imageModelDiscoveryRequiresApiKey !== false;
        const providerConfig = {
            ...provider,
            apiKey: provider.apiKeyRequired && requiresApiKey ? this._getApiKey(provider) : '',
        };
        const discoverer = options.discoverer ?? ((config, discoverOptions) => (
            this._discoverImageModelsForProvider(config, discoverOptions)
        ));
        const facts = await discoverer(providerConfig, {
            cancellable: options.cancellable ?? null,
            timeoutSeconds: options.timeoutSeconds,
        });
        provider = this.getProvider(providerId);
        if (!provider)
            throw new Error('This provider was removed while discovering image models.');
        this._imageDiscoveryFacts[providerId] = clone(facts);
        const discoveredModels = this._normalizeImageModels([
            ...this._catalog.listModels(providerId, true), ...facts,
        ], providerId);

        if (discoveredModels.length === 0)
            throw new Error(`${provider.name} did not return any image generation models`);

        provider.discoveredImageModels = discoveredModels;
        provider.imageModels = mergeImageModels(discoveredModels, provider.customImageModels ?? []);

        if (!provider.imageModels.some((model) => model.id === provider.defaultImageModelId))
            provider.defaultImageModelId = provider.imageModels[0].id;

        if (this._defaultImageProviderId === provider.id
            && !provider.imageModels.some((model) => model.id === this._defaultImageModelId)) {
            this._defaultImageModelId = provider.defaultImageModelId;
            this._persistDefaultImageSelection();
        }

        this._persistDiscoveredImageModels();
        this._persistDefaultImageModels();
        return this.listProviders().find((item) => item.id === provider.id);
    }

    getDefaultProvider() {
        const activeProvider = this.getProvider(this._activeProviderId);

        if (activeProvider?.enabled && this._isProviderUsable(activeProvider))
            return activeProvider;

        return this._configs.find((config) => config.enabled && this._isProviderUsable(config)) ?? null;
    }

    getDefaultModel(providerId) {
        const provider = providerId ? this.getProvider(providerId) : this.getDefaultProvider();

        if (!provider)
            return null;

        const activeModel = provider?.id === this._activeProviderId
            ? provider.models.find((model) => model.id === this._activeModelId)
            : null;

        return activeModel
            ?? provider?.models.find((model) => model.id === provider.defaultModelId)
            ?? provider?.models[0]
            ?? null;
    }

    getDefaultImageProvider() {
        const selectedProvider = this.getProvider(this._defaultImageProviderId);

        if (selectedProvider?.imageApiFormat)
            return selectedProvider;

        return this._configs.find((provider) => provider.imageApiFormat) ?? null;
    }

    getDefaultImageModel(providerId) {
        const provider = providerId ? this.getProvider(providerId) : this.getDefaultImageProvider();

        if (!provider)
            return null;

        if (!providerId && provider.id === this._defaultImageProviderId) {
            const selectedModel = provider.imageModels?.find((model) => model.id === this._defaultImageModelId);

            if (selectedModel)
                return selectedModel;
        }

        return provider.imageModels?.find((model) => model.id === provider.defaultImageModelId)
            ?? provider.imageModels?.[0]
            ?? null;
    }

    getImageGenerationSelection() {
        return this.resolveImageGeneration('', '');
    }

    getActiveSelection() {
        const provider = this.getDefaultProvider();
        const model = provider ? this.getDefaultModel(provider.id) : null;

        return { provider, model };
    }

    getFallbackSelection(providerId) {
        const provider = this.listProviders({ enabledOnly: true })
            .find((candidate) => candidate.id !== providerId) ?? null;

        if (!provider)
            return { provider: null, model: null };

        return {
            provider,
            model: this.getDefaultModel(provider.id),
        };
    }

    resolve(providerId, modelId) {
        const provider = this.getProvider(providerId) ?? this.getDefaultProvider();
        const normalizedModelId = this._normalizeModelId(provider?.id, modelId);
        const model = provider
            ? provider.models.find((item) => item.id === normalizedModelId) ?? this.getDefaultModel(provider.id)
            : null;

        return { provider, model };
    }

    assertModelAvailable(providerId, modelId, image = false) {
        const provider = this.getProvider(providerId);
        const id = this._catalog.normalizeId(providerId, modelId, image);
        if (!id || !this._catalog.getProvider(providerId))
            return;
        const models = image ? provider?.imageModels : provider?.models;
        if (models?.some(model => model.id === id))
            return;
        const error = new Error(`The selected model (${modelId}) is no longer in the catalog. Choose a model before sending.`);
        error.code = 'CUSCO_MODEL_UNAVAILABLE';
        error.userMessage = error.message;
        error.nonRetryable = true;
        throw error;
    }

    resolveImageGeneration(providerId, imageModelId = '') {
        const provider = providerId ? this.getProvider(providerId) : this.getDefaultImageProvider();
        const preferredModelId = this._catalog.normalizeId(provider?.id, String(
            imageModelId || (!providerId && provider?.id === this._defaultImageProviderId
                ? this._defaultImageModelId
                : ''),
        ).trim(), true);
        const model = provider
            ? provider.imageModels?.find((item) => item.id === preferredModelId)
                ?? this.getDefaultImageModel(provider.id)
            : null;

        return { provider, model };
    }

    getThinkingLevels(providerId, modelId = '') {
        const { provider, model } = this.resolve(providerId, modelId);

        if (!provider)
            return [];

        return getSupportedThinkingLevels(provider, model);
    }

    getDefaultThinkingLevel(providerId, modelId = '', fallback = undefined) {
        const { provider, model } = this.resolve(providerId, modelId);

        if (!provider)
            return normalizeThinkingLevel(fallback);

        return getDefaultThinkingLevel(provider, model, fallback);
    }

    supportsThinking(providerId, modelId = '') {
        return this.getThinkingLevels(providerId, modelId).length > 0;
    }

    setProviderEnabled(providerId, enabled) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.implemented)
            throw new Error(`Provider is not implemented yet: ${providerId}`);

        if (enabled && !this._isSelectedAuthenticationConfigured(provider))
            throw new Error(`${provider.name} requires configured credentials`);

        provider.enabled = enabled;
        this._persistEnabledProviders();
        return this.resolve(provider.id, provider.defaultModelId);
    }

    setDefaultModel(providerId, modelId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        const normalizedModelId = this._normalizeModelId(provider.id, modelId);

        if (!provider.models.some((model) => model.id === normalizedModelId))
            throw new Error(`Model does not exist for ${providerId}: ${modelId}`);

        provider.defaultModelId = normalizedModelId;
        this._explicitDefaultModels[provider.id] = normalizedModelId;
        this._persistDefaultModels();
        return this.resolve(provider.id, normalizedModelId);
    }

    setDefaultImageModel(providerId, modelId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        const normalizedModelId = this._catalog.normalizeId(provider.id, modelId, true);

        if (!provider.imageModels?.some((model) => model.id === normalizedModelId))
            throw new Error(`Image model does not exist for ${providerId}: ${modelId}`);

        provider.defaultImageModelId = normalizedModelId;
        this._explicitDefaultImageModels[provider.id] = normalizedModelId;
        this._persistDefaultImageModels();
        if (this._defaultImageProviderId === provider.id) {
            this._defaultImageModelId = normalizedModelId;
            this._persistDefaultImageSelection();
        }
        return this.resolveImageGeneration(provider.id, normalizedModelId);
    }

    setDefaultImageProvider(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.imageApiFormat)
            throw new Error(`Provider does not support image generation: ${provider.name}`);

        const model = provider.imageModels?.find((item) => item.id === provider.defaultImageModelId)
            ?? provider.imageModels?.[0]
            ?? null;

        if (model)
            provider.defaultImageModelId = model.id;

        this._defaultImageProviderId = provider.id;
        this._defaultImageModelId = model?.id ?? '';
        this._persistDefaultImageModels();
        this._persistDefaultImageSelection();
        return { provider, model };
    }

    setDefaultImageSelection(providerId, modelId = '') {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.imageApiFormat)
            throw new Error(`Provider does not support image generation: ${provider.name}`);

        const normalizedModelId = this._catalog.normalizeId(provider.id, modelId, true);
        const model = provider.imageModels?.find((item) => item.id === normalizedModelId)
            ?? provider.imageModels?.find((item) => item.id === provider.defaultImageModelId)
            ?? provider.imageModels?.[0]
            ?? null;

        if (!model)
            throw new Error(`Configure an image generation model for ${provider.name}.`);

        provider.defaultImageModelId = model.id;
        this._defaultImageProviderId = provider.id;
        this._defaultImageModelId = model.id;
        this._explicitDefaultImageModels[provider.id] = model.id;
        this._persistDefaultImageModels();
        this._persistDefaultImageSelection();
        return this.resolveImageGeneration(provider.id, model.id);
    }

    setActiveSelection(providerId, modelId) {
        const { provider, model } = this.resolve(providerId, modelId);

        this._activeProviderId = provider?.id ?? '';
        this._activeModelId = model?.id ?? '';
        this._settings?.set_string('active-provider', this._activeProviderId);
        this._settings?.set_string('active-model', this._activeModelId);
        flushSettings();

        return { provider, model };
    }

    createProvider(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.implemented || !this._isProviderConfigured(provider))
            throw new Error(`Provider is not available: ${provider.name}`);

        const apiKey = this._providerUsesApiKey(provider) ? this._getApiKey(provider) : '';
        const providerConfig = {
            ...provider,
            apiKey,
            authorizeRequest: this._providerRequestAuthorizer(provider),
        };

        switch (provider.apiFormat) {
        case 'openai-responses':
            return new OpenAiResponsesProvider(providerConfig);
        case 'openai-chat-completions':
            return new OpenAiCompatibleChatProvider(providerConfig);
        case 'anthropic-messages':
            return new AnthropicMessagesProvider(providerConfig);
        case 'gemini-generate-content':
            return new GeminiGenerateContentProvider(providerConfig);
        default:
            throw new Error(`Provider API format is not implemented: ${provider.apiFormat}`);
        }
    }

    createImageGenerationConfig(providerId, imageModelId = '') {
        const preferredProvider = providerId || this.getDefaultImageProvider()?.id;
        const preferredModel = imageModelId || (preferredProvider === this._defaultImageProviderId
            ? this._defaultImageModelId : '');
        this.assertModelAvailable(preferredProvider, preferredModel, true);
        const { provider, model } = this.resolveImageGeneration(providerId, imageModelId);

        if (!provider)
            throw new Error('Configure an AI provider before generating images.');

        if (!provider.imageApiFormat)
            throw new Error(`${provider.name} does not support image generation.`);

        if (!model)
            throw new Error(`Configure an image generation model for ${provider.name}.`);

        if (!this._isProviderConfiguredForImageGeneration(provider))
            throw new Error(`${provider.name} is not configured for image generation.`);

        const apiKey = provider.apiKeyRequired ? this._getApiKey(provider) : '';

        return {
            provider: {
                ...provider,
                apiKey,
                imageModels: (provider.imageModels ?? []).map((item) => ({ ...item })),
            },
            model: { ...model },
        };
    }

    _isProviderUsable(provider) {
        return provider.implemented
            && this._isProviderConfigured(provider)
            && this._isSelectedAuthenticationConfigured(provider);
    }

    _providerUsesApiKey(provider) {
        return provider.authMethodId === 'api-key'
            || (!provider.authMethodId && provider.apiKeyRequired);
    }

    _isSelectedAuthenticationConfigured(provider) {
        if (!provider.authMethodId)
            return !provider.apiKeyRequired;
        if (this._providerUsesApiKey(provider))
            return Boolean(provider.apiKeyConfigured);

        const status = this._authManager.getStatus(provider.id, provider.authMethodId);
        return Boolean(status.available && status.configured);
    }

    _providerRequestAuthorizer(provider) {
        if (this._providerUsesApiKey(provider))
            return null;

        const methodId = provider.authMethodId;
        return (request, options = {}) => this._authManager.authorizeRequest(
            provider.id,
            methodId,
            request,
            { ...options, providerName: provider.name },
        );
    }

    _isProviderConfigured(provider) {
        if (!provider.customizable)
            return true;

        return Boolean(provider.baseUrl) && provider.models.length > 0;
    }

    _isProviderConfiguredForModelDiscovery(provider) {
        if (!provider.customizable)
            return true;

        return Boolean(provider.baseUrl);
    }

    _isProviderConfiguredForImageGeneration(provider) {
        if (provider.apiKeyRequired && !provider.apiKeyConfigured)
            return false;

        if (!provider.customizable)
            return Boolean(provider.imageApiFormat);

        return Boolean(provider.baseUrl);
    }

    _getEnvironmentApiKey(provider) {
        if (!provider?.apiKeyRequired || !provider.apiKeyEnvVar)
            return '';

        return this._envLookup(provider.apiKeyEnvVar) ?? '';
    }

    _setApiKeyStatus(provider, status) {
        const normalizedStatus = {
            configured: Boolean(status?.configured),
            source: status?.source ?? null,
            error: status?.error ?? null,
        };

        this._apiKeyStatuses.set(provider.id, normalizedStatus);
        provider.apiKeyConfigured = normalizedStatus.configured;

        if (provider.id === this._webSearchConfig.id)
            this._webSearchApiKeyStatus = normalizedStatus;

        return { ...normalizedStatus };
    }

    _environmentApiKeyStatus(provider) {
        const environmentApiKey = this._getEnvironmentApiKey(provider);

        return {
            configured: Boolean(environmentApiKey),
            source: environmentApiKey ? 'environment' : null,
            error: null,
        };
    }

    _resolveApiKeyStatus(provider, environmentApiKey = this._getEnvironmentApiKey(provider)) {
        if (!provider.apiKeyRequired)
            return {
                configured: false,
                source: null,
                error: null,
            };

        let secretError = null;

        try {
            const secretApiKey = this._apiKeyStore.lookup(provider.id);

            if (secretApiKey)
                return {
                    configured: true,
                    source: 'secret',
                    error: null,
                };
        } catch (error) {
            secretError = error;
        }

        if (environmentApiKey)
            return {
                configured: true,
                source: 'environment',
                error: secretError,
            };

        return {
            configured: false,
            source: null,
            error: secretError,
        };
    }

    _getApiKey(provider) {
        let secretError = null;

        try {
            const secretApiKey = this._apiKeyStore.lookup(provider.id);

            if (secretApiKey)
                return secretApiKey;
        } catch (error) {
            secretError = error;
        }

        const envApiKey = this._getEnvironmentApiKey(provider);

        if (envApiKey)
            return envApiKey;

        if (secretError)
            throw secretError;

        const error = new Error(`${provider.name} requires ${provider.apiKeyEnvVar}`);
        error.userMessage = `Configure ${provider.name} credentials in Settings before sending.`;
        throw error;
    }

    async _discoverModelsForProvider(providerConfig, options) {
        switch (providerConfig.apiFormat) {
        case 'openai-responses':
        case 'openai-chat-completions':
            return discoverOpenAiCompatibleModels(providerConfig, options);
        case 'anthropic-messages':
            return discoverAnthropicModels(providerConfig, options);
        case 'gemini-generate-content':
            return discoverGeminiModels(providerConfig, options);
        default:
            throw new Error(`Provider model discovery is not implemented: ${providerConfig.apiFormat}`);
        }
    }

    async _discoverImageModelsForProvider(providerConfig, options) {
        let discoveredModels = [];

        switch (providerConfig.imageApiFormat) {
        case 'openai-images':
            discoveredModels = providerConfig.customizable
                ? []
                : await discoverOpenAiImageModels(providerConfig, options);
            break;
        case 'gemini-interactions':
            discoveredModels = await discoverGeminiImageModels(providerConfig, options);
            break;
        case 'zai-images':
            discoveredModels = this._catalog.listModels(providerConfig.id, true);
            break;
        default:
            throw new Error(`Provider image model discovery is not implemented: ${providerConfig.imageApiFormat}`);
        }

        return discoveredModels.length > 0
            ? discoveredModels
            : (providerConfig.imageModels ?? []).filter((model) => !model.custom);
    }

    _loadPersistentState() {
        if (!this._settings)
            return;

        const webSearchProviderId = this._settings.get_string('web-search-provider');

        if ([DUCKDUCKGO_SEARCH_CONFIG.id, EXA_SEARCH_CONFIG.id].includes(webSearchProviderId))
            this._webSearchProviderId = webSearchProviderId;

        this._loadCustomProviderSettings();
        this._loadAuthenticationMethodSettings();
        this._loadEndpointPresetSettings();
        this._loadCustomEndpointSettings();
        this._loadDiscoveredModelSettings();
        this._loadDiscoveredImageModelSettings();
        this._loadCustomImageModelSettings();

        const enabledProviderIds = this._settings.get_strv('enabled-providers');

        if (enabledProviderIds.length > 0) {
            const enabledProviderSet = new Set(enabledProviderIds);

            for (const provider of this._configs)
                provider.enabled = enabledProviderSet.has(provider.id);
        }

        const defaultModels = parseDefaultModelSettings(this._settings.get_string('provider-default-models'));

        for (const provider of this._configs) {
            const defaultModelId = this._normalizeModelId(provider.id, defaultModels[provider.id]);

            if (provider.models.some((model) => model.id === defaultModelId))
                provider.defaultModelId = defaultModelId;
        }

        const defaultImageModels = parseImageModelSettings(this._settings.get_string('provider-default-image-models'));

        for (const provider of this._configs) {
            const defaultImageModelId = this._catalog.normalizeId(provider.id, defaultImageModels[provider.id], true);

            if (provider.imageModels?.some((model) => model.id === defaultImageModelId))
                provider.defaultImageModelId = defaultImageModelId;
        }

        const imageProviderId = this._settings.get_string('default-image-provider');
        const imageModelId = this._catalog.normalizeId(imageProviderId, this._settings.get_string('default-image-model'), true);
        const imageProvider = this.getProvider(imageProviderId);

        if (imageProvider?.imageApiFormat) {
            const imageModel = imageProvider.imageModels?.find((model) => model.id === imageModelId)
                ?? this.getDefaultImageModel(imageProvider.id);

            if (imageModel) {
                this._defaultImageProviderId = imageProvider.id;
                this._defaultImageModelId = imageModel.id;
            }
        }

        const activeProviderId = this._settings.get_string('active-provider');
        const activeModelId = this._normalizeModelId(activeProviderId, this._settings.get_string('active-model'));

        if (this.getProvider(activeProviderId))
            this._activeProviderId = activeProviderId;

        if (this.getProvider(this._activeProviderId)?.models.some((model) => model.id === activeModelId))
            this._activeModelId = activeModelId;
    }

    _loadDiscoveredModelSettings() {
        const discoveredModels = parseDiscoveredModelSettings(this._settings.get_string('provider-discovered-models'));

        for (const [providerId, models] of Object.entries(discoveredModels)) {
            const provider = this.getProvider(providerId);

            if (!provider)
                continue;

            if (!Array.isArray(models))
                continue;
            this._discoveryFacts[providerId] = clone(models);

            const normalizedModels = this._normalizeModels(
                this._catalog.getProvider(providerId)
                    ? [...provider.models, ...models]
                    : models,
                providerId,
            );

            if (normalizedModels.length > 0)
                provider.models = normalizedModels;
        }
    }

    _loadAuthenticationMethodSettings() {
        const selectedMethods = parseDefaultModelSettings(
            this._settings.get_string('provider-auth-methods'),
        );

        for (const provider of this._configs) {
            const selectedMethodId = String(selectedMethods[provider.id] ?? '').trim();
            if (provider.authMethods.some((method) => method.id === selectedMethodId))
                provider.authMethodId = selectedMethodId;
        }
    }

    _loadEndpointPresetSettings() {
        const selectedPresets = parseDefaultModelSettings(
            this._settings.get_string('provider-endpoint-presets'),
        );

        for (const provider of this._configs) {
            if (!provider.endpointPresets?.length)
                continue;

            const selectedPresetId = String(
                selectedPresets[provider.id] ?? provider.defaultEndpointPresetId ?? '',
            ).trim();
            const preset = provider.endpointPresets.find((item) => item.id === selectedPresetId)
                ?? provider.endpointPresets.find((item) => item.id === provider.defaultEndpointPresetId);

            if (!preset)
                continue;

            provider.endpointPresetId = preset.id;
            provider.baseUrl = preset.baseUrl;
        }
    }

    _loadCustomEndpointSettings() {
        const customEndpoints = parseDefaultModelSettings(
            this._settings.get_string('provider-custom-endpoints'),
        );

        for (const [providerId, baseUrl] of Object.entries(customEndpoints)) {
            const provider = this.getProvider(providerId);

            if (!provider || provider.customizable)
                continue;

            try {
                applyProviderEndpointUrl(provider, baseUrl);
            } catch (_error) {
                // Invalid persisted endpoints should not stop the application from opening.
            }
        }
    }

    _loadDiscoveredImageModelSettings() {
        const discoveredImageModels = parseImageModelSettings(this._settings.get_string('provider-discovered-image-models'));

        for (const [providerId, models] of Object.entries(discoveredImageModels)) {
            const provider = this.getProvider(providerId);

            if (!provider?.imageApiFormat)
                continue;

            if (!Array.isArray(models))
                continue;
            this._imageDiscoveryFacts[providerId] = clone(models);

            const normalizedModels = this._normalizeImageModels([
                ...this._catalog.listModels(providerId, true), ...models,
            ], providerId);

            if (normalizedModels.length > 0) {
                provider.discoveredImageModels = normalizedModels;
                provider.imageModels = mergeImageModels(normalizedModels, provider.customImageModels ?? []);
            }
        }
    }

    _loadCustomImageModelSettings() {
        const customImageModels = parseImageModelSettings(this._settings.get_string('provider-custom-image-models'));

        for (const [providerId, models] of Object.entries(customImageModels)) {
            const provider = this.getProvider(providerId);

            if (!provider?.imageApiFormat)
                continue;

            provider.customImageModels = normalizeCustomImageModels(models, providerId);
            provider.imageModels = mergeImageModels(
                (provider.imageModels ?? []).filter((model) => !model.custom),
                provider.customImageModels,
            );

            if (!provider.imageModels.some((model) => model.id === provider.defaultImageModelId))
                provider.defaultImageModelId = provider.imageModels[0]?.id ?? '';
        }
    }

    _loadCustomProviderSettings() {
        const definitions = parseCustomProviderSettings(
            this._settings.get_string('custom-openai-compatible-providers'),
        );
        let loadedProviderCount = 0;

        for (const definition of definitions) {
            const providerId = String(definition?.id ?? '').trim();

            if (!isCustomProviderId(providerId) || this.getProvider(providerId))
                continue;

            try {
                this._configs.push(createCustomProviderConfig(definition));
                loadedProviderCount++;
            } catch (error) {
                logError(error, 'Failed to load custom provider');
            }
        }

        if (loadedProviderCount > 0)
            return;

        const legacyBaseUrl = this._settings.get_string('custom-openai-compatible-base-url').trim();
        const legacyModels = this._settings.get_strv('custom-openai-compatible-models');

        if ((!legacyBaseUrl && legacyModels.length === 0) || this.getProvider(LEGACY_CUSTOM_PROVIDER_ID))
            return;

        this._configs.push(createCustomProviderConfig({
            id: LEGACY_CUSTOM_PROVIDER_ID,
            name: 'Custom API',
            baseUrl: legacyBaseUrl,
            models: legacyModels,
        }));
        this._persistCustomProviders();
    }

    _persistCustomProviders() {
        const customProviders = this._configs
            .filter((provider) => provider.customizable && isCustomProviderId(provider.id))
            .map((provider) => ({
                id: provider.id,
                name: provider.name,
                baseUrl: provider.baseUrl,
                models: provider.models.map((model) => ({
                    id: model.id,
                    name: model.name,
                    description: model.description,
                    maxOutputTokens: normalizeMaxOutputTokens(model.maxOutputTokens),
                    ...(model.contextWindowTokens === undefined
                        ? {}
                        : { contextWindowTokens: model.contextWindowTokens }),
                })),
            }));

        this._settings?.set_string('custom-openai-compatible-providers', JSON.stringify(customProviders));
        this._settings?.set_string('custom-openai-compatible-base-url', '');
        this._settings?.set_strv('custom-openai-compatible-models', []);
        flushSettings();
    }

    _persistEnabledProviders() {
        const enabledProviderIds = this._configs
            .filter((provider) => provider.enabled)
            .map((provider) => provider.id);

        this._settings?.set_strv('enabled-providers', enabledProviderIds);
        flushSettings();
    }

    _persistAuthenticationMethods() {
        const selectedMethods = {};

        for (const provider of this._configs) {
            if (provider.authMethodId)
                selectedMethods[provider.id] = provider.authMethodId;
        }

        this._settings?.set_string('provider-auth-methods', JSON.stringify(selectedMethods));
        flushSettings();
    }

    _persistEndpointPresets() {
        const selectedPresets = {};

        for (const provider of this._configs) {
            if (provider.endpointPresetId)
                selectedPresets[provider.id] = provider.endpointPresetId;
        }

        this._settings?.set_string('provider-endpoint-presets', JSON.stringify(selectedPresets));
        flushSettings();
    }

    _persistCustomEndpoints() {
        const customEndpoints = {};

        for (const provider of this._configs) {
            if (!provider.customizable && provider.usesCustomEndpoint)
                customEndpoints[provider.id] = provider.baseUrl;
        }

        this._settings?.set_string('provider-custom-endpoints', JSON.stringify(customEndpoints));
        flushSettings();
    }

    _persistDefaultModels() {
        const defaultModels = {};

        for (const provider of this._configs) {
            if (this._explicitDefaultModels[provider.id])
                defaultModels[provider.id] = this._explicitDefaultModels[provider.id];
        }

        this._settings?.set_string('provider-default-models', JSON.stringify(defaultModels));
        flushSettings();
    }

    _persistDefaultImageModels() {
        const defaultImageModels = {};

        for (const provider of this._configs) {
            if (provider.imageApiFormat && this._explicitDefaultImageModels[provider.id])
                defaultImageModels[provider.id] = this._explicitDefaultImageModels[provider.id];
        }

        this._settings?.set_string('provider-default-image-models', JSON.stringify(defaultImageModels));
        flushSettings();
    }

    _persistDefaultImageSelection() {
        this._settings?.set_string('default-image-provider', this._defaultImageProviderId);
        this._settings?.set_string('default-image-model', this._defaultImageModelId);
        flushSettings();
    }

    _persistDiscoveredModels() {
        const discoveredModels = {};

        for (const provider of this._configs) {
            if (!provider.apiFormat || provider.models.length === 0)
                continue;

            const models = provider.customizable ? provider.models : this._discoveryFacts[provider.id] ?? [];
            discoveredModels[provider.id] = models.map(model => {
                const id = this._normalizeModelId(provider.id, model?.id ?? model);
                // Resolved catalog metadata must never become persisted discovery facts.
                return this._catalog.getModel(provider.id, id) ? { id } : clone(model);
            });
        }

        this._settings?.set_string('provider-discovered-models', JSON.stringify(discoveredModels));
        flushSettings();
    }

    _persistCustomImageModels() {
        const customImageModels = {};

        for (const provider of this._configs) {
            if (!provider.imageApiFormat || !provider.customImageModels?.length)
                continue;

            customImageModels[provider.id] = provider.customImageModels.map((model) => ({
                id: model.id,
                name: model.name,
                description: model.description,
                custom: true,
            }));
        }

        this._settings?.set_string('provider-custom-image-models', JSON.stringify(customImageModels));
        flushSettings();
    }

    _persistDiscoveredImageModels() {
        const discoveredImageModels = {};

        for (const provider of this._configs) {
            const models = (this._imageDiscoveryFacts[provider.id] ?? []).filter((model) => !model.custom);

            if (!provider.imageApiFormat || models.length === 0)
                continue;

            discoveredImageModels[provider.id] = models.map(model => {
                const id = this._catalog.normalizeId(provider.id, model?.id ?? model, true);
                return this._catalog.getModel(provider.id, id, true) ? { id } : clone(model);
            });
        }

        this._settings?.set_string('provider-discovered-image-models', JSON.stringify(discoveredImageModels));
        flushSettings();
    }
}
