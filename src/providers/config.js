import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

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
    discoverZaiImageModels,
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

const PROVIDER_MODEL_ID_ALIASES = {
    openai: {
        'gpt-5.6': 'gpt-5.6-sol',
    },
    anthropic: {
        'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
    },
    gemini: {
        'gemini-3.5-flash': 'gemini-3.7-flash',
        'gemini-3.1-pro': 'gemini-3.1-pro-preview',
    },
    grok: {
        'grok4.6': 'grok-4.6',
    },
    zai: {
        'glm5.3': 'glm-5.3',
        'glm5.2': 'glm-5.2',
        'glm5-turbo': 'glm-5-turbo',
    },
};
const PROVIDER_SUPPORTED_MODEL_IDS = {
    anthropic: new Set([
        'claude-fable-5',
        'claude-opus-5',
        'claude-sonnet-5',
        'claude-haiku-4-5',
    ]),
    gemini: new Set([
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.1-pro-preview',
    ]),
    kimi: new Set([
        'kimi-k3',
        'kimi-k2.7-code',
        'kimi-k2.6',
    ]),
    deepseek: new Set([
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'deepseek-v4-flash-vision-exp',
    ]),
    grok: new Set([
        'grok-4.6',
        'grok-4.5',
        'grok-4.3',
    ]),
    zai: new Set([
        'glm-5.3',
        'glm-5.2',
        'glm-5-turbo',
    ]),
};

const PROVIDER_SUPPORTED_IMAGE_MODEL_IDS = {
    gemini: new Set([
        'gemini-3.1-flash-image',
        'gemini-3.1-flash-lite-image',
        'gemini-3-pro-image',
    ]),
    zai: new Set([
        'glm-image',
    ]),
    grok: new Set([
        'grok-imagine-image-quality',
        'grok-imagine-image',
    ]),
};
const PROVIDER_UNSUPPORTED_IMAGE_MODEL_IDS = {
    gemini: new Set([
        'gemini-2.5-flash-image',
    ]),
    zai: new Set([
        'cogview-4-250304',
    ]),
};

const IMAGE_MODEL_METADATA = {
    openai: {
        'gpt-image-2': {
            id: 'gpt-image-2',
            name: 'GPT Image 2',
            description: 'OpenAI image generation model.',
        },
    },
    gemini: {
        'gemini-3.1-flash-image': {
            id: 'gemini-3.1-flash-image',
            name: 'Gemini 3.1 Flash Image',
            description: 'Gemini Nano Banana 2 image generation model.',
        },
        'gemini-3.1-flash-lite-image': {
            id: 'gemini-3.1-flash-lite-image',
            name: 'Gemini 3.1 Flash Lite Image',
            description: 'Gemini Nano Banana 2 Lite image generation model.',
        },
        'gemini-3-pro-image': {
            id: 'gemini-3-pro-image',
            name: 'Gemini 3 Pro Image',
            description: 'Gemini Nano Banana Pro image generation model.',
        },
    },
    zai: {
        'glm-image': {
            id: 'glm-image',
            name: 'GLM-Image',
            description: 'Z.ai text-to-image model for complex layouts, posters, diagrams, and text-rich images.',
        },
    },
    grok: {
        'grok-imagine-image-quality': {
            id: 'grok-imagine-image-quality',
            name: 'Grok Imagine Image Quality',
            description: 'xAI Grok Imagine image generation model optimized for higher-quality output.',
        },
        'grok-imagine-image': {
            id: 'grok-imagine-image',
            name: 'Grok Imagine Image',
            description: 'xAI Grok Imagine image generation model.',
        },
    },
};

function normalizeProviderModelId(providerId, modelId) {
    const id = String(modelId ?? '').trim();

    return PROVIDER_MODEL_ID_ALIASES[providerId]?.[id] ?? id;
}

function isProviderModelSupported(providerId, modelId) {
    const supportedModelIds = PROVIDER_SUPPORTED_MODEL_IDS[providerId];

    return !supportedModelIds || supportedModelIds.has(modelId);
}

