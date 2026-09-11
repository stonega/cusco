// Deliberately bounded JSON Schema vocabulary, shared by the app and CI.
// The schema is bundled application code; a downloaded catalog cannot replace it.
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const THINKING_APIS = {
    openai: ['openai-responses'],
    anthropic: ['anthropic-adaptive', 'anthropic-budget'],
    gemini: ['gemini-thinking-level'],
    kimi: ['kimi-thinking', 'kimi-k3-reasoning'],
    deepseek: ['openai-responses', 'deepseek-thinking'],
    grok: ['xai-reasoning'],
    zai: ['zai-thinking'],
};
// These adapters map a limited vocabulary instead of passing effort through.
// Reject levels they would silently omit or treat as an unrelated mode.
const MAPPED_THINKING_LEVELS = {
    'openai-responses': ['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    'kimi-thinking': ['off', 'auto'],
    'deepseek-thinking': ['off', 'auto', 'high', 'max'],
    'zai-thinking': ['off', 'auto', 'low', 'high', 'max'],
};
const SEARCH_APIS = {
    openai: 'openai-responses', anthropic: 'anthropic-messages',
    gemini: 'gemini-generate-content', deepseek: 'openai-responses',
    grok: 'openai-responses', zai: 'zai-chat-completions',
};
const SEARCH_TOOLS = {
    openai: ['web_search'], anthropic: ['web_search'], gemini: ['google_search', 'url_context'],
    deepseek: ['web_search'], grok: ['web_search', 'x_search'], zai: ['web_search'],
};
const PARAMETER_TYPES = {
    temperature: ['number'], topP: ['number'], topK: ['integer', 'number'], stop: ['array'],
    seed: ['integer', 'number'], frequencyPenalty: ['number'], presencePenalty: ['number'],
    parallelToolCalls: ['boolean'], toolChoice: ['string'], responseFormat: ['object'],
    size: ['string'], quality: ['string'], outputFormat: ['string'], background: ['string'],
};

export function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function fail(path, message) {
    throw new Error(`Invalid model catalog at ${path}: ${message}`);
}

function typeMatches(value, type) {
    if (type === 'object')
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'array')
        return Array.isArray(value);
    if (type === 'integer')
        return Number.isSafeInteger(value);
    if (type === 'number')
        return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
}

export function validateSchema(value, rule, root = rule, path = '$', depth = 0) {
    if (depth > 32)
        fail(path, 'nesting exceeds 32 levels');
    if (rule.$ref)
        return validateSchema(value, root.$defs[rule.$ref.replace('#/$defs/', '')], root, path, depth + 1);
    if (rule.anyOf) {
        for (const option of rule.anyOf) {
            try {
                validateSchema(value, option, root, path, depth + 1);
                return;
            } catch (_) { /* Try the next declared alternative. */ }
        }
        fail(path, 'does not match an allowed form');
    }
    if ('const' in rule && value !== rule.const)
        fail(path, `expected ${JSON.stringify(rule.const)}`);
    if (rule.enum && !rule.enum.some(item => canonicalJson(item) === canonicalJson(value)))
        fail(path, 'unsupported value');
    if (rule.type && !typeMatches(value, rule.type))
        fail(path, `expected ${rule.type}`);
    if (typeof value === 'string') {
        if (value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? 8192))
            fail(path, 'invalid string length');
        if (rule.pattern && !new RegExp(rule.pattern).test(value))
            fail(path, 'invalid string format');
    }
    if (typeof value === 'number' && (!Number.isFinite(value)
        || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity)))
        fail(path, 'number outside allowed range');
    if (Array.isArray(value)) {
        if (value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? 1000))
            fail(path, 'invalid array size');
        if (rule.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length)
            fail(path, 'duplicate array entries');
        value.forEach((item, index) => validateSchema(item, rule.items ?? {}, root, `${path}[${index}]`, depth + 1));
    } else if (value && typeof value === 'object') {
        if (Object.keys(value).length > 1000)
            fail(path, 'too many object properties');
        for (const key of rule.required ?? []) {
            if (!Object.hasOwn(value, key))
                fail(path, `missing ${key}`);
        }
        for (const [key, item] of Object.entries(value)) {
            if (FORBIDDEN_KEYS.has(key))
                fail(path, `forbidden property ${key}`);
            const property = rule.properties?.[key];
            if (!property && rule.additionalProperties === false)
                fail(path, `unknown property ${key}`);
            validateSchema(item, property ?? (typeof rule.additionalProperties === 'object'
                ? rule.additionalProperties : {}), root, `${path}.${key}`, depth + 1);
        }
    }
}

