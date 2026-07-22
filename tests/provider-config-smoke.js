import GLib from 'gi://GLib?version=2.0';

import { ProviderConfigStore } from '../src/providers/config.js';
import { MemoryApiKeyStore } from '../src/secrets/apiKeyStore.js';

class MemorySettings {
    constructor({ strings = {}, strv = {} } = {}) {
        this._strings = { ...strings };
        this._strv = {};

        for (const [key, value] of Object.entries(strv))
            this._strv[key] = [...value];
    }

    get_string(key) {
        return this._strings[key] ?? '';
    }

    set_string(key, value) {
        this._strings[key] = value;
        return true;
    }

    get_strv(key) {
        return [...(this._strv[key] ?? [])];
    }

    set_strv(key, value) {
        this._strv[key] = [...value];
        return true;
    }
}

const configs = [
    {
        id: 'test-remote',
        name: 'Test Remote',
        description: 'Remote provider with no credentials for tests.',
        implemented: true,
        enabled: true,
        apiFormat: 'openai-chat-completions',
        apiKeyRequired: false,
        apiKeyConfigured: false,
        baseUrl: 'https://example.invalid/v1',
        defaultModelId: 'remote-small',
        models: [
            { id: 'remote-small', name: 'Remote Small' },
            { id: 'remote-large', name: 'Remote Large' },
        ],
    },
];

const settings = new MemorySettings({
    strings: {
        'active-provider': 'test-remote',
        'active-model': 'remote-large',
        'provider-default-models': '{"test-remote":"remote-large"}',
    },
    strv: {
        'enabled-providers': ['test-remote'],
    },
});
const store = new ProviderConfigStore(configs, { settings });
const activeSelection = store.getActiveSelection();

if (activeSelection.provider.id !== 'test-remote')
    throw new Error(`Active provider was not loaded from settings: ${activeSelection.provider.id}`);

if (activeSelection.model.id !== 'remote-large')
    throw new Error(`Active model was not loaded from settings: ${activeSelection.model.id}`);

store.setProviderEnabled('test-remote', false);

if (settings.get_strv('enabled-providers').includes('test-remote'))
    throw new Error('Disabled provider was not persisted');

if (store.getActiveSelection().provider !== null)
    throw new Error('Provider store should allow no active provider');

store.setDefaultModel('test-remote', 'remote-small');

if (!settings.get_string('provider-default-models').includes('"test-remote":"remote-small"'))
    throw new Error('Provider default model was not persisted');

store.setActiveSelection('test-remote', 'remote-small');

if (settings.get_string('active-provider') !== 'test-remote' || settings.get_string('active-model') !== 'remote-small')
    throw new Error('Active selection was not persisted');

const defaultStore = new ProviderConfigStore(undefined, {
    settings: null,
    apiKeyStore: new MemoryApiKeyStore({ zai: 'zai-key' }),
    envLookup: () => '',
});
const builtInModelsMissingContext = defaultStore.listProviders()
    .filter((provider) => !provider.customizable)
    .flatMap((provider) => provider.models
        .filter((model) => !Number.isFinite(model.contextWindowTokens) || model.contextWindowTokens <= 0)
        .map((model) => `${provider.id}/${model.id}`));

if (builtInModelsMissingContext.length > 0)
    throw new Error(`Built-in chat models are missing context windows: ${builtInModelsMissingContext.join(', ')}`);

if (defaultStore.getDefaultModel('openai').id !== 'gpt-5.6-sol')
    throw new Error('OpenAI default GPT-5.6 Sol model was not configured');

const openAiModelIds = defaultStore.getProvider('openai').models.map((model) => model.id);
const expectedOpenAiGpt56ModelIds = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

if (!expectedOpenAiGpt56ModelIds.every((modelId) => openAiModelIds.includes(modelId)))
    throw new Error(`OpenAI GPT-5.6 model family was not configured: ${openAiModelIds.join(', ')}`);

if (defaultStore.resolve('openai', 'gpt-5.6').model.id !== 'gpt-5.6-sol')
    throw new Error('OpenAI GPT-5.6 alias should resolve to GPT-5.6 Sol');

if (defaultStore.resolve('openai', 'gpt-5.6-terra').model.contextWindowTokens !== 1050000)
    throw new Error('OpenAI GPT-5.6 context window should be 1.05M tokens');

if (defaultStore.getThinkingLevels('openai', 'gpt-5.6-sol').join(',') !== 'off,auto,low,medium,high,xhigh,max')
    throw new Error('OpenAI GPT-5.6 should expose all supported reasoning efforts');

if (defaultStore.getThinkingLevels('openai', 'gpt-5.5').join(',') !== 'off,auto,low,medium,high')
    throw new Error('OpenAI GPT-5.5 should keep the baseline OpenAI reasoning efforts');

if (defaultStore.resolve('openai', 'gpt-5.4-mini').model.contextWindowTokens !== 400000)
    throw new Error('OpenAI GPT-5.4 mini context window should be 400K tokens');

if (defaultStore.resolve('anthropic', 'claude-haiku-4-5-20251001').model.id !== 'claude-haiku-4-5'
    || defaultStore.resolve('anthropic', 'claude-haiku-4-5').model.contextWindowTokens !== 200000) {
    throw new Error('Claude Haiku 4.5 context window should be 200K tokens');
}