function isProviderImageModelSupported(providerId, modelId, options = {}) {
    const id = String(modelId ?? '').trim();
    const unsupportedModelIds = PROVIDER_UNSUPPORTED_IMAGE_MODEL_IDS[providerId];

    if (unsupportedModelIds?.has(id))
        return false;

    const supportedModelIds = PROVIDER_SUPPORTED_IMAGE_MODEL_IDS[providerId];

    if (!supportedModelIds)
        return true;

    return supportedModelIds.has(id) || Boolean(options.custom && isCustomProviderId(providerId));
}

const OPENAI_GPT_56_THINKING = {
    api: 'openai-responses',
    levels: ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    summary: 'auto',
};
const OPENAI_MODEL_METADATA = {
    'gpt-5.6-sol': {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        description: 'Frontier model for complex professional work.',
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        thinking: OPENAI_GPT_56_THINKING,
    },
    'gpt-5.6-terra': {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        description: 'GPT-5.6 model that balances intelligence and cost.',
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        thinking: OPENAI_GPT_56_THINKING,
    },
    'gpt-5.6-luna': {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        description: 'GPT-5.6 model optimized for cost-sensitive workloads.',
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
        thinking: OPENAI_GPT_56_THINKING,
    },
};
const ANTHROPIC_ADAPTIVE_THINKING = {
    api: 'anthropic-adaptive',
    levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultLevel: 'high',
    display: 'summarized',
};
const ANTHROPIC_ALWAYS_ON_ADAPTIVE_THINKING = {
    ...ANTHROPIC_ADAPTIVE_THINKING,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    alwaysOn: true,
};
const ANTHROPIC_MODEL_METADATA = {
    'claude-fable-5': {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        description: 'Next-generation intelligence for long-running agents.',
        contextWindowTokens: 1000000,
        thinking: ANTHROPIC_ALWAYS_ON_ADAPTIVE_THINKING,
    },
    'claude-opus-5': {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        description: 'For complex agentic coding and enterprise work.',
        contextWindowTokens: 1000000,
        thinking: ANTHROPIC_ADAPTIVE_THINKING,
    },
    'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        description: 'The best combination of speed and intelligence.',
        contextWindowTokens: 1000000,
        thinking: ANTHROPIC_ADAPTIVE_THINKING,
    },
    'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        description: 'Fastest Claude model with near-frontier intelligence.',
        contextWindowTokens: 200000,
        thinking: {
            api: 'anthropic-budget',
            levels: ['off', 'auto', 'low', 'medium', 'high'],
            display: 'summarized',
            budgets: {
                auto: 2048,
                low: 1024,
                medium: 2048,
                high: 3072,
            },
        },
    },
};
const KIMI_MODEL_METADATA = {
    'kimi-k3': {
        id: 'kimi-k3',
        name: 'Kimi K3',
        description: 'Kimi flagship model for long-horizon coding, knowledge work, reasoning, and visual understanding. Context 1M.',
        contextWindowTokens: 1000000,
        maxOutputTokens: 131072,
        thinking: {
            api: 'kimi-k3-reasoning',
            levels: ['max'],
            defaultLevel: 'max',
            alwaysOn: true,
            maxOutputTokensParameter: 'max_completion_tokens',
        },
    },
    'kimi-k2.7-code': {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        description: 'Kimi coding model with stronger long-context instruction following and higher coding task success. Context 256k.',
        contextWindowTokens: 256000,
        thinking: {
            api: 'kimi-thinking',
            levels: ['auto'],
            keep: 'all',
            alwaysOn: true,
        },
    },
    'kimi-k2.6': {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        description: 'Kimi intelligent multimodal model for agent, code, visual understanding, and general tasks with thinking and non-thinking modes. Context 256k.',
        contextWindowTokens: 256000,
        thinking: {
            api: 'kimi-thinking',
            levels: ['off', 'auto'],
            keep: 'all',
        },
    },
};
const DEEPSEEK_RESPONSES_THINKING = {
    api: 'openai-responses',
    levels: ['off', 'low', 'high', 'max'],
    defaultLevel: 'high',
};
const DEEPSEEK_MODEL_METADATA = {
    'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        description: 'DeepSeek reasoning-capable model.',
        contextWindowTokens: 1000000,
        maxOutputTokens: 384000,
        thinking: DEEPSEEK_RESPONSES_THINKING,
    },
    'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        description: 'DeepSeek lower-latency model.',
        contextWindowTokens: 1000000,
        maxOutputTokens: 384000,
        thinking: DEEPSEEK_RESPONSES_THINKING,
    },
    'deepseek-v4-flash-vision-exp': {
        id: 'deepseek-v4-flash-vision-exp',
        name: 'DeepSeek V4 Flash Vision Experimental',
        description: 'Experimental DeepSeek model for visual understanding with text and image input.',
        contextWindowTokens: 1000000,
        maxOutputTokens: 384000,
        supportsImageAttachments: true,
        supportedImageMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
        thinking: DEEPSEEK_RESPONSES_THINKING,
    },
};
const ZAI_MODEL_METADATA = {
    'glm-5.3': {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        description: 'Z.ai flagship model for complex coding and long-horizon agent tasks.',
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
        thinking: {
            api: 'zai-thinking',
            levels: ['low', 'high', 'max'],
            defaultLevel: 'max',
            alwaysOn: true,
            supportsReasoningEffort: true,
        },
    },
    'glm-5.2': {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        description: 'Z.ai flagship model for coding and agent applications.',
        contextWindowTokens: 1000000,
        thinking: {
            api: 'zai-thinking',
            levels: ['off', 'auto', 'high', 'max'],
            supportsReasoningEffort: true,
        },
    },
    'glm-5-turbo': {
        id: 'glm-5-turbo',
        name: 'GLM-5 Turbo',
        description: 'Z.ai faster GLM-5 series model optimized for agent workflows.',
        contextWindowTokens: 200000,
        thinking: {
            api: 'zai-thinking',
            levels: ['off', 'auto'],
        },
    },
};
const GROK_MODEL_METADATA = {
    'grok-4.6': {
        id: 'grok-4.6',
        name: 'Grok 4.6',
        description: 'xAI frontier model for coding, agentic tasks, and knowledge work.',
        contextWindowTokens: 500000,
        thinking: {
            api: 'xai-reasoning',
            levels: ['low', 'medium', 'high', 'xhigh'],
            defaultLevel: 'high',
        },
    },
    'grok-4.5': {
        id: 'grok-4.5',
        name: 'Grok 4.5',
        description: 'xAI Grok model for frontier chat, coding, and agentic work.',
        contextWindowTokens: 1000000,
        thinking: {
            api: 'xai-reasoning',
            levels: ['low', 'medium', 'high'],
            defaultLevel: 'high',
        },
    },
    'grok-4.3': {
        id: 'grok-4.3',
        name: 'Grok 4.3',
        description: 'xAI Grok text and vision model with a 1M token context window.',
        contextWindowTokens: 1000000,
        thinking: {
            api: 'xai-reasoning',
            levels: ['off', 'low', 'medium', 'high'],
            defaultLevel: 'low',
            offEffort: 'none',
        },
    },
};
const PROVIDER_MODEL_METADATA = {
    openai: OPENAI_MODEL_METADATA,
    anthropic: ANTHROPIC_MODEL_METADATA,
    kimi: KIMI_MODEL_METADATA,
    deepseek: DEEPSEEK_MODEL_METADATA,
    grok: GROK_MODEL_METADATA,
    zai: ZAI_MODEL_METADATA,
};
const PROVIDER_MODEL_CONTEXT_WINDOW_TOKENS = {
    openai: {
        'gpt-5.6-sol': 1050000,
        'gpt-5.6-terra': 1050000,
        'gpt-5.6-luna': 1050000,
        'gpt-5.5': 1000000,
        'gpt-5.4-mini': 400000,
        'gpt-4.1': 1000000,
    },
    anthropic: {
        'claude-fable-5': 1000000,
        'claude-opus-5': 1000000,
        'claude-sonnet-5': 1000000,
        'claude-haiku-4-5': 200000,
    },
    gemini: {
        'gemini-3.7-flash': 1048576,
        'gemini-3.6-flash': 1048576,
        'gemini-3.5-flash-lite': 1048576,
        'gemini-3.1-pro-preview': 1048576,
    },
    grok: {
        'grok-4.6': 500000,
        'grok-4.5': 1000000,
        'grok-4.3': 1000000,
    },
};

