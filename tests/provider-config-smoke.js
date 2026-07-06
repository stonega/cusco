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

if (geminiProvider.models.some((model) => model.id === 'gemini-3.1-pro'))
    throw new Error('Gemini model list still contains stale gemini-3.1-pro id');

if (!geminiProvider.models.some((model) => model.id === 'gemini-3.1-pro-preview'))
    throw new Error('Gemini 3.1 Pro preview model was not configured');

if (geminiProvider.models.length !== 2 || geminiProvider.models.some((model) => model.id.startsWith('gemini-2.')))
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

if (!defaultStore.getThinkingLevels('gemini', 'gemini-3.5-flash').includes('minimal'))
    throw new Error('Gemini 3.5 Flash minimal thinking level was not configured');

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
const expectedKimiModelIds = ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'];

if (defaultStore.getDefaultModel('kimi').id !== 'kimi-k2.7-code')
    throw new Error('Kimi default model should be Kimi K2.7 Code');

if (kimiModelIds.join(',') !== expectedKimiModelIds.join(','))
    throw new Error(`Kimi model list was not limited to supported models: ${kimiModelIds.join(', ')}`);

if (!kimiProvider.models.every((model) => model.description.includes('Context 256k')))
    throw new Error('Kimi model details should include context length descriptions');

if (defaultStore.getThinkingLevels('kimi', 'kimi-k2.7-code').join(',') !== 'auto')
    throw new Error('Kimi K2.7 Code should expose always-on thinking');

if (defaultStore.getThinkingLevels('kimi', 'kimi-k2.6').join(',') !== 'off,auto')
    throw new Error('Kimi K2.6 should expose thinking on/off modes');

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

if (staleKimiStore.getDefaultModel('kimi').id !== 'kimi-k2.7-code')
    throw new Error('Stale Kimi default model should fall back to supported Kimi K2.7 Code');

if (staleKimiStore.getThinkingLevels('kimi', 'kimi-k2.6').join(',') !== 'off,auto')
    throw new Error('Persisted Kimi models should be enriched with thinking support');

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

if (!kimiDiscoveryStore.getProvider('kimi').models[1].description.includes('180 tokens/s'))
    throw new Error('Kimi discovery did not enrich model details');

if (kimiDiscoveryStore.getThinkingLevels('kimi', 'kimi-k2.7-code').join(',') !== 'auto')
    throw new Error('Kimi discovery did not enrich thinking support');

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

const customSettings = new MemorySettings();
const customStore = new ProviderConfigStore(undefined, {
    settings: customSettings,
    apiKeyStore: new MemoryApiKeyStore({
        'openai-compatible': 'sk-custom',
    }),
    envLookup: () => '',
});

if (customStore.canEnableProvider('openai-compatible'))
    throw new Error('Custom provider should require endpoint and models before enabling');

customStore.setCustomProviderConfig('openai-compatible', {
    baseUrl: 'https://custom.example/v1',
    models: 'custom-small, custom-large, custom-small',
});
customStore.setCustomImageModels('openai-compatible', 'custom-image, custom-image-fast, custom-image');

if (customSettings.get_string('custom-openai-compatible-base-url') !== 'https://custom.example/v1')
    throw new Error('Custom provider endpoint was not persisted');

if (customSettings.get_strv('custom-openai-compatible-models').length !== 2)
    throw new Error('Custom provider models were not normalized and persisted');

if (!customSettings.get_string('provider-custom-image-models').includes('custom-image-fast'))
    throw new Error('Custom provider image models were not normalized and persisted');

if (!customStore.canEnableProvider('openai-compatible'))
    throw new Error('Configured custom provider should be enableable');

customStore.setProviderEnabled('openai-compatible', true);
customStore.setDefaultModel('openai-compatible', 'custom-large');

if (customStore.getDefaultModel('openai-compatible').id !== 'custom-large')
    throw new Error('Custom provider default model was not updated');

customStore.setDefaultImageModel('openai-compatible', 'custom-image-fast');
customStore.setDefaultImageSelection('openai-compatible', 'custom-image-fast');

if (customStore.getDefaultImageModel('openai-compatible').id !== 'custom-image-fast')
    throw new Error('Custom provider default image model was not updated');

if (customSettings.get_string('default-image-provider') !== 'openai-compatible'
    || customSettings.get_string('default-image-model') !== 'custom-image-fast') {
    throw new Error('Standalone default image generation selection was not persisted');
}

if (customStore.createProvider('openai-compatible').name !== 'Custom API')
    throw new Error('Custom provider client was not created');

await customStore.discoverModels('openai-compatible', {
    discoverer: async () => [
        { id: 'discovered-small', name: 'Discovered Small' },
        { id: 'discovered-large', name: 'Discovered Large' },
    ],
});

if (customStore.getDefaultModel('openai-compatible').id !== 'discovered-small')
    throw new Error('Discovered models did not replace custom provider defaults');

if (!customSettings.get_string('provider-discovered-models').includes('discovered-large'))
    throw new Error('Discovered models were not persisted');

print('Cusco provider config smoke passed');