const anthropicProvider = defaultStore.getProvider('anthropic');
const expectedAnthropicModelIds = [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
];

if (anthropicProvider.models.map((model) => model.id).join(',') !== expectedAnthropicModelIds.join(','))
    throw new Error(`Anthropic model list was not limited to current models: ${anthropicProvider.models.map((model) => model.id).join(', ')}`);

if (defaultStore.getDefaultModel('anthropic').id !== 'claude-sonnet-5')
    throw new Error('Claude Sonnet 5 should be the default Anthropic model');

if (defaultStore.getThinkingLevels('anthropic', 'claude-fable-5').join(',') !== 'low,medium,high,xhigh,max')
    throw new Error('Claude Fable 5 should expose always-on adaptive thinking efforts');

for (const modelId of ['claude-opus-4-8', 'claude-sonnet-5']) {
    if (defaultStore.getThinkingLevels('anthropic', modelId).join(',') !== 'off,low,medium,high,xhigh,max')
        throw new Error(`${modelId} should expose adaptive thinking and every supported effort`);

    if (defaultStore.getDefaultThinkingLevel('anthropic', modelId) !== 'high')
        throw new Error(`${modelId} should default to the documented high effort`);
}

if (defaultStore.getThinkingLevels('anthropic', 'claude-haiku-4-5').join(',') !== 'off,auto,low,medium,high')
    throw new Error('Claude Haiku 4.5 should keep manual extended-thinking budgets');

const staleAnthropicSettings = new MemorySettings({
    strings: {
        'provider-default-models': '{"anthropic":"claude-sonnet-4-6"}',
        'provider-discovered-models': '{"anthropic":[{"id":"claude-opus-4-8"},{"id":"claude-sonnet-4-6"},{"id":"claude-haiku-4-5-20251001"}]}',
    },
});
const staleAnthropicStore = new ProviderConfigStore(undefined, {
    settings: staleAnthropicSettings,
    apiKeyStore: new MemoryApiKeyStore({ anthropic: 'anthropic-key' }),
    envLookup: () => '',
});

if (staleAnthropicStore.getProvider('anthropic').models.map((model) => model.id).join(',') !== expectedAnthropicModelIds.join(','))
    throw new Error('Stale Anthropic settings did not migrate to the current four-model catalog');

if (staleAnthropicStore.getDefaultModel('anthropic').id !== 'claude-sonnet-5')
    throw new Error('Stale Anthropic default should fall back to Claude Sonnet 5');

if (defaultStore.resolve('gemini', 'gemini-3.6-flash').model.contextWindowTokens !== 1048576)
    throw new Error('Gemini 3.6 Flash context window should match the documented input token limit');

if (defaultStore.resolve('gemini', 'gemini-3.5-flash-lite').model.contextWindowTokens !== 1048576)
    throw new Error('Gemini 3.5 Flash-Lite context window should match the documented input token limit');

if (defaultStore.resolve('grok', 'grok-4.3').model.contextWindowTokens !== 1000000)
    throw new Error('Grok 4.3 context window should be 1M tokens');

const expectedNativeSearchTools = {
    openai: 'web_search',
    anthropic: 'web_search',
    gemini: 'google_search,url_context',
    grok: 'web_search,x_search',
    zai: 'web_search',
};

for (const [providerId, expectedTools] of Object.entries(expectedNativeSearchTools)) {
    const actualTools = defaultStore.getNativeSearchTools(providerId).join(',');

    if (actualTools !== expectedTools)
        throw new Error(`${providerId} native search tools were wrong: ${actualTools}`);
}

for (const providerId of ['kimi', 'deepseek']) {
    if (defaultStore.getNativeSearchTools(providerId).length > 0)
        throw new Error(`${providerId} should use the Brave Search fallback`);
}

if (defaultStore.listProviders().some((provider) => provider.customizable))
    throw new Error('An empty custom provider placeholder should not appear before the user adds one');

if (defaultStore.getProvider('grok').apiFormat !== 'openai-responses')
    throw new Error('Grok should use the Responses API for native Web and X search');

defaultStore.setWebSearchApiKey('brave-test-key');

if (defaultStore.getWebSearchApiKeyStatus().source !== 'secret'
    || defaultStore.createWebSearchFallbackConfig().apiKey !== 'brave-test-key') {
    throw new Error('Brave Search fallback credentials were not stored in Secret Service');
}

defaultStore.clearWebSearchApiKey();

if (defaultStore.getThinkingLevels('grok', 'grok-4.5').join(',') !== 'low,medium,high')
    throw new Error('Grok 4.5 should expose low/medium/high reasoning levels');

if (defaultStore.getDefaultThinkingLevel('grok', 'grok-4.5') !== 'high')
    throw new Error('Grok 4.5 should default to high reasoning');

if (defaultStore.getThinkingLevels('grok', 'grok-4.3').join(',') !== 'off,low,medium,high')
    throw new Error('Grok 4.3 should expose off/low/medium/high reasoning levels');

const discoveredContextStore = new ProviderConfigStore(undefined, {
    settings: new MemorySettings({
        strings: {
            'provider-discovered-models': '{"openai":[{"id":"gpt-5.6"},{"id":"gpt-5.4-mini"}],"grok":[{"id":"grok-4.3"}]}',
        },
    }),
    apiKeyStore: new MemoryApiKeyStore(),
    envLookup: () => '',
});

