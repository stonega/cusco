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
import { createDefaultApiKeyStore } from '../secrets/apiKeyStore.js';

const SETTINGS_SCHEMA_ID = 'io.github.stonega.Cusco';
const REQUIRED_SETTINGS_KEYS = [
    'active-provider',
    'active-model',
    'default-image-provider',
    'default-image-model',
    'enabled-providers',
    'provider-default-models',
    'provider-discovered-models',
    'provider-default-image-models',
    'provider-custom-image-models',
    'provider-discovered-image-models',
    'custom-openai-compatible-base-url',
    'custom-openai-compatible-models',
];
const FALLBACK_SETTINGS_VERSION = 1;
const FALLBACK_STRING_DEFAULTS = {
    'active-provider': '',
    'active-model': '',
    'default-image-provider': '',
    'default-image-model': '',
    'provider-default-models': '{}',
    'provider-discovered-models': '{}',
    'provider-default-image-models': '{}',
    'provider-custom-image-models': '{}',
    'provider-discovered-image-models': '{}',
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

function normalizeCustomModels(models) {
    const modelIds = Array.isArray(models)
        ? models
        : String(models ?? '').split(',');

    return modelIds
        .map((model) => String(model).trim())
        .filter((model, index, allModels) => model && allModels.indexOf(model) === index)
        .map((model) => ({
            id: model,
            name: model,
            description: 'Custom OpenAI-compatible model.',
        }));
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
    gemini: {
        'gemini-3.1-pro': 'gemini-3.1-pro-preview',
    },
    zai: {
        'glm5.2': 'glm-5.2',
        'glm5-turbo': 'glm-5-turbo',
    },
};
const PROVIDER_SUPPORTED_MODEL_IDS = {
    gemini: new Set([
        'gemini-3.5-flash',
        'gemini-3.1-pro-preview',
    ]),
    kimi: new Set([
        'kimi-k2.7-code',
        'kimi-k2.7-code-highspeed',
        'kimi-k2.6',
    ]),
    deepseek: new Set([
        'deepseek-v4-pro',
        'deepseek-v4-flash',
    ]),
    grok: new Set([
        'grok-4.5',
        'grok-4.3',
    ]),
    zai: new Set([
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

    return supportedModelIds.has(id) || Boolean(options.custom && providerId === 'openai-compatible');
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
        thinking: OPENAI_GPT_56_THINKING,
    },
    'gpt-5.6-terra': {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        description: 'GPT-5.6 model that balances intelligence and cost.',
        contextWindowTokens: 1050000,
        thinking: OPENAI_GPT_56_THINKING,
    },
    'gpt-5.6-luna': {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        description: 'GPT-5.6 model optimized for cost-sensitive workloads.',
        contextWindowTokens: 1050000,
        thinking: OPENAI_GPT_56_THINKING,
    },
};
const KIMI_MODEL_METADATA = {
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
    'kimi-k2.7-code-highspeed': {
        id: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code High-Speed',
        description: 'High-speed Kimi K2.7 Code variant, around 180 tokens/s and up to 260 tokens/s in short contexts. Context 256k.',
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
const DEEPSEEK_MODEL_METADATA = {
    'deepseek-v4-pro': {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        description: 'DeepSeek reasoning-capable model.',
        contextWindowTokens: 1000000,
        thinking: {
            api: 'deepseek-thinking',
            levels: ['off', 'auto', 'high', 'max'],
        },
    },
    'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        description: 'DeepSeek lower-latency model.',
        contextWindowTokens: 1000000,
        thinking: {
            api: 'deepseek-thinking',
            levels: ['off', 'auto', 'high', 'max'],
        },
    },
};
const ZAI_MODEL_METADATA = {
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
        'claude-opus-4-8': 1000000,
        'claude-sonnet-4-6': 1000000,
        'claude-haiku-4-5-20251001': 200000,
    },
    gemini: {
        'gemini-3.5-flash': 1048576,
        'gemini-3.1-pro-preview': 1048576,
    },
    grok: {
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

        if (contextWindowTokens !== undefined)
            normalizedModel.contextWindowTokens = contextWindowTokens;

        if (thinking !== undefined)
            normalizedModel.thinking = thinking;

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
const GEMINI_3_PRO_LEVEL_THINKING = {
    api: 'gemini-thinking-level',
    levels: ['auto', 'low', 'medium', 'high'],
    includeThoughts: true,
};

export const BRAVE_SEARCH_CONFIG = {
    id: 'brave-search',
    name: 'Brave Search',
    apiKeyRequired: true,
    apiKeyConfigured: false,
    apiKeyEnvVar: 'BRAVE_SEARCH_API_KEY',
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
        defaultModelId: 'claude-sonnet-4-6',
        thinking: {
            api: 'anthropic-adaptive',
            levels: ['off', 'auto', 'low', 'medium', 'high'],
            display: 'summarized',
        },
        models: [
            {
                id: 'claude-opus-4-8',
                name: 'Claude Opus 4.8',
                description: 'Anthropic model for complex reasoning and agentic coding.',
                contextWindowTokens: 1000000,
            },
            {
                id: 'claude-sonnet-4-6',
                name: 'Claude Sonnet 4.6',
                description: 'Fast balance of intelligence and speed.',
                contextWindowTokens: 1000000,
            },
            {
                id: 'claude-haiku-4-5-20251001',
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
            tools: ['google_search'],
        },
        defaultModelId: 'gemini-3.5-flash',
        defaultImageModelId: 'gemini-3.1-flash-image',
        models: [
            {
                id: 'gemini-3.5-flash',
                name: 'Gemini 3.5 Flash',
                description: 'Stable Gemini 3 model for sustained frontier performance.',
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
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'MOONSHOT_API_KEY',
        baseUrl: 'https://api.moonshot.ai/v1',
        chatPath: '/chat/completions',
        defaultModelId: 'kimi-k2.7-code',
        models: [
            { ...KIMI_MODEL_METADATA['kimi-k2.7-code'] },
            { ...KIMI_MODEL_METADATA['kimi-k2.7-code-highspeed'] },
            { ...KIMI_MODEL_METADATA['kimi-k2.6'] },
        ],
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        description: 'DeepSeek OpenAI-compatible API.',
        themeColor: '#4D6BFE',
        implemented: true,
        enabled: false,
        apiFormat: 'openai-chat-completions',
        supportsImageAttachments: false,
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'DEEPSEEK_API_KEY',
        baseUrl: 'https://api.deepseek.com',
        chatPath: '/chat/completions',
        defaultModelId: 'deepseek-v4-pro',
        models: [
            { ...DEEPSEEK_MODEL_METADATA['deepseek-v4-pro'] },
            { ...DEEPSEEK_MODEL_METADATA['deepseek-v4-flash'] },
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
        defaultModelId: 'grok-4.5',
        defaultImageModelId: 'grok-imagine-image-quality',
        models: [
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
        defaultModelId: 'glm-5.2',
        defaultImageModelId: 'glm-image',
        models: [
            { ...ZAI_MODEL_METADATA['glm-5.2'] },
            { ...ZAI_MODEL_METADATA['glm-5-turbo'] },
        ],
        imageModels: [
            { ...IMAGE_MODEL_METADATA.zai['glm-image'] },
        ],
    },
    {
        id: 'openai-compatible',
        name: 'Custom API',
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
        baseUrl: '',
        chatPath: '/chat/completions',
        defaultModelId: '',
        defaultImageModelId: '',
        models: [],
        imageModels: [],
    },
];

export class ProviderConfigStore {
    constructor(configs = DEFAULT_PROVIDER_CONFIGS, options = {}) {
        this._settings = options.settings === undefined ? createDefaultSettings(options.settingsPath) : options.settings;
        this._apiKeyStore = options.apiKeyStore ?? createDefaultApiKeyStore();
        this._envLookup = options.envLookup ?? GLib.getenv;
        this._apiKeyStatuses = new Map();
        this._activeProviderId = '';
        this._activeModelId = '';
        this._defaultImageProviderId = '';
        this._defaultImageModelId = '';
        this._webSearchConfig = { ...BRAVE_SEARCH_CONFIG };
        this._webSearchApiKeyStatus = {
            configured: false,
            source: null,
            error: null,
        };
        this._configs = configs.map((config) => ({
            ...config,
            models: config.models.map((model) => ({ ...model })),
            imageModels: (config.imageModels ?? []).map((model) => ({ ...model })),
            customImageModels: (config.customImageModels ?? []).map((model) => ({ ...model })),
            discoveredImageModels: (config.discoveredImageModels ?? []).map((model) => ({ ...model })),
        }));
        this.refreshApiKeyStatus();
        this._loadPersistentState();
    }

    refreshApiKeyStatus() {
        for (const config of this._configs) {
            const status = this._resolveApiKeyStatus(config);
            this._apiKeyStatuses.set(config.id, status);
            config.apiKeyConfigured = status.configured;
        }

        this._webSearchApiKeyStatus = this._resolveApiKeyStatus(this._webSearchConfig);
        this._webSearchConfig.apiKeyConfigured = this._webSearchApiKeyStatus.configured;

        return this.listProviders();
    }

    listProviders({ enabledOnly = false, usableOnly = enabledOnly } = {}) {
        const providers = this._configs.filter((provider) => (
            (!enabledOnly || provider.enabled)
            && (!usableOnly || this._isProviderUsable(provider))
        ));

        return providers.map((provider) => ({
            ...provider,
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

    setWebSearchApiKey(apiKey) {
        const normalizedApiKey = String(apiKey ?? '').trim();

        if (!normalizedApiKey)
            return this.clearWebSearchApiKey();

        this._apiKeyStore.store(
            this._webSearchConfig.id,
            this._webSearchConfig.name,
            normalizedApiKey,
        );
        this.refreshApiKeyStatus();
        return this.getWebSearchApiKeyStatus();
    }

    clearWebSearchApiKey() {
        this._apiKeyStore.clear(this._webSearchConfig.id);
        this.refreshApiKeyStatus();
        return this.getWebSearchApiKeyStatus();
    }

    createWebSearchFallbackConfig() {
        return {
            ...this._webSearchConfig,
            apiKey: this._getApiKey(this._webSearchConfig),
        };
    }

    getProvider(providerId) {
        return this._configs.find((provider) => provider.id === providerId) ?? null;
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

        return this._isProviderConfigured(provider) && (!provider.apiKeyRequired || provider.apiKeyConfigured);
    }

    getApiKeyStatus(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        const status = this._apiKeyStatuses.get(providerId) ?? this._resolveApiKeyStatus(provider);
        return { ...status };
    }

    setApiKey(providerId, apiKey) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.apiKeyRequired)
            throw new Error(`${provider.name} does not use API keys`);

        const normalizedApiKey = String(apiKey ?? '').trim();

        if (!normalizedApiKey)
            return this.clearApiKey(providerId);

        this._apiKeyStore.store(provider.id, provider.name, normalizedApiKey);
        this.refreshApiKeyStatus();
        return this.getApiKeyStatus(provider.id);
    }

    clearApiKey(providerId) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        this._apiKeyStore.clear(provider.id);
        this.refreshApiKeyStatus();
        return this.getApiKeyStatus(provider.id);
    }

    setCustomProviderConfig(providerId, { baseUrl, models }) {
        const provider = this.getProvider(providerId);

        if (!provider)
            throw new Error(`Provider does not exist: ${providerId}`);

        if (!provider.customizable)
            throw new Error(`Provider is not customizable: ${providerId}`);

        provider.baseUrl = String(baseUrl ?? '').trim();
        provider.models = normalizeCustomModels(models);

        if (!provider.models.some((model) => model.id === provider.defaultModelId))
            provider.defaultModelId = provider.models[0]?.id ?? '';

        this._settings?.set_string('custom-openai-compatible-base-url', provider.baseUrl);
        this._settings?.set_strv('custom-openai-compatible-models', provider.models.map((model) => model.id));
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

        if (!this._isProviderConfigured(provider))
            throw new Error(`Provider is not configured for model discovery: ${provider.name}`);

        const providerConfig = {
            ...provider,
            apiKey: provider.apiKeyRequired ? this._getApiKey(provider) : '',
        };
        const discoverer = options.discoverer ?? ((config, discoverOptions) => (
            this._discoverModelsForProvider(config, discoverOptions)
        ));
        const models = normalizeStoredModels(await discoverer(providerConfig, {
            cancellable: options.cancellable ?? null,
            timeoutSeconds: options.timeoutSeconds,
        }), provider.id);

        if (models.length === 0)
            throw new Error(`${provider.name} did not return any models`);

        provider.models = models;

        if (!provider.models.some((model) => model.id === provider.defaultModelId))
            provider.defaultModelId = provider.models[0].id;

        if (provider.customizable)
            this._settings?.set_strv('custom-openai-compatible-models', provider.models.map((model) => model.id));

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

        if (enabled && provider.apiKeyRequired && !provider.apiKeyConfigured)
            throw new Error(`${provider.name} requires ${provider.apiKeyEnvVar}`);

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

        const apiKey = provider.apiKeyRequired ? this._getApiKey(provider) : '';
        const providerConfig = {
            ...provider,
            apiKey,
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
            && (!provider.apiKeyRequired || provider.apiKeyConfigured);
    }

    _isProviderConfigured(provider) {
        if (!provider.customizable)
            return true;

        return Boolean(provider.baseUrl) && provider.models.length > 0;
    }

    _isProviderConfiguredForImageGeneration(provider) {
        if (!provider.customizable)
            return Boolean(provider.imageApiFormat);

        return Boolean(provider.baseUrl);
    }

    _resolveApiKeyStatus(provider) {
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

        const envApiKey = this._envLookup(provider.apiKeyEnvVar);

        if (envApiKey)
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

        const envApiKey = this._envLookup(provider.apiKeyEnvVar);

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
            discoveredModels = providerConfig.id === 'openai-compatible'
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

        this._loadCustomProviderSettings();
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

            const normalizedModels = normalizeStoredModels(models, providerId);

            if (normalizedModels.length > 0)
                provider.models = normalizedModels;
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
        const provider = this.getProvider('openai-compatible');

        if (!provider?.customizable)
            return;

        provider.baseUrl = this._settings.get_string('custom-openai-compatible-base-url').trim();
        provider.models = normalizeCustomModels(this._settings.get_strv('custom-openai-compatible-models'));

        if (!provider.models.some((model) => model.id === provider.defaultModelId))
            provider.defaultModelId = provider.models[0]?.id ?? '';
    }

    _persistEnabledProviders() {
        const enabledProviderIds = this._configs
            .filter((provider) => provider.enabled)
            .map((provider) => provider.id);

        this._settings?.set_strv('enabled-providers', enabledProviderIds);
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
