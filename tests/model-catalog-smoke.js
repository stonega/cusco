import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { BUNDLED_CATALOG, CATALOG_SCHEMA, CATALOG_OPTIONS, CatalogSnapshot, CatalogService,
    FileCatalogStorage, clone } from '../src/providers/catalog.js';
import { ProviderConfigStore } from '../src/providers/config.js';
import { MemoryApiKeyStore } from '../src/secrets/apiKeyStore.js';
import { buildOpenAiResponsesBody, buildOpenAiCompatibleChatBody, buildAnthropicMessagesBody,
    buildGeminiGenerateContentBody } from '../src/providers/remoteProvider.js';
import { generateImageForProvider } from '../src/providers/imageGeneration.js';

function assert(value, message) { if (!value) throw new Error(message); }
function equal(actual, expected, message) {
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}
function rejects(callback, message) {
    let failed = false;
    try { callback(); } catch (_) { failed = true; }
    assert(failed, message);
}
function catalog(revision = 2, modify = () => {}) {
    const data = clone(BUNDLED_CATALOG.data);
    data.revision = revision;
    modify(data);
    return data;
}
function snapshot(data) { return new CatalogSnapshot(data, CATALOG_SCHEMA, CATALOG_OPTIONS); }
function provider(data, id = 'openai') { return data.providers.find(item => item.id === id); }

class MemoryStorage {
    constructor() { this.cache = null; this.state = null; this.failCache = false; this.failState = false; }
    loadCache() { return this.cache && clone(this.cache); }
    loadState() { return this.state && clone(this.state); }
    saveCache(value) { if (this.failCache) throw new Error('Disk full'); this.cache = clone(value); }
    saveState(value) { if (this.failState) throw new Error('Settings unwritable'); this.state = clone(value); }
}
function service(fetch, storage = new MemoryStorage()) {
    return new CatalogService({ bundled: BUNDLED_CATALOG, schema: CATALOG_SCHEMA,
        validationOptions: CATALOG_OPTIONS, storage, fetch, now: () => 1000000, random: () => 0 });
}
function ok(data, etag = '"revision-2"') { return { status: 200, text: JSON.stringify(data), headers: { etag } }; }

equal(BUNDLED_CATALOG.data.providers.length, 7, 'Provider count changed');
equal(BUNDLED_CATALOG.data.providers.reduce((n, p) => n + p.models.length, 0), 27, 'Chat model count changed');
equal(BUNDLED_CATALOG.data.providers.reduce((n, p) => n + p.imageModels.length, 0), 7, 'Image model count changed');
equal(BUNDLED_CATALOG.getModel('kimi', 'kimi-k3').thinking.maxOutputTokensParameter,
    'max_completion_tokens', 'Kimi output token parameter was lost');
equal(BUNDLED_CATALOG.getModel('anthropic', 'claude-haiku-4-5').thinking.budgets,
    { auto: 2048, low: 1024, medium: 2048, high: 3072 }, 'Budget reasoning was lost');
assert(BUNDLED_CATALOG.getModel('openai', 'gpt-4.1').thinking === false, 'Explicit reasoning disable was lost');
assert(BUNDLED_CATALOG.getModel('grok', 'grok-4.3').thinking.offEffort === 'none', 'Off effort mapping was lost');
assert(BUNDLED_CATALOG.getModel('anthropic', 'claude-fable-5').maxOutputTokens === undefined,
    'Unknown documented limit became an invented number');

for (const mutate of [
    data => { data.schemaVersion = 2; },
    data => { data.minAppVersion = '99.0.0'; },
    data => { data.requiredRuntimeFeatures.push('unimplemented-adapter'); },
    data => { data.providers[1] = clone(data.providers[0]); },
    data => { provider(data).models.push(clone(provider(data).models[0])); },
    data => { provider(data).defaultModelId = 'missing'; },
    data => { provider(data).baseUrl = 'https://example.invalid'; },
    data => { provider(data).aliases = { a: 'b', b: 'a' }; },
    data => { provider(data).models[0].thinking.defaultLevel = 'invalid'; },
    data => { provider(data).models[0].thinking.alwaysOn = true; },
    data => { provider(data).models[0].thinking.api = 'anthropic-adaptive'; },
    data => { provider(data).models[0].thinking.levels.push('minimal'); },
    data => { provider(data).modelDefaults.nativeSearch.tools = ['code_interpreter']; },
    data => { provider(data).models[0].maxOutputTokens = -1; },
    data => { provider(data).models[0].parameters = { magic: { support: 'supported', type: 'number', runtime: true } }; },
    data => { provider(data).models[0].parameters = { temperature: { support: 'supported', type: 'number', runtime: true, minimum: 0, maximum: 1, default: 2 } }; },
    data => { provider(data).models[0].parameters = { temperature: { support: 'supported', type: 'object', runtime: true } }; },
    data => { provider(data).models[0].thinking = JSON.parse('{"api":"openai-responses","levels":["low"],"__proto__":{}}'); },
]) rejects(() => snapshot(catalog(2, mutate)), 'Invalid or incompatible catalog was accepted');