if (discoveredContextStore.resolve('openai', 'gpt-5.6').model.id !== 'gpt-5.6-sol')
    throw new Error('Discovered OpenAI GPT-5.6 alias should be normalized to GPT-5.6 Sol');

if (discoveredContextStore.getThinkingLevels('openai', 'gpt-5.6-sol').join(',') !== 'off,auto,low,medium,high,xhigh,max')
    throw new Error('Discovered OpenAI GPT-5.6 models should be enriched with reasoning support');

if (discoveredContextStore.resolve('openai', 'gpt-5.4-mini').model.contextWindowTokens !== 400000)
    throw new Error('Discovered OpenAI models should be enriched with known context windows');

if (discoveredContextStore.resolve('grok', 'grok-4.3').model.contextWindowTokens !== 1000000)
    throw new Error('Discovered Grok models should be enriched with known context windows');

if (discoveredContextStore.getThinkingLevels('grok', 'grok-4.3').join(',') !== 'off,low,medium,high')
    throw new Error('Discovered Grok models should be enriched with reasoning support');

const zaiProvider = defaultStore.getProvider('zai');

if (zaiProvider.baseUrl !== 'https://api.z.ai/api/paas/v4' || zaiProvider.chatPath !== '/chat/completions')
    throw new Error('Z.ai API endpoint was not configured');

if (defaultStore.getDefaultModel('zai').id !== 'glm-5.2')
    throw new Error('Z.ai default GLM model was not configured');

const zaiModelIds = zaiProvider.models.map((model) => model.id);
const zaiImageModelIds = zaiProvider.imageModels.map((model) => model.id);

if (zaiModelIds.join(',') !== 'glm-5.2,glm-5-turbo')
    throw new Error(`Z.ai model list was not limited to supported GLM models: ${zaiModelIds.join(', ')}`);

if (zaiImageModelIds.join(',') !== 'glm-image')
    throw new Error(`Z.ai image model list should only include GLM-Image: ${zaiImageModelIds.join(', ')}`);

if (defaultStore.getDefaultImageModel('zai').id !== 'glm-image')
    throw new Error('Z.ai default image model should be GLM-Image');

if (defaultStore.getImageGenerationSelection().provider.id !== 'openai')
    throw new Error('Default image generation provider should fall back to OpenAI');

if (defaultStore.getThinkingLevels('zai', 'glm-5.2').join(',') !== 'off,auto,high,max')
    throw new Error('Z.ai GLM-5.2 should expose thinking effort controls');

if (defaultStore.getThinkingLevels('zai', 'glm-5-turbo').join(',') !== 'off,auto')
    throw new Error('Z.ai GLM-5 Turbo should expose thinking on/off modes');

const staleZaiSettings = new MemorySettings({
    strings: {
        'active-provider': 'zai',
        'active-model': 'glm5.2',
        'provider-default-models': '{"zai":"glm5-turbo"}',
        'provider-discovered-models': '{"zai":[{"id":"glm-4.5-flash"},{"id":"glm5.2"},{"id":"glm-5.1"},{"id":"glm-5-turbo"}]}',
    },
    strv: {
        'enabled-providers': ['zai'],
    },
});
const staleZaiStore = new ProviderConfigStore(undefined, {
    settings: staleZaiSettings,
    apiKeyStore: new MemoryApiKeyStore({ zai: 'zai-key' }),
    envLookup: () => '',
});
const staleZaiModelIds = staleZaiStore.getProvider('zai').models.map((model) => model.id);

if (staleZaiStore.getProvider('zai').defaultModelId !== 'glm-5-turbo')
    throw new Error('Stale Z.ai default model id was not migrated');

if (staleZaiStore.getActiveSelection().model.id !== 'glm-5.2')
    throw new Error('Stale Z.ai active model id was not migrated');

if (staleZaiModelIds.join(',') !== 'glm-5.2,glm-5-turbo')
    throw new Error(`Unsupported Z.ai models were loaded from persisted settings: ${staleZaiModelIds.join(', ')}`);

const staleZaiImageSettings = new MemorySettings({
    strings: {
        'provider-default-image-models': '{"zai":"cogview-4-250304"}',
        'provider-discovered-image-models': '{"zai":[{"id":"cogview-4-250304"},{"id":"glm-image"}]}',
        'provider-custom-image-models': '{"zai":[{"id":"cogview-4-250304"}]}',
    },
});
const staleZaiImageStore = new ProviderConfigStore(undefined, {
    settings: staleZaiImageSettings,
    apiKeyStore: new MemoryApiKeyStore({ zai: 'zai-key' }),
    envLookup: () => '',
});
const staleZaiImageModelIds = staleZaiImageStore.getProvider('zai').imageModels.map((model) => model.id);

if (staleZaiImageModelIds.join(',') !== 'glm-image')
    throw new Error(`Unsupported Z.ai image model was loaded: ${staleZaiImageModelIds.join(', ')}`);

const geminiProvider = defaultStore.getProvider('gemini');
const expectedGeminiModelIds = [
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
];

if (geminiProvider.models.some((model) => model.id === 'gemini-3.1-pro'))
    throw new Error('Gemini model list still contains stale gemini-3.1-pro id');

if (!geminiProvider.models.some((model) => model.id === 'gemini-3.1-pro-preview'))
    throw new Error('Gemini 3.1 Pro preview model was not configured');