export function mergeMetadata(defaults, model) {
    const result = clone(defaults ?? {});
    for (const [key, value] of Object.entries(model ?? {})) {
        // Parameter descriptors inherit by parameter name; each descriptor is atomic.
        if (['parameters', 'capabilities', 'modalities', 'requestDefaults'].includes(key))
            result[key] = { ...result[key], ...clone(value) };
        else
            result[key] = clone(value);
    }
    return result;
}

export function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i])
            return a[i] > b[i] ? 1 : -1;
    }
    return 0;
}

export function validateParameterValue(value, descriptor, path) {
    if (!typeMatches(value, descriptor.type))
        fail(path, `expected ${descriptor.type}`);
    if (descriptor.allowedValues && !descriptor.allowedValues.some(item => canonicalJson(item) === canonicalJson(value)))
        fail(path, 'value is not supported');
    if (typeof value === 'number' && (value < (descriptor.minimum ?? -Infinity) || value > (descriptor.maximum ?? Infinity)))
        fail(path, 'value outside parameter range');
    if (Array.isArray(value) && descriptor.maxItems && value.length > descriptor.maxItems)
        fail(path, 'too many values');
}

function validateModel(model, providerId, path, runtimeParameters) {
    const thinking = model.thinking;
    if (thinking) {
        if (!THINKING_APIS[providerId].includes(thinking.api))
            fail(path, 'reasoning adapter does not belong to this provider');
        const mappedLevels = thinking.api === 'zai-thinking' && !thinking.supportsReasoningEffort
            ? ['off', 'auto'] : MAPPED_THINKING_LEVELS[thinking.api];
        if (mappedLevels && thinking.levels.some(level => !mappedLevels.includes(level)))
            fail(path, 'reasoning level is not implemented by this adapter');
        if (thinking.defaultLevel && !thinking.levels.includes(thinking.defaultLevel))
            fail(path, 'reasoning default is not a supported level');
        if (thinking.alwaysOn && thinking.levels.includes('off'))
            fail(path, 'always-on reasoning cannot offer off');
        if (thinking.budgets && Object.keys(thinking.budgets).some(level => !thinking.levels.includes(level)))
            fail(path, 'budget refers to an unsupported reasoning level');
        if (model.maxOutputTokens && Object.values(thinking.budgets ?? {}).some(budget => budget + 1024 > model.maxOutputTokens))
            fail(path, 'reasoning budget exceeds output capacity');
    }
    if (model.nativeSearch && model.nativeSearch.api !== SEARCH_APIS[providerId])
        fail(path, 'search adapter does not belong to this provider');
    if (model.nativeSearch && model.nativeSearch.tools.some(tool => !SEARCH_TOOLS[providerId]?.includes(tool)))
        fail(path, 'unsupported native search tool');
    if (model.maxInputTokens && model.contextWindowTokens && model.maxInputTokens > model.contextWindowTokens)
        fail(path, 'input limit exceeds context window');
    if (model.requestDefaults?.maxOutputTokens && model.maxOutputTokens
        && model.requestDefaults.maxOutputTokens > model.maxOutputTokens)
        fail(path, 'request default exceeds documented output limit');
    const imageSupport = model.modalities?.input?.image;
    if (typeof model.supportsImageAttachments === 'boolean' && imageSupport && imageSupport !== 'unknown'
        && model.supportsImageAttachments !== (imageSupport === 'supported'))
        fail(path, 'contradictory image input capabilities');
    for (const [name, descriptor] of Object.entries(model.parameters ?? {})) {
        if (descriptor.minimum !== undefined && descriptor.maximum !== undefined && descriptor.minimum > descriptor.maximum)
            fail(path, `${name} has an inverted range`);
        if (descriptor.runtime && (descriptor.support !== 'supported' || !runtimeParameters.includes(name)))
            fail(path, `${name} is not implemented by this adapter`);
        if (descriptor.runtime && !PARAMETER_TYPES[name]?.includes(descriptor.type))
            fail(path, `${name} has the wrong wire type`);
        if (Object.hasOwn(descriptor, 'default')) {
            if (descriptor.support !== 'supported')
                fail(path, `${name} has a default without known support`);
            validateParameterValue(descriptor.default, descriptor, `${path}.parameters.${name}.default`);
        }
    }
}