// Every pre-migration field is checked against a fixture captured before constants
// were removed. Expectations are independent of the new catalog/resolver.
const fixtureFile = Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path('fixtures/model-catalog-baseline.json');
const [, baselineBytes] = fixtureFile.load_contents(null);
const baseline = JSON.parse(new TextDecoder().decode(baselineBytes));
const defaults = new ProviderConfigStore(undefined, { settings: null, apiKeyStore: new MemoryApiKeyStore(), envLookup: () => '' });
for (const oldProvider of baseline) {
    const current = defaults.getProvider(oldProvider.id);
    for (const [key, expected] of Object.entries(oldProvider)) {
        if (['models', 'imageModels'].includes(key)) {
            equal(current[key].map(model => model.id), expected.map(model => model.id), `${oldProvider.id} order`);
            for (const oldModel of expected) {
                const model = current[key].find(item => item.id === oldModel.id);
                for (const [field, value] of Object.entries(oldModel))
                    equal(model[field], value, `${oldProvider.id}/${model.id}.${field}`);
            }
        } else if (!['apiKeyConfigured', 'enabled'].includes(key))
            equal(current[key], expected, `${oldProvider.id}.${key}`);
    }
}

let calls = 0;
const storage = new MemoryStorage();
const updates = service(async ({ etag }) => {
    calls++;
    if (calls === 1) return ok(catalog());
    assert(etag === '"revision-2"', 'Accepted payload ETag was not reused');
    return { status: 304, headers: {} };
}, storage);
assert(calls === 0 && storage.state === null, 'Constructor performed network or writes');
let changes = 0;
updates.subscribe((_status, changed) => { if (changed) changes++; });
const first = updates.refresh();
assert(updates.refresh() === first, 'Concurrent checks did not share one promise');
assert((await first).updated && changes === 1 && calls === 1, 'Valid update was not applied once');
assert(storage.cache.current.etag === '"revision-2"', 'ETag was not committed with payload');
assert(!(await updates.refresh()).updated && calls === 1, 'Daily check interval was ignored');
assert(!(await updates.refresh({ force: true })).updated && changes === 1 && calls === 2, '304 changed the catalog');
const offline = service(async () => { throw new Error('Offline'); }, storage);
assert(offline.snapshot.revision === 2, 'Offline startup lost cached catalog');
await offline.refresh({ force: true });
assert(offline.snapshot.revision === 2 && offline.getStatus().error === 'Offline', 'Offline failure replaced cached catalog');
assert(offline.getStatus().nextAttemptAt > 1000000, 'Retry backoff was not persisted');
offline.setEnabled(false);
const disabled = service(async () => { throw new Error('Must not request'); }, storage);
assert(!disabled.getStatus().enabled, 'Automatic update preference was not retained');
await disabled.refresh();
assert(disabled.getStatus().error === 'Offline', 'Disabled updater made a request');

for (const response of [
    { status: 200, text: '{', headers: {} },
    ok(catalog(1)),
    ok(catalog(2, data => { provider(data).models[0].name = 'Changed without revision'; })),
    ok(catalog(3, data => { data.minAppVersion = '99.0.0'; })),
    { status: 200, text: ' '.repeat(1024 * 1024 + 1), headers: {} },
    { status: 500, headers: {} },
]) {
    const failing = service(async () => response, storage);
    const before = JSON.stringify(storage.cache);
    const result = await failing.refresh({ force: true });
    assert(Boolean(result.error), 'Invalid update did not report an error');
    assert(failing.snapshot.revision === 2 && JSON.stringify(storage.cache) === before, 'Invalid update modified the accepted cache');
}
const disk = new MemoryStorage();
disk.failCache = true;
const unwritable = service(async () => ok(catalog()), disk);
assert((await unwritable.refresh()).error && unwritable.snapshot.revision === 1, 'Failed atomic write published the snapshot');
let rateLimitRequests = 0;
const rateLimited = service(async () => { rateLimitRequests++; return { status: 429, headers: { 'retry-after': '600' } }; });
await rateLimited.refresh();
assert(rateLimited.getStatus().nextAttemptAt >= 1000600, 'Retry-After was not respected');
await rateLimited.refresh({ force: true });
assert(rateLimitRequests === 1, 'Manual refresh bypassed a server rate limit');
const missing = service(async () => ({ status: 404, headers: {} }));
await missing.refresh();
assert(missing.getStatus().nextAttemptAt >= 1086400, 'Missing feed retried too soon');