if (geminiProvider.models.map((model) => model.id).join(',') !== expectedGeminiModelIds.join(','))
    throw new Error(`Gemini model list should only include supported Gemini 3 models: ${geminiProvider.models.map((model) => model.id).join(', ')}`);

const geminiImageModelIds = geminiProvider.imageModels.map((model) => model.id);
const expectedGeminiImageModelIds = ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'];

if (geminiImageModelIds.join(',') !== expectedGeminiImageModelIds.join(','))
    throw new Error(`Gemini image model list should only include supported Gemini image models: ${geminiImageModelIds.join(', ')}`);

if (defaultStore.getDefaultImageModel('gemini').id !== 'gemini-3.1-flash-image')
    throw new Error('Gemini default image model should be Gemini 3.1 Flash Image');

defaultStore.setDefaultImageSelection('gemini', 'gemini-3-pro-image');

if (defaultStore.getImageGenerationSelection().provider.id !== 'gemini'
    || defaultStore.getImageGenerationSelection().model.id !== 'gemini-3-pro-image') {
    throw new Error('Standalone image generation selection was not updated');
}

if (!defaultStore.getThinkingLevels('gemini', 'gemini-3.6-flash').includes('minimal'))
    throw new Error('Gemini 3.6 Flash minimal thinking level was not configured');

if (!defaultStore.getThinkingLevels('gemini', 'gemini-3.5-flash-lite').includes('minimal'))
    throw new Error('Gemini 3.5 Flash-Lite minimal thinking level was not configured');

if (defaultStore.getThinkingLevels('gemini', 'gemini-3.1-pro-preview').includes('minimal'))
    throw new Error('Gemini 3.1 Pro should not expose minimal thinking');

const staleGeminiSettings = new MemorySettings({
    strings: {
        'active-provider': 'gemini',
        'active-model': 'gemini-3.1-pro',
        'provider-default-models': '{"gemini":"gemini-3.1-pro"}',
        'provider-discovered-models': '{"gemini":[{"id":"gemini-3.1-pro","name":"Gemini 3.1 Pro"},{"id":"gemini-2.5-flash","name":"Gemini 2.5 Flash"}]}',
    },
    strv: {
        'enabled-providers': ['gemini'],
    },
});
const staleGeminiStore = new ProviderConfigStore(undefined, {
    settings: staleGeminiSettings,
    apiKeyStore: new MemoryApiKeyStore({ gemini: 'gemini-key' }),
    envLookup: () => '',
});

if (staleGeminiStore.getDefaultModel('gemini').id !== 'gemini-3.1-pro-preview')
    throw new Error('Stale Gemini default model id was not migrated');

if (staleGeminiStore.getActiveSelection().model.id !== 'gemini-3.1-pro-preview')
    throw new Error('Stale Gemini active model id was not migrated');

if (staleGeminiStore.getProvider('gemini').models.some((model) => model.id.startsWith('gemini-2.')))
    throw new Error('Unsupported Gemini 2.x model was loaded from persisted settings');

const retiredGeminiFlashSettings = new MemorySettings({
    strings: {
        'active-provider': 'gemini',
        'active-model': 'gemini-3.5-flash',
        'provider-default-models': '{"gemini":"gemini-3.5-flash"}',
    },
    strv: {
        'enabled-providers': ['gemini'],
    },
});
const retiredGeminiFlashStore = new ProviderConfigStore(undefined, {
    settings: retiredGeminiFlashSettings,
    apiKeyStore: new MemoryApiKeyStore({ gemini: 'gemini-key' }),
    envLookup: () => '',
});

if (retiredGeminiFlashStore.getDefaultModel('gemini').id !== 'gemini-3.6-flash')
    throw new Error('Retired Gemini 3.5 Flash default was not migrated to Gemini 3.6 Flash');

if (retiredGeminiFlashStore.getActiveSelection().model.id !== 'gemini-3.6-flash')
    throw new Error('Retired Gemini 3.5 Flash selection was not migrated to Gemini 3.6 Flash');

const staleGeminiImageSettings = new MemorySettings({
    strings: {
        'provider-default-image-models': '{"gemini":"gemini-2.5-flash-image"}',
        'provider-discovered-image-models': '{"gemini":[{"id":"gemini-2.5-flash-image"},{"id":"gemini-3-pro-image"}]}',
        'provider-custom-image-models': '{"gemini":[{"id":"gemini-2.5-flash-image"}]}',
    },
});
const staleGeminiImageStore = new ProviderConfigStore(undefined, {
    settings: staleGeminiImageSettings,
    apiKeyStore: new MemoryApiKeyStore({ gemini: 'gemini-key' }),
    envLookup: () => '',
});
const staleGeminiImageModelIds = staleGeminiImageStore.getProvider('gemini').imageModels.map((model) => model.id);

if (staleGeminiImageModelIds.includes('gemini-2.5-flash-image'))
    throw new Error('Unsupported Gemini 2.5 image model was loaded from persisted settings');

if (staleGeminiImageStore.getDefaultImageModel('gemini').id !== 'gemini-3-pro-image')
    throw new Error('Stale Gemini image default should fall back to supported discovered image model');

const kimiProvider = defaultStore.getProvider('kimi');
const kimiModelIds = kimiProvider.models.map((model) => model.id);
const expectedKimiModelIds = ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'];

