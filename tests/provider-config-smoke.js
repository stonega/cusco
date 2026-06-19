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
        id: 'mock',
        name: 'Mock Provider',
        description: 'Local provider.',
        implemented: true,
        enabled: true,
        apiKeyRequired: false,
        apiKeyConfigured: false,
        defaultModelId: 'mock-balanced',
        models: [
            { id: 'mock-balanced', name: 'Mock Balanced' },
            { id: 'mock-fast', name: 'Mock Fast' },
        ],
    },
    {
        id: 'test-remote',
        name: 'Test Remote',
        description: 'Remote provider with no credentials for tests.',
        implemented: true,
        enabled: false,
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
        'enabled-providers': ['mock', 'test-remote'],
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

store.setDefaultModel('mock', 'mock-fast');

if (!settings.get_string('provider-default-models').includes('"mock":"mock-fast"'))
    throw new Error('Provider default model was not persisted');

store.setActiveSelection('mock', 'mock-fast');

if (settings.get_string('active-provider') !== 'mock' || settings.get_string('active-model') !== 'mock-fast')
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

try {
    await defaultStore.discoverModels('zai');
    throw new Error('Z.ai model discovery should not be supported');
} catch (error) {
    if (!error.message.includes('does not support model discovery'))
        throw error;
}

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

const credentialStore = new ProviderConfigStore([
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
], {
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

if (credentialStore.getFallbackSelection('secure-remote').provider.id !== 'mock')
    throw new Error('Fallback provider was not selected from enabled providers');

if (credentialStore.createProvider('secure-remote').name !== 'Secure Remote')
    throw new Error('Credential-backed provider was not created');

credentialStore.clearApiKey('secure-remote');

if (credentialStore.isProviderAvailable('secure-remote'))
    throw new Error('Provider stayed available after clearing credentials');

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

if (customSettings.get_string('custom-openai-compatible-base-url') !== 'https://custom.example/v1')
    throw new Error('Custom provider endpoint was not persisted');

if (customSettings.get_strv('custom-openai-compatible-models').length !== 2)
    throw new Error('Custom provider models were not normalized and persisted');

if (!customStore.canEnableProvider('openai-compatible'))
    throw new Error('Configured custom provider should be enableable');

customStore.setProviderEnabled('openai-compatible', true);
customStore.setDefaultModel('openai-compatible', 'custom-large');

if (customStore.getDefaultModel('openai-compatible').id !== 'custom-large')
    throw new Error('Custom provider default model was not updated');

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
