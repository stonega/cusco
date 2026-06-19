import Secret from 'gi://Secret?version=1';

const API_KEY_SCHEMA = new Secret.Schema(
    'io.github.stonega.Cusco.ProviderApiKey',
    Secret.SchemaFlags.NONE,
    {
        provider: Secret.SchemaAttributeType.STRING,
    },
);

export class SecretServiceApiKeyStore {
    lookup(providerId) {
        return Secret.password_lookup_sync(API_KEY_SCHEMA, { provider: providerId }, null) ?? '';
    }

    store(providerId, providerName, apiKey) {
        return Secret.password_store_sync(
            API_KEY_SCHEMA,
            { provider: providerId },
            Secret.COLLECTION_DEFAULT,
            `Cusco ${providerName} API key`,
            apiKey,
            null,
        );
    }

    clear(providerId) {
        return Secret.password_clear_sync(API_KEY_SCHEMA, { provider: providerId }, null);
    }
}

export class MemoryApiKeyStore {
    constructor(values = {}) {
        this._values = new Map(Object.entries(values));
    }

    lookup(providerId) {
        return this._values.get(providerId) ?? '';
    }

    store(providerId, _providerName, apiKey) {
        this._values.set(providerId, apiKey);
        return true;
    }

    clear(providerId) {
        this._values.delete(providerId);
        return true;
    }
}

export function createDefaultApiKeyStore() {
    return new SecretServiceApiKeyStore();
}