if (defaultStore.getDefaultModel('kimi').id !== 'kimi-k3')
    throw new Error('Kimi default model should be Kimi K3');

if (kimiModelIds.join(',') !== expectedKimiModelIds.join(','))
    throw new Error(`Kimi model list was not limited to supported models: ${kimiModelIds.join(', ')}`);

if (!kimiProvider.models.every((model) => model.description.includes('Context')))
    throw new Error('Kimi model details should include context length descriptions');

if (defaultStore.resolve('kimi', 'kimi-k3').model.contextWindowTokens !== 1000000)
    throw new Error('Kimi K3 metadata should include its 1M context window');

if (kimiProvider.models.filter((model) => model.id !== 'kimi-k3').some((model) => model.contextWindowTokens !== 256000))
    throw new Error('Kimi K2 model metadata should retain 256K context windows');

if (defaultStore.getThinkingLevels('kimi', 'kimi-k3').join(',') !== 'max'
    || defaultStore.getDefaultThinkingLevel('kimi', 'kimi-k3') !== 'max') {
    throw new Error('Kimi K3 should expose only its always-on Max thinking effort');
}

if (defaultStore.getThinkingLevels('kimi', 'kimi-k2.7-code').join(',') !== 'auto')
    throw new Error('Kimi K2.7 Code should expose always-on thinking');

if (defaultStore.getThinkingLevels('kimi', 'kimi-k2.6').join(',') !== 'off,auto')
    throw new Error('Kimi K2.6 should expose thinking on/off modes');

const kimiEndpointSettings = new MemorySettings({
    strings: {
        'provider-endpoint-presets': '{"kimi":"cn"}',
    },
});
const kimiEndpointStore = new ProviderConfigStore(undefined, {
    settings: kimiEndpointSettings,
    apiKeyStore: new MemoryApiKeyStore({ kimi: 'kimi-key' }),
    envLookup: () => '',
});

if (kimiEndpointStore.getProvider('kimi').baseUrl !== 'https://api.moonshot.cn/v1')
    throw new Error('Kimi CN endpoint preset was not loaded');

kimiEndpointStore.setProviderCustomEndpoint('kimi', 'https://gateway.example/v1/');

if (kimiEndpointStore.getProvider('kimi').baseUrl !== 'https://gateway.example/v1'
    || !kimiEndpointStore.getProvider('kimi').usesCustomEndpoint
    || !kimiEndpointSettings.get_string('provider-custom-endpoints').includes('https://gateway.example/v1')) {
    throw new Error('Kimi custom endpoint was not normalized and persisted');
}

const reloadedKimiEndpointStore = new ProviderConfigStore(undefined, {
    settings: kimiEndpointSettings,
    apiKeyStore: new MemoryApiKeyStore({ kimi: 'kimi-key' }),
    envLookup: () => '',
});

if (reloadedKimiEndpointStore.getProvider('kimi').baseUrl !== 'https://gateway.example/v1'
    || !reloadedKimiEndpointStore.getProvider('kimi').usesCustomEndpoint) {
    throw new Error('Kimi custom endpoint was not restored');
}

reloadedKimiEndpointStore.setProviderEndpointPreset('kimi', 'cn');

if (reloadedKimiEndpointStore.getProvider('kimi').baseUrl !== 'https://api.moonshot.cn/v1'
    || reloadedKimiEndpointStore.getProvider('kimi').usesCustomEndpoint
    || kimiEndpointSettings.get_string('provider-custom-endpoints') !== '{}'
    || !kimiEndpointSettings.get_string('provider-endpoint-presets').includes('"kimi":"cn"')) {
    throw new Error('Kimi CN endpoint preset did not replace the custom endpoint');
}

reloadedKimiEndpointStore.setProviderCustomEndpoint('kimi', 'https://api.moonshot.ai/v1/');

if (reloadedKimiEndpointStore.getProvider('kimi').usesCustomEndpoint
    || reloadedKimiEndpointStore.getProvider('kimi').endpointPresetId !== 'global') {
    throw new Error('Kimi global official endpoint was incorrectly treated as custom');
}

reloadedKimiEndpointStore.setProviderCustomEndpoint('kimi', 'https://gateway.example/v1');
reloadedKimiEndpointStore.resetProviderEndpoint('kimi');

if (reloadedKimiEndpointStore.getProvider('kimi').baseUrl !== 'https://api.moonshot.ai/v1'
    || reloadedKimiEndpointStore.getProvider('kimi').usesCustomEndpoint
    || reloadedKimiEndpointStore.getProvider('kimi').endpointPresetId !== 'global') {
    throw new Error('Kimi endpoint reset did not restore the default global endpoint');
}

let rejectedInvalidEndpoint = false;

try {
    reloadedKimiEndpointStore.setProviderCustomEndpoint('kimi', 'ftp://gateway.example/v1');
} catch (error) {
    rejectedInvalidEndpoint = error.message.includes('HTTP or HTTPS');
}

if (!rejectedInvalidEndpoint
    || reloadedKimiEndpointStore.getProvider('kimi').baseUrl !== 'https://api.moonshot.ai/v1') {
    throw new Error('Invalid built-in provider endpoint was not rejected safely');
}

