import { clone, deepFreeze, mergeMetadata, validateCatalog } from './validation.js';

export class CatalogSnapshot {
    constructor(data, schema, options = {}) {
        this.data = validateCatalog(data, schema, options);
        this.revision = this.data.revision;
        Object.freeze(this);
    }

    getProvider(id) {
        return this.data.providers.find(provider => provider.id === id) ?? null;
    }

    normalizeId(providerId, modelId, image = false) {
        const id = String(modelId ?? '').trim();
        const provider = this.getProvider(providerId);
        const aliases = (image ? provider?.imageAliases : provider?.aliases) ?? {};
        const models = (image ? provider?.imageModels : provider?.models) ?? [];
        return aliases[id] ?? models.find(model => model.id === id)?.replacementId ?? id;
    }

    isSupported(providerId, modelId, { image = false, custom = false } = {}) {
        const provider = this.getProvider(providerId);
        if (!provider)
            return true;
        const id = this.normalizeId(providerId, modelId, image);
        const models = image ? provider.imageModels : provider.models;
        const excluded = image ? provider.discovery.excludedImageModelIds : provider.discovery.excludedModelIds;
        if (excluded.includes(id) || models.some(model => model.id === id && model.status === 'retired'))
            return false;
        return custom || provider.discovery[image ? 'image' : 'chat'] === 'open'
            || models.some(model => model.id === id);
    }

    getModel(providerId, modelId, image = false) {
        const provider = this.getProvider(providerId);
        const id = this.normalizeId(providerId, modelId, image);
        const model = (image ? provider?.imageModels : provider?.models)?.find(item => item.id === id);
        if (!model || model.status === 'retired')
            return null;
        return deepFreeze(mergeMetadata(image ? provider.imageModelDefaults : provider.modelDefaults, model));
    }

    listModels(providerId, image = false) {
        const provider = this.getProvider(providerId);
        return ((image ? provider?.imageModels : provider?.models) ?? [])
            .filter(model => model.status !== 'retired')
            .map(model => this.getModel(providerId, model.id, image));
    }

    providerDefaults(providerId) {
        const provider = this.getProvider(providerId);
        if (!provider)
            return {};
        return {
            ...clone(provider.modelDefaults),
            defaultModelId: provider.defaultModelId,
            defaultImageModelId: provider.defaultImageModelId ?? '',
            models: this.listModels(providerId).map(clone),
            imageModels: this.listModels(providerId, true).map(clone),
        };
    }
}