function getProviderModelMetadata(providerId, modelId) {
    const metadata = PROVIDER_MODEL_METADATA[providerId]?.[modelId] ?? null;
    const contextWindowTokens = PROVIDER_MODEL_CONTEXT_WINDOW_TOKENS[providerId]?.[modelId];

    if (contextWindowTokens === undefined)
        return metadata;

    return {
        ...(metadata ?? {}),
        contextWindowTokens,
    };
}

function normalizeStoredThinkingCapability(value) {
    if (value === false)
        return false;

    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;

    const capability = { ...value };

    if (Array.isArray(value.levels))
        capability.levels = value.levels.map(String);

    if (value.budgets && typeof value.budgets === 'object' && !Array.isArray(value.budgets))
        capability.budgets = { ...value.budgets };

    return capability;
}

function normalizeStoredModels(models, providerId = '') {
    if (!Array.isArray(models))
        return [];

    const seenIds = new Set();
    const normalizedModels = [];

    for (const model of models) {
        const rawId = String(model?.id ?? model).trim();
        const id = normalizeProviderModelId(providerId, rawId);

        if (!id || seenIds.has(id) || !isProviderModelSupported(providerId, id))
            continue;

        const metadata = getProviderModelMetadata(providerId, id);
        const normalizedModel = {
            id,
            name: metadata?.name ?? String(model?.name ?? id).replace(rawId, id),
            description: metadata?.description ?? String(model?.description ?? 'Discovered model.'),
        };
        const contextWindowTokens = normalizeContextWindowTokens(
            metadata?.contextWindowTokens
            ?? model?.contextWindowTokens
            ?? model?.contextLengthTokens
            ?? model?.contextLength,
        );
        const thinking = normalizeStoredThinkingCapability(model?.thinking ?? metadata?.thinking);
        const supportsImageAttachments = metadata?.supportsImageAttachments
            ?? model?.supportsImageAttachments;
        const supportedImageMimeTypes = metadata?.supportedImageMimeTypes
            ?? model?.supportedImageMimeTypes;
        const maxOutputTokens = normalizeMaxOutputTokens(
            metadata?.maxOutputTokens
            ?? model?.maxOutputTokens
            ?? model?.maxTokens,
        );

        if (contextWindowTokens !== undefined)
            normalizedModel.contextWindowTokens = contextWindowTokens;

        normalizedModel.maxOutputTokens = maxOutputTokens;

        if (thinking !== undefined)
            normalizedModel.thinking = thinking;

        if (typeof supportsImageAttachments === 'boolean')
            normalizedModel.supportsImageAttachments = supportsImageAttachments;

        if (Array.isArray(supportedImageMimeTypes)) {
            normalizedModel.supportedImageMimeTypes = [...new Set(supportedImageMimeTypes
                .map((value) => String(value).trim().toLowerCase())
                .filter(Boolean))];
        }

        seenIds.add(id);
        normalizedModels.push(normalizedModel);
    }

    const supportedModelIds = PROVIDER_SUPPORTED_MODEL_IDS[providerId];

    if (supportedModelIds) {
        const modelOrder = [...supportedModelIds];
        normalizedModels.sort((left, right) => modelOrder.indexOf(left.id) - modelOrder.indexOf(right.id));
    }

    return normalizedModels;
}

