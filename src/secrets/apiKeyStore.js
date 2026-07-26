import Secret from 'gi://Secret?version=1';

const API_KEY_SCHEMA = new Secret.Schema(
    'io.github.stonega.Cusco.ProviderApiKey',
    Secret.SchemaFlags.NONE,
    {
        provider: Secret.SchemaAttributeType.STRING,
    },
);

export class SecretServiceApiKeyStore {
    constructor(secretService = Secret) {
        this._secretService = secretService;
        this._cache = new Map();
    }

    lookup(providerId) {
        const normalizedProviderId = String(providerId);

        if (this._cache.has(normalizedProviderId))
            return this._cache.get(normalizedProviderId);

        const apiKey = this._secretService.password_lookup_sync(
            API_KEY_SCHEMA,
            { provider: normalizedProviderId },
            null,
        ) ?? '';

        if (apiKey)
            this._cache.set(normalizedProviderId, apiKey);

        return apiKey;
    }

    store(providerId, providerName, apiKey) {
        const normalizedProviderId = String(providerId);

        return new Promise((resolve, reject) => {
            this._secretService.password_store(
                API_KEY_SCHEMA,
                { provider: normalizedProviderId },
                this._secretService.COLLECTION_DEFAULT,
                `Cusco ${providerName} API key`,
                apiKey,
                null,
                (_source, result) => {
                    try {
                        const stored = this._secretService.password_store_finish(result);

                        if (stored === false) {
                            resolve(false);
                            return;
                        }

                        this._cache.set(normalizedProviderId, apiKey);
                        resolve(true);
                    } catch (error) {
                        reject(error);
                    }
                },
            );
        });
    }

    clear(providerId) {
        const normalizedProviderId = String(providerId);

        return new Promise((resolve, reject) => {
            this._secretService.password_clear(
                API_KEY_SCHEMA,
                { provider: normalizedProviderId },
                null,
                (_source, result) => {
                    try {
                        const cleared = this._secretService.password_clear_finish(result);
                        this._cache.delete(normalizedProviderId);
                        resolve(cleared);
                    } catch (error) {
                        reject(error);
                    }
                },
            );
        });
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