export function validateCatalog(catalog, schema, { appVersion = '0.5.46', runtimeFeatures = ['model-catalog-v1'], runtimeParameters = {} } = {}) {
    validateSchema(catalog, schema);
    if (!Number.isFinite(Date.parse(catalog.publishedAt)))
        fail('$', 'invalid publication date');
    if (compareVersions(catalog.minAppVersion, appVersion) > 0)
        fail('$', `requires Cusco ${catalog.minAppVersion}`);
    if (catalog.requiredRuntimeFeatures.some(feature => !runtimeFeatures.includes(feature)))
        fail('$', 'requires a newer runtime feature');
    const providerIds = new Set();
    for (const provider of catalog.providers) {
        const path = `$.providers.${provider.id}`;
        if (providerIds.has(provider.id))
            fail(path, 'duplicate provider');
        providerIds.add(provider.id);
        for (const url of provider.sources) {
            if (!/^https:\/\/[^\s/]+\//.test(url))
                fail(path, 'source must be an HTTPS documentation URL');
        }
        for (const image of [false, true]) {
            const models = image ? provider.imageModels : provider.models;
            const defaults = image ? provider.imageModelDefaults : provider.modelDefaults;
            const defaultId = image ? provider.defaultImageModelId : provider.defaultModelId;
            const aliases = (image ? provider.imageAliases : provider.aliases) ?? {};
            const excluded = image ? provider.discovery.excludedImageModelIds : provider.discovery.excludedModelIds;
            const ids = new Set();
            for (const model of models) {
                if (ids.has(model.id))
                    fail(path, `duplicate model ${model.id}`);
                ids.add(model.id);
                if (excluded.includes(model.id) && model.status !== 'retired')
                    fail(path, `active model ${model.id} is excluded`);
                validateModel(mergeMetadata(defaults, model), provider.id, `${path}.${model.id}`,
                    runtimeParameters[`${provider.id}${image ? ':image' : ''}`] ?? []);
            }
            if (models.length > 0 && !models.some(model => model.id === defaultId && model.status !== 'retired'))
                fail(path, 'default model is missing or retired');
            if (defaultId && !ids.has(defaultId))
                fail(path, 'default refers to a missing model');
            for (const [alias, target] of Object.entries(aliases)) {
                if (ids.has(alias) || !ids.has(target) || models.find(model => model.id === target)?.status === 'retired')
                    fail(path, 'aliases must point directly to an available canonical model');
            }
            for (const model of models) {
                if (model.replacementId && (model.replacementId === model.id
                    || !models.some(item => item.id === model.replacementId && item.status !== 'retired')))
                    fail(path, 'invalid replacement model');
            }
        }
    }
    return deepFreeze(clone(catalog));
}

export function validateCatalogUpgrade(previous, next) {
    if (next.revision < previous.revision)
        throw new Error('GitHub returned an older catalog revision.');
    if (next.revision === previous.revision && canonicalJson(next) !== canonicalJson(previous))
        throw new Error('Catalog content changed without a new revision.');
    for (const before of previous.providers) {
        const after = next.providers.find(provider => provider.id === before.id);
        if (!after)
            throw new Error(`Provider ${before.id} must remain in the catalog.`);
        for (const image of [false, true]) {
            const models = image ? after.imageModels : after.models;
            const excluded = image ? after.discovery.excludedImageModelIds : after.discovery.excludedModelIds;
            const aliases = (image ? after.imageAliases : after.aliases) ?? {};
            for (const old of image ? before.imageModels : before.models) {
                if (!models.some(model => model.id === old.id) && !excluded.includes(old.id) && !aliases[old.id])
                    throw new Error(`Removed model ${before.id}/${old.id} needs an exclusion or replacement alias.`);
            }
        }
    }
}