// A rate limit longer than the one-day scheduling cap must keep scheduling
// after its first wakeup, without making an early network request.
let later = 1000000;
let longLimitCalls = 0;
const longLimit = new CatalogService({ bundled: BUNDLED_CATALOG, schema: CATALOG_SCHEMA,
    validationOptions: CATALOG_OPTIONS, storage: new MemoryStorage(), now: () => later,
    fetch: async () => { longLimitCalls++; return { status: 429, headers: { 'retry-after': '172800' } }; },
});
await longLimit.refresh();
longLimit.start();
GLib.Source.remove(longLimit._timer);
longLimit._timer = 0;
later += 86400;
await longLimit.refresh();
assert(longLimitCalls === 1 && longLimit._timer > 0, 'Long rate limit stopped automatic scheduling');
longLimit.stop();

const corrupt = new MemoryStorage();
corrupt.cache = { current: { data: { broken: true } }, previous: { data: catalog(2), etag: 'older' } };
assert(service(async () => {}, corrupt).snapshot.revision === 2, 'Previous accepted snapshot was not recovered');
corrupt.cache = { current: { data: catalog(2), etag: 'older' } };
const newerApp = new CatalogService({ bundled: snapshot(catalog(3)), schema: CATALOG_SCHEMA,
    validationOptions: CATALOG_OPTIONS, storage: corrupt, fetch: async () => {} });
assert(newerApp.snapshot.revision === 3, 'An old cache replaced a newer bundled revision');
let missingCalls = 0;
const missingCache = service(async ({ etag }) => {
    missingCalls++;
    if (missingCalls === 1) { assert(etag === '', 'Missing cache sent an ETag'); return { status: 304 }; }
    return ok(catalog(3));
}, corrupt);
corrupt.cache = null;
assert((await missingCache.refresh({ force: true })).updated && missingCalls === 2, 'Missing-payload 304 did not retry unconditionally');

let finishDownload;
const cancellableUpdate = service(() => new Promise(resolve => { finishDownload = resolve; }));
const pending = cancellableUpdate.refresh();
await Promise.resolve();
cancellableUpdate.stop();
finishDownload(ok(catalog()));
await pending;
assert(cancellableUpdate.snapshot.revision === 1, 'Cancelled download published a snapshot');

class MemorySettings {
    constructor(strings = {}) { this.strings = strings; }
    get_string(key) { return this.strings[key] ?? ''; }
    set_string(key, value) { this.strings[key] = value; }
    get_strv() { return []; }
    set_strv() {}
}
const settings = new MemorySettings({
    'provider-default-models': '{"openai":"gpt-5.6-terra"}',
    'provider-discovered-models': '{"openai":[{"id":"gpt-5.6-sol","thinking":{"api":"openai-responses","levels":["low"]},"obsoleteField":true}]}',
});
const store = new ProviderConfigStore(undefined, { settings, apiKeyStore: new MemoryApiKeyStore(), envLookup: () => '' });
store.setProviderCustomEndpoint('openai', 'https://example.invalid/v1');
const oldRequest = store.forRequest(new Gio.Cancellable());
const nextData = catalog(2, data => {
    const openai = provider(data);
    openai.defaultModelId = 'new-model';
    openai.models.push({ id: 'new-model', name: 'New model', thinking: false, contextWindowTokens: 90000 });
    openai.models[0].thinking.levels = ['low', 'high'];
    openai.models[0].maxOutputTokens = 64000;
    openai.models[0].parameters = { temperature: { support: 'supported', runtime: true, type: 'number', minimum: 0, maximum: 1, default: 0.4 } };
    provider(data, 'kimi').defaultModelId = 'kimi-k2.6';
});
store.applyCatalog(snapshot(nextData));
assert(store.getProvider('openai').defaultModelId === 'gpt-5.6-terra', 'Explicit default was overwritten');
assert(store.getProvider('kimi').defaultModelId === 'kimi-k2.6', 'Unselected default did not follow the catalog');
assert(store.getProvider('openai').baseUrl === 'https://example.invalid/v1', 'Custom endpoint was lost');
assert(store.resolve('openai', 'new-model').model.id === 'new-model', 'Discovery hid a new model');
equal(store.getThinkingLevels('openai', 'gpt-5.6-sol'), ['low', 'high'], 'Stale thinking overrode catalog');
assert(!store.resolve('openai', 'gpt-5.6-sol').model.obsoleteField, 'Stale resolved field survived');
assert(oldRequest.resolve('openai', 'gpt-5.6-sol').model.maxOutputTokens === 128000, 'Active turn snapshot changed');
assert(store.resolve('openai', 'gpt-5.6-sol').model.maxOutputTokens === 64000, 'New turn did not receive updated limit');
const removed = clone(nextData);
removed.revision = 3;
provider(removed).models[0].status = 'retired';
delete provider(removed).aliases['gpt-5.6'];
store.applyCatalog(snapshot(removed));
rejects(() => store.assertModelAvailable('openai', 'gpt-5.6-sol'), 'Retired selection silently fell back');
provider(removed).models[0].replacementId = 'gpt-5.6-terra';
store.applyCatalog(snapshot(removed));
store.assertModelAvailable('openai', 'gpt-5.6-sol');
assert(store.resolve('openai', 'gpt-5.6-sol').model.id === 'gpt-5.6-terra', 'Declared replacement was not applied');