function normalizeStoredImageModels(models, providerId = '') {
    if (!Array.isArray(models))
        return [];

    const seenIds = new Set();
    const normalizedModels = [];

    for (const model of models) {
        const id = String(model?.id ?? model).trim();

        if (!id || seenIds.has(id) || !isProviderImageModelSupported(providerId, id))
            continue;

        const metadata = IMAGE_MODEL_METADATA[providerId]?.[id];

        seenIds.add(id);
        normalizedModels.push({
            id,
            name: metadata?.name ?? String(model?.name ?? id),
            description: metadata?.description ?? String(model?.description ?? 'Discovered image generation model.'),
            ...(model?.custom ? { custom: true } : {}),
        });
    }

    const supportedModelIds = PROVIDER_SUPPORTED_IMAGE_MODEL_IDS[providerId];

    if (supportedModelIds) {
        const modelOrder = [...supportedModelIds];
        normalizedModels.sort((left, right) => modelOrder.indexOf(left.id) - modelOrder.indexOf(right.id));
    }

    return normalizedModels;
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

const GEMINI_3_LEVEL_THINKING = {
    api: 'gemini-thinking-level',
    levels: ['minimal', 'auto', 'low', 'medium', 'high'],
    includeThoughts: true,
};
const GEMINI_37_THINKING = {
    api: 'gemini-thinking-level',
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'medium',
    alwaysOn: true,
    includeThoughts: true,
};
const GEMINI_3_PRO_LEVEL_THINKING = {
    api: 'gemini-thinking-level',
    levels: ['auto', 'low', 'medium', 'high'],
    includeThoughts: true,
};

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

export const DEFAULT_PROVIDER_CONFIGS = [
    {
        id: 'openai',
        name: 'OpenAI',
        description: 'OpenAI Responses API for GPT models.',
        themeColor: '#000000',
        implemented: true,
        enabled: false,
        apiFormat: 'openai-responses',
        imageApiFormat: 'openai-images',
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'OPENAI_API_KEY',
        baseUrl: 'https://api.openai.com/v1',
        nativeSearch: {
            api: 'openai-responses',
            tools: ['web_search'],
            includeSources: true,
        },
        defaultModelId: 'gpt-5.6-sol',
        defaultImageModelId: 'gpt-image-2',
        thinking: {
            api: 'openai-responses',
            levels: ['off', 'auto', 'low', 'medium', 'high'],
            summary: 'auto',
        },
        models: [
            { ...OPENAI_MODEL_METADATA['gpt-5.6-sol'] },
            { ...OPENAI_MODEL_METADATA['gpt-5.6-terra'] },
            { ...OPENAI_MODEL_METADATA['gpt-5.6-luna'] },
            {
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                description: 'Frontier model for complex reasoning and coding.',
                contextWindowTokens: 1000000,
            },
            {
                id: 'gpt-5.4-mini',
                name: 'GPT-5.4 mini',
                description: 'Lower-latency and lower-cost GPT-5.4 variant.',
                contextWindowTokens: 400000,
            },
            {
                id: 'gpt-4.1',
                name: 'GPT-4.1',
                description: 'Smart non-reasoning model.',
                contextWindowTokens: 1000000,
                thinking: false,
            },
        ],
        imageModels: [
            { ...IMAGE_MODEL_METADATA.openai['gpt-image-2'] },
        ],
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        description: 'Claude Messages API.',
        themeColor: '#F1F0E8',
        implemented: true,
        enabled: false,
        apiFormat: 'anthropic-messages',
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        baseUrl: 'https://api.anthropic.com/v1',
        nativeSearch: {
            api: 'anthropic-messages',
            version: 'web_search_20250305',
            tools: ['web_search'],
            maxUses: 5,
        },
        defaultModelId: 'claude-sonnet-5',
        models: [
            { ...ANTHROPIC_MODEL_METADATA['claude-fable-5'] },
            { ...ANTHROPIC_MODEL_METADATA['claude-opus-5'] },
            { ...ANTHROPIC_MODEL_METADATA['claude-sonnet-5'] },
            { ...ANTHROPIC_MODEL_METADATA['claude-haiku-4-5'] },
        ],
    },
    {
        id: 'gemini',
        name: 'Google Gemini',
        description: 'Gemini generateContent API.',
        themeColor: '#3186FF',
        implemented: true,
        enabled: false,
        apiFormat: 'gemini-generate-content',
        imageApiFormat: 'gemini-interactions',
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'GEMINI_API_KEY',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        nativeSearch: {
            api: 'gemini-generate-content',
            tools: ['google_search', 'url_context'],
        },
        defaultModelId: 'gemini-3.7-flash',
        defaultImageModelId: 'gemini-3.1-flash-image',
        models: [
            {
                id: 'gemini-3.7-flash',
                name: 'Gemini 3.7 Flash',
                description: 'Google\'s most capable Flash model for complex coding and agentic workflows.',
                contextWindowTokens: 1048576,
                maxOutputTokens: 65536,
                thinking: GEMINI_37_THINKING,
            },
            {
                id: 'gemini-3.6-flash',
                name: 'Gemini 3.6 Flash',
                description: 'Stable Gemini model balancing speed and intelligence for agentic and multimodal tasks.',
                contextWindowTokens: 1048576,
                thinking: GEMINI_3_LEVEL_THINKING,
            },
            {
                id: 'gemini-3.5-flash-lite',
                name: 'Gemini 3.5 Flash-Lite',
                description: 'Low-latency, cost-effective multimodal model for high-throughput agentic workflows and document parsing.',
                contextWindowTokens: 1048576,
                thinking: GEMINI_3_LEVEL_THINKING,
            },
            {
                id: 'gemini-3.1-pro-preview',
                name: 'Gemini 3.1 Pro Preview',
                description: 'Advanced intelligence and agentic coding model.',
                contextWindowTokens: 1048576,
                thinking: GEMINI_3_PRO_LEVEL_THINKING,
            },
        ],
        imageModels: [
            { ...IMAGE_MODEL_METADATA.gemini['gemini-3.1-flash-image'] },
            { ...IMAGE_MODEL_METADATA.gemini['gemini-3.1-flash-lite-image'] },
            { ...IMAGE_MODEL_METADATA.gemini['gemini-3-pro-image'] },
        ],
    },
    {
        id: 'kimi',
        name: 'Kimi',
        description: 'Moonshot Kimi OpenAI-compatible API.',
        themeColor: '#1783FF',
        implemented: true,
        enabled: false,
        apiFormat: 'openai-chat-completions',
        supportsStreamUsageOptions: true,
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'MOONSHOT_API_KEY',
        baseUrl: 'https://api.moonshot.ai/v1',
        defaultEndpointPresetId: 'global',
        endpointPresetId: 'global',
        endpointPresets: [
            {
                id: 'global',
                label: 'Global',
                baseUrl: 'https://api.moonshot.ai/v1',
            },
            {
                id: 'cn',
                label: 'CN',
                baseUrl: 'https://api.moonshot.cn/v1',
            },
        ],
        chatPath: '/chat/completions',
        defaultModelId: 'kimi-k3',
        models: [
            { ...KIMI_MODEL_METADATA['kimi-k3'] },
            { ...KIMI_MODEL_METADATA['kimi-k2.7-code'] },
            { ...KIMI_MODEL_METADATA['kimi-k2.6'] },
        ],
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        description: 'DeepSeek Responses API.',
        themeColor: '#4D6BFE',
        implemented: true,
        enabled: false,
        apiFormat: 'openai-responses',
        supportsImageAttachments: false,
        supportsReasoningContentItems: true,
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'DEEPSEEK_API_KEY',
        baseUrl: 'https://api.deepseek.com',
        nativeSearch: {
            api: 'openai-responses',
            tools: ['web_search'],
        },
        defaultModelId: 'deepseek-v4-pro',
        models: [
            { ...DEEPSEEK_MODEL_METADATA['deepseek-v4-pro'] },
            { ...DEEPSEEK_MODEL_METADATA['deepseek-v4-flash'] },
            { ...DEEPSEEK_MODEL_METADATA['deepseek-v4-flash-vision-exp'] },
        ],
    },
    {
        id: 'grok',
        name: 'Grok',
        description: 'xAI Grok Responses API.',
        themeColor: '#111111',
        implemented: true,
        enabled: false,
        apiFormat: 'openai-responses',
        imageApiFormat: 'openai-images',
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'XAI_API_KEY',
        baseUrl: 'https://api.x.ai/v1',
        nativeSearch: {
            api: 'openai-responses',
            tools: ['web_search', 'x_search'],
        },
        defaultModelId: 'grok-4.6',
        defaultImageModelId: 'grok-imagine-image-quality',
        models: [
            { ...GROK_MODEL_METADATA['grok-4.6'] },
            { ...GROK_MODEL_METADATA['grok-4.5'] },
            { ...GROK_MODEL_METADATA['grok-4.3'] },
        ],
        imageModels: [
            { ...IMAGE_MODEL_METADATA.grok['grok-imagine-image-quality'] },
            { ...IMAGE_MODEL_METADATA.grok['grok-imagine-image'] },
        ],
    },
    {
        id: 'zai',
        name: 'Z.ai',
        description: 'Z.ai GLM OpenAI-compatible API.',
        themeColor: '#000000',
        implemented: true,
        enabled: false,
        apiFormat: 'openai-chat-completions',
        supportsImageAttachments: false,
        supportsModelDiscovery: false,
        imageApiFormat: 'zai-images',
        imageModelDiscoveryRequiresApiKey: false,
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'ZAI_API_KEY',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        chatPath: '/chat/completions',
        nativeSearch: {
            api: 'zai-chat-completions',
            tools: ['web_search'],
            searchEngine: 'search-prime',
            count: 5,
        },
        defaultModelId: 'glm-5.3',
        defaultImageModelId: 'glm-image',
        models: [
            { ...ZAI_MODEL_METADATA['glm-5.3'] },
            { ...ZAI_MODEL_METADATA['glm-5.2'] },
            { ...ZAI_MODEL_METADATA['glm-5-turbo'] },
        ],
        imageModels: [
            { ...IMAGE_MODEL_METADATA.zai['glm-image'] },
        ],
    },
];

export class ProviderConfigStore {
    constructor(configs = DEFAULT_PROVIDER_CONFIGS, options = {}) {
        this._settings = options.settings === undefined ? createDefaultSettings(options.settingsPath) : options.settings;
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
            models: normalizeStoredModels(config.models, config.id),
            imageModels: (config.imageModels ?? []).map((model) => ({ ...model })),
            customImageModels: (config.customImageModels ?? []).map((model) => ({ ...model })),
            discoveredImageModels: (config.discoveredImageModels ?? []).map((model) => ({ ...model })),
        }));
        this._loadPersistentState();
        this.refreshApiKeyStatus({ autoEnableEnvironmentProviders: true });
        this.refreshAuthenticationStatus();
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
        const provider = this.getProvider(providerId);

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
        const models = normalizeStoredModels(
            PROVIDER_SUPPORTED_MODEL_IDS[provider.id]
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
        const provider = this.getProvider(providerId);

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
        const discoveredModels = normalizeStoredImageModels(await discoverer(providerConfig, {
            cancellable: options.cancellable ?? null,
            timeoutSeconds: options.timeoutSeconds,
        }), provider.id);

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
        const normalizedModelId = normalizeProviderModelId(provider?.id, modelId);
        const model = provider
            ? provider.models.find((item) => item.id === normalizedModelId) ?? this.getDefaultModel(provider.id)
            : null;

        return { provider, model };
    }

    resolveImageGeneration(providerId, imageModelId = '') {
        const provider = providerId ? this.getProvider(providerId) : this.getDefaultImageProvider();
        const preferredModelId = String(
            imageModelId || (!providerId && provider?.id === this._defaultImageProviderId
                ? this._defaultImageModelId
                : ''),
        ).trim();
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

        const normalizedModelId = normalizeProviderModelId(provider.id, modelId);

        if (!provider.models.some((model) => model.id === normalizedModelId))
            throw new Error(`Model does not exist for ${providerId}: ${modelId}`);

        provider.defaultModelId = normalizedModelId;
        this._persistDefaultModels();
        return this.resolve(provider.id, normalizedModelId);
    }

    setDefaultImageModel(providerId, modelId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        const normalizedModelId = String(modelId ?? '').trim();

        if (!provider.imageModels?.some((model) => model.id === normalizedModelId))
            throw new Error(`Image model does not exist for ${providerId}: ${modelId}`);

        provider.defaultImageModelId = normalizedModelId;
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

        const normalizedModelId = String(modelId ?? '').trim();
        const model = provider.imageModels?.find((item) => item.id === normalizedModelId)
            ?? provider.imageModels?.find((item) => item.id === provider.defaultImageModelId)
            ?? provider.imageModels?.[0]
            ?? null;

        if (!model)
            throw new Error(`Configure an image generation model for ${provider.name}.`);

        provider.defaultImageModelId = model.id;
        this._defaultImageProviderId = provider.id;
        this._defaultImageModelId = model.id;
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
            discoveredModels = discoverZaiImageModels();
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
            const defaultModelId = normalizeProviderModelId(provider.id, defaultModels[provider.id]);

            if (provider.models.some((model) => model.id === defaultModelId))
                provider.defaultModelId = defaultModelId;
        }

        const defaultImageModels = parseImageModelSettings(this._settings.get_string('provider-default-image-models'));

        for (const provider of this._configs) {
            const defaultImageModelId = String(defaultImageModels[provider.id] ?? '').trim();

            if (provider.imageModels?.some((model) => model.id === defaultImageModelId))
                provider.defaultImageModelId = defaultImageModelId;
        }

        const imageProviderId = this._settings.get_string('default-image-provider');
        const imageModelId = this._settings.get_string('default-image-model');
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
        const activeModelId = normalizeProviderModelId(activeProviderId, this._settings.get_string('active-model'));

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

            const normalizedModels = normalizeStoredModels(
                PROVIDER_SUPPORTED_MODEL_IDS[providerId]
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

            const normalizedModels = normalizeStoredImageModels(models, providerId);

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

        for (const provider of this._configs)
            defaultModels[provider.id] = provider.defaultModelId;

        this._settings?.set_string('provider-default-models', JSON.stringify(defaultModels));
        flushSettings();
    }

    _persistDefaultImageModels() {
        const defaultImageModels = {};

        for (const provider of this._configs) {
            if (provider.imageApiFormat)
                defaultImageModels[provider.id] = provider.defaultImageModelId ?? '';
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

            discoveredModels[provider.id] = provider.models.map((model) => ({
                id: model.id,
                name: model.name,
                description: model.description,
                ...(model.contextWindowTokens === undefined
                    ? {}
                    : { contextWindowTokens: model.contextWindowTokens }),
                maxOutputTokens: normalizeMaxOutputTokens(model.maxOutputTokens),
                ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
            }));
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
            const models = (provider.discoveredImageModels?.length
                ? provider.discoveredImageModels
                : provider.imageModels ?? []).filter((model) => !model.custom);

            if (!provider.imageApiFormat || models.length === 0)
                continue;

            discoveredImageModels[provider.id] = models.map((model) => ({
                id: model.id,
                name: model.name,
                description: model.description,
            }));
        }

        this._settings?.set_string('provider-discovered-image-models', JSON.stringify(discoveredImageModels));
        flushSettings();
    }
}