const staleKimiSettings = new MemorySettings({
    strings: {
        'active-provider': 'kimi',
        'active-model': 'kimi-k2.5',
        'provider-default-models': '{"kimi":"kimi-k2.5"}',
        'provider-discovered-models': '{"kimi":[{"id":"kimi-k2.7-code"},{"id":"moonshot-v1-128k"},{"id":"kimi-k2.5"},{"id":"kimi-k2.6"}]}',
    },
    strv: {
        'enabled-providers': ['kimi'],
    },
});
const staleKimiStore = new ProviderConfigStore(undefined, {
    settings: staleKimiSettings,
    apiKeyStore: new MemoryApiKeyStore({ kimi: 'kimi-key' }),
    envLookup: () => '',
});
const staleKimiModelIds = staleKimiStore.getProvider('kimi').models.map((model) => model.id);

if (staleKimiModelIds.some((modelId) => modelId === 'kimi-k2.5' || modelId.startsWith('moonshot-')))
    throw new Error('Unsupported Kimi model was loaded from persisted settings');

if (staleKimiStore.getDefaultModel('kimi').id !== 'kimi-k3')
    throw new Error('Stale Kimi default model should fall back to Kimi K3');

if (staleKimiStore.getThinkingLevels('kimi', 'kimi-k2.6').join(',') !== 'off,auto')
    throw new Error('Persisted Kimi models should be enriched with thinking support');

if (staleKimiStore.resolve('kimi', 'kimi-k3').model.contextWindowTokens !== 1000000)
    throw new Error('Persisted Kimi models should be enriched with Kimi K3 metadata');

const kimiDiscoveryStore = new ProviderConfigStore(undefined, {
    settings: null,
    apiKeyStore: new MemoryApiKeyStore({ kimi: 'kimi-key' }),
    envLookup: () => '',
});

await kimiDiscoveryStore.discoverModels('kimi', {
    discoverer: async () => [
        { id: 'moonshot-v1-8k' },
        { id: 'kimi-k2.7-code-highspeed' },
        { id: 'kimi-k2.5' },
        { id: 'kimi-k2.7-code' },
        { id: 'kimi-k2.6' },
    ],
});

const discoveredKimiModelIds = kimiDiscoveryStore.getProvider('kimi').models.map((model) => model.id);

if (discoveredKimiModelIds.join(',') !== expectedKimiModelIds.join(','))
    throw new Error(`Kimi discovery did not filter unsupported models: ${discoveredKimiModelIds.join(', ')}`);

if (kimiDiscoveryStore.getProvider('kimi').models.some((model) => model.id === 'kimi-k2.7-code-highspeed'))
    throw new Error('Kimi discovery retained the unsupported high-speed model');

if (kimiDiscoveryStore.getThinkingLevels('kimi', 'kimi-k2.7-code').join(',') !== 'auto')
    throw new Error('Kimi discovery did not enrich thinking support');

if (kimiDiscoveryStore.resolve('kimi', 'kimi-k3').model.contextWindowTokens !== 1000000)
    throw new Error('Kimi discovery did not retain built-in Kimi K3 metadata');

if (defaultStore.getThinkingLevels('deepseek', 'deepseek-v4-pro').join(',') !== 'off,auto,high,max')
    throw new Error('DeepSeek V4 Pro should expose thinking on/off modes');

if (defaultStore.getThinkingLevels('deepseek', 'deepseek-v4-flash').join(',') !== 'off,auto,high,max')
    throw new Error('DeepSeek V4 Flash should expose thinking on/off modes');

const staleDeepSeekSettings = new MemorySettings({
    strings: {
        'active-provider': 'deepseek',
        'active-model': 'deepseek-v3',
        'provider-default-models': '{"deepseek":"deepseek-v3"}',
        'provider-discovered-models': '{"deepseek":[{"id":"deepseek-v3"},{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}',
    },
    strv: {
        'enabled-providers': ['deepseek'],
    },
});
const staleDeepSeekStore = new ProviderConfigStore(undefined, {
    settings: staleDeepSeekSettings,
    apiKeyStore: new MemoryApiKeyStore({ deepseek: 'deepseek-key' }),
    envLookup: () => '',
});

if (staleDeepSeekStore.getProvider('deepseek').models.some((model) => model.id === 'deepseek-v3'))
    throw new Error('Unsupported DeepSeek model was loaded from persisted settings');

if (staleDeepSeekStore.getThinkingLevels('deepseek', 'deepseek-v4-pro').join(',') !== 'off,auto,high,max')
    throw new Error('Persisted DeepSeek models should be enriched with thinking support');

try {
    await defaultStore.discoverModels('zai');
    throw new Error('Z.ai model discovery should not be supported');
} catch (error) {
    if (!error.message.includes('does not support model discovery'))
        throw error;
}

await defaultStore.discoverImageModels('zai');

if (defaultStore.getProvider('zai').imageModels.map((model) => model.id).join(',') !== 'glm-image')
    throw new Error('Z.ai image discovery should only return GLM-Image');

const fallbackSettingsPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-provider-settings-${GLib.uuid_string_random()}.json`,
]);

try {
    const fallbackStore = new ProviderConfigStore(configs, { settingsPath: fallbackSettingsPath });

    fallbackStore.setProviderEnabled('test-remote', true);
    fallbackStore.setActiveSelection('test-remote', 'remote-large');

    const reloadedFallbackStore = new ProviderConfigStore(configs, { settingsPath: fallbackSettingsPath });
    const reloadedSelection = reloadedFallbackStore.getActiveSelection();

    if (reloadedSelection.provider.id !== 'test-remote' || reloadedSelection.model.id !== 'remote-large')
        throw new Error(`Fallback active selection was not reloaded: ${reloadedSelection.provider.id}/${reloadedSelection.model?.id}`);
} finally {
    if (GLib.file_test(fallbackSettingsPath, GLib.FileTest.EXISTS))
        GLib.unlink(fallbackSettingsPath);
}

const credentialConfigs = [
    configs[0],
    {
        id: 'secure-remote',
        name: 'Secure Remote',
        description: 'Remote provider with stored credentials.',
        implemented: true,
        enabled: false,
        apiFormat: 'openai-chat-completions',
        apiKeyRequired: true,
        apiKeyConfigured: false,
        apiKeyEnvVar: 'SECURE_REMOTE_API_KEY',
        baseUrl: 'https://example.invalid/v1',
        defaultModelId: 'secure-small',
        models: [
            { id: 'secure-small', name: 'Secure Small' },
        ],
    },
];
const environmentSettings = new MemorySettings();
const environmentCredentialStore = new ProviderConfigStore(credentialConfigs, {
    settings: environmentSettings,
    apiKeyStore: new MemoryApiKeyStore(),
    envLookup: name => name === 'SECURE_REMOTE_API_KEY' ? 'sk-environment' : '',
});

if (environmentCredentialStore.getApiKeyStatus('secure-remote').source !== 'environment')
    throw new Error('Environment API key status was not detected');

if (!environmentCredentialStore.isProviderAvailable('secure-remote'))
    throw new Error('Provider with an environment API key was not enabled automatically');

if (!environmentSettings.get_strv('enabled-providers').includes('secure-remote'))
    throw new Error('Environment-enabled provider was not persisted');

environmentCredentialStore.setProviderEnabled('secure-remote', false);
environmentCredentialStore.refreshApiKeyStatus();

if (environmentCredentialStore.isProviderEnabled('secure-remote'))
    throw new Error('API key status refresh overrode a manual provider disable');

const credentialStore = new ProviderConfigStore(credentialConfigs, {
    settings: null,
    apiKeyStore: new MemoryApiKeyStore(),
    envLookup: () => '',
});

if (credentialStore.canEnableProvider('secure-remote'))
    throw new Error('Provider without credentials should not be enableable');

credentialStore.setApiKey('secure-remote', 'sk-secret');

if (credentialStore.getApiKeyStatus('secure-remote').source !== 'secret')
    throw new Error('Stored API key status did not come from Secret Service store');

credentialStore.setProviderEnabled('secure-remote', true);

if (!credentialStore.isProviderAvailable('secure-remote'))
    throw new Error('Provider with stored credentials was not available');

if (credentialStore.getFallbackSelection('secure-remote').provider.id !== 'test-remote')
    throw new Error('Fallback provider was not selected from enabled providers');

if (credentialStore.createProvider('secure-remote').name !== 'Secure Remote')
    throw new Error('Credential-backed provider was not created');

credentialStore.clearApiKey('secure-remote');

if (credentialStore.isProviderAvailable('secure-remote'))
    throw new Error('Provider stayed available after clearing credentials');

try {
    credentialStore.createProvider('secure-remote');
    throw new Error('Provider without credentials should not be created');
} catch (error) {
    if (!error.message.includes('SECURE_REMOTE_API_KEY') || !error.userMessage?.includes('Configure Secure Remote'))
        throw error;
}

const staleEnabledSettings = new MemorySettings({
    strv: {
        'enabled-providers': ['test-remote', 'secure-remote'],
    },
});
const staleEnabledStore = new ProviderConfigStore(credentialConfigs, {
    settings: staleEnabledSettings,
    apiKeyStore: new MemoryApiKeyStore(),
    envLookup: () => '',
});
const enabledProviderIds = staleEnabledStore
    .listProviders({ enabledOnly: true, usableOnly: false })
    .map((provider) => provider.id);
const availableProviderIds = staleEnabledStore
    .listProviders({ enabledOnly: true })
    .map((provider) => provider.id);

if (!enabledProviderIds.includes('secure-remote'))
    throw new Error('Enabled provider with missing credentials was hidden from enabled provider list');

if (availableProviderIds.includes('secure-remote'))
    throw new Error('Unavailable provider was included in available provider list');

const legacyCustomSettings = new MemorySettings({
    strings: {
        'custom-openai-compatible-base-url': 'https://legacy.example/v1',
    },
    strv: {
        'custom-openai-compatible-models': ['legacy-small', 'legacy-large'],
    },
});
const legacyCustomStore = new ProviderConfigStore(undefined, {
    settings: legacyCustomSettings,
    apiKeyStore: new MemoryApiKeyStore({
        'openai-compatible': 'sk-legacy',
    }),
    envLookup: () => '',
});
const legacyCustomProvider = legacyCustomStore.getProvider('openai-compatible');

if (legacyCustomProvider?.baseUrl !== 'https://legacy.example/v1'
    || legacyCustomProvider.models.length !== 2) {
    throw new Error('Legacy custom provider settings were not migrated into the custom provider list');
}

if (!legacyCustomStore.canEnableProvider('openai-compatible'))
    throw new Error('Migrated custom provider did not retain its legacy Secret Service credential');

if (!legacyCustomSettings.get_string('custom-openai-compatible-providers').includes('legacy.example'))
    throw new Error('Migrated custom provider list was not persisted');

if (legacyCustomSettings.get_string('custom-openai-compatible-base-url')
    || legacyCustomSettings.get_strv('custom-openai-compatible-models').length > 0) {
    throw new Error('Legacy custom provider settings were not cleared after migration');
}

const customSettings = new MemorySettings();
const customApiKeys = new MemoryApiKeyStore();
const customStore = new ProviderConfigStore(undefined, {
    settings: customSettings,
    apiKeyStore: customApiKeys,
    envLookup: () => '',
});
const discoveredProvider = customStore.addCustomProvider({
    name: 'Discovered API',
    baseUrl: 'https://discovered.example/v1',
    apiKey: 'sk-discovered',
});
const manualProvider = customStore.addCustomProvider({
    name: 'Manual API',
    baseUrl: 'https://manual.example/v1',
    models: 'custom-small, custom-large, custom-small',
    apiKey: 'sk-manual',
});

if (discoveredProvider.id === manualProvider.id)
    throw new Error('Custom providers did not receive distinct identifiers');

if (customStore.listProviders().filter((provider) => provider.customizable).length !== 2)
    throw new Error('Multiple custom providers were not added to the provider list');

if (customStore.canEnableProvider(discoveredProvider.id))
    throw new Error('Custom provider should require discovered or manual models before enabling');

await customStore.discoverModels(discoveredProvider.id, {
    discoverer: async (config) => {
        if (config.apiKey !== 'sk-discovered' || config.baseUrl !== 'https://discovered.example/v1')
            throw new Error('Custom provider discovery did not receive its own endpoint and API key');

        return [
            { id: 'discovered-small', name: 'Discovered Small' },
            { id: 'discovered-large', name: 'Discovered Large', contextWindowTokens: 131072 },
        ];
    },
});
customStore.setCustomProviderConfig(discoveredProvider.id, {
    name: 'Discovered API',
    baseUrl: 'https://discovered.example/v1',
    models: 'discovered-small, discovered-large',
});

if (!customStore.canEnableProvider(discoveredProvider.id))
    throw new Error('Custom provider with discovered models should be enableable');

customStore.setProviderEnabled(discoveredProvider.id, true);
customStore.setDefaultModel(discoveredProvider.id, 'discovered-large');

if (customStore.getDefaultModel(discoveredProvider.id).id !== 'discovered-large')
    throw new Error('Discovered custom provider default model was not updated');

if (customStore.createProvider(discoveredProvider.id).name !== 'Discovered API')
    throw new Error('Custom provider client was not created');

customStore.setCustomProviderConfig(manualProvider.id, {
    name: 'Renamed Manual API',
    baseUrl: 'https://manual.example/v1',
    models: 'custom-small, custom-large, custom-small',
});
customStore.setCustomImageModels(manualProvider.id, 'custom-image, custom-image-fast, custom-image');
customStore.setDefaultModel(manualProvider.id, 'custom-large');
customStore.setDefaultImageModel(manualProvider.id, 'custom-image-fast');
customStore.setDefaultImageSelection(manualProvider.id, 'custom-image-fast');

if (customStore.getDefaultImageModel(manualProvider.id).id !== 'custom-image-fast')
    throw new Error('Custom provider default image model was not updated');

if (customSettings.get_string('default-image-provider') !== manualProvider.id
    || customSettings.get_string('default-image-model') !== 'custom-image-fast') {
    throw new Error('Standalone default image generation selection was not persisted');
}

const persistedCustomProviders = customSettings.get_string('custom-openai-compatible-providers');

if (!persistedCustomProviders.includes('Discovered API')
    || !persistedCustomProviders.includes('Renamed Manual API')) {
    throw new Error('Multiple custom provider definitions were not persisted');
}

if (!customSettings.get_string('provider-custom-image-models').includes('custom-image-fast'))
    throw new Error('Custom provider image models were not normalized and persisted');

if (!customSettings.get_string('provider-discovered-models').includes('discovered-large'))
    throw new Error('Discovered models were not persisted');

if (customStore.resolve(discoveredProvider.id, 'discovered-large').model.contextWindowTokens !== 131072)
    throw new Error('Discovered custom model context window was not preserved');

const reloadedCustomStore = new ProviderConfigStore(undefined, {
    settings: customSettings,
    apiKeyStore: customApiKeys,
    envLookup: () => '',
});

if (reloadedCustomStore.listProviders().filter((provider) => provider.customizable).length !== 2)
    throw new Error('Multiple custom providers were not restored from settings');

if (reloadedCustomStore.resolve(discoveredProvider.id, 'discovered-large').model.contextWindowTokens !== 131072)
    throw new Error('Reloaded custom provider lost discovered model metadata');

reloadedCustomStore.removeCustomProvider(manualProvider.id);

if (reloadedCustomStore.getProvider(manualProvider.id))
    throw new Error('Removed custom provider remained in the provider list');

if (customApiKeys.lookup(manualProvider.id))
    throw new Error('Removed custom provider API key remained in Secret Service');

if (customSettings.get_string('custom-openai-compatible-providers').includes(manualProvider.id))
    throw new Error('Removed custom provider remained in persisted settings');

print('Cusco provider config smoke passed');