// Model-controlled defaults and explicit choices reach the correct API fields.
const parameterModel = { parameters: {
    temperature: { support: 'supported', type: 'number', runtime: true, minimum: 0, maximum: 1, default: 0.4 },
} };
const options = { model: parameterModel, maxOutputTokens: 100, thinkingLevel: 'off' };
equal(buildOpenAiResponsesBody([], 'model', options).temperature, 0.4, 'Responses parameter missing');
equal(buildOpenAiCompatibleChatBody([], 'model', options).temperature, 0.4, 'Chat completions parameter missing');
equal(buildAnthropicMessagesBody([], 'model', options).temperature, 0.4, 'Anthropic parameter missing');
equal(buildGeminiGenerateContentBody([], options).generationConfig.temperature, 0.4, 'Gemini parameter missing');
equal(buildOpenAiResponsesBody([], 'model', { ...options, parameters: { temperature: 0.8 } }).temperature, 0.8, 'Explicit parameter did not override default');
rejects(() => buildOpenAiResponsesBody([], 'model', { ...options, parameters: { temperature: 2 } }), 'Out-of-range parameter was sent');
rejects(() => buildOpenAiResponsesBody([], 'model', { ...options, parameters: { seed: 7 } }), 'Unknown parameter was sent');
parameterModel.parameters.temperature.onlyWithoutThinking = true;
assert(!('temperature' in buildOpenAiResponsesBody([], 'model', { ...options, thinkingLevel: 'high' })), 'Incompatible default was sent');
rejects(() => buildOpenAiResponsesBody([], 'model', { ...options, thinkingLevel: 'high', parameters: { temperature: 0.5 } }), 'Reasoning conflict was ignored');

let imageBody;
await generateImageForProvider({ id: 'zai', name: 'Z.ai', baseUrl: 'https://example.invalid', imageApiFormat: 'zai-images' },
    { id: 'image', parameters: { size: { support: 'supported', type: 'string', runtime: true, default: '1024x1024' } } }, 'test', {
        requestJson: async (_url, _headers, body) => { imageBody = body; return { data: [{ b64_json: 'aGVsbG8=' }] }; },
        saveImage: async () => ({ path: '/tmp/catalog-test-image.png', mimeType: 'image/png' }),
    });
assert(imageBody.size === '1024x1024', 'Image catalog parameter was dropped');

// Real cache I/O, without writing to the user's installed app or configuration.
const directory = GLib.dir_make_tmp('cusco-catalog-smoke-XXXXXX');
const files = new FileCatalogStorage(directory);
try {
    files.saveCache({ current: { data: catalog(2), etag: '"one"' } });
    files.saveState({ enabled: false });
    assert(files.loadCache().current.etag === '"one"' && !files.loadState().enabled, 'Atomic cache/state round trip failed');
    GLib.file_set_contents(files.cachePath, '{');
    assert(service(async () => {}, files).snapshot.revision === 1, 'Corrupt disk cache prevented bundled fallback');
} finally {
    for (const path of [files.cachePath, files.settingsPath])
        Gio.File.new_for_path(path).delete(null);
    Gio.File.new_for_path(directory).delete(null);
}
print('Cusco model catalog smoke passed');
