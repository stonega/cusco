import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { BUNDLED_CATALOG, CATALOG_SCHEMA, CATALOG_OPTIONS, CatalogService, clone } from '../src/providers/catalog.js';
import { ProviderConfigStore } from '../src/providers/config.js';
import { MemoryApiKeyStore } from '../src/secrets/apiKeyStore.js';
import { createProviderSettingsPage } from '../src/settings/providerSettings.js';

function assert(value, message) { if (!value) throw new Error(message); }
function find(widget, predicate) {
    if (predicate(widget)) return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const result = find(child, predicate);
        if (result) return result;
    }
    return null;
}

if (!Gtk.init_check()) {
    print('Cusco model catalog settings smoke skipped: no display');
} else {
    Adw.init();
    const data = clone(BUNDLED_CATALOG.data);
    data.revision++;
    const openai = data.providers.find(provider => provider.id === 'openai');
    openai.models.push({ id: 'catalog-ui-model', name: 'Catalog UI Model', thinking: false });
    openai.defaultModelId = 'catalog-ui-model';
    let state = null;
    let cache = null;
    let requests = 0;
    const service = new CatalogService({ bundled: BUNDLED_CATALOG, schema: CATALOG_SCHEMA, validationOptions: CATALOG_OPTIONS,
        storage: {
            loadState: () => state, saveState: value => { state = clone(value); },
            loadCache: () => cache, saveCache: value => { cache = clone(value); },
        },
        fetch: async () => { requests++; return { status: 200, text: JSON.stringify(data), headers: { etag: '"ui-test"' } }; },
    });
    const store = new ProviderConfigStore(undefined, { settings: null, apiKeyStore: new MemoryApiKeyStore(),
        envLookup: () => '', catalogService: service });
    const page = createProviderSettingsPage(store, () => {});
    const automatic = find(page, widget => widget instanceof Adw.SwitchRow && widget.get_title() === 'Automatic Updates');
    const refresh = find(page, widget => widget instanceof Gtk.Button && widget.get_label() === 'Refresh Now');
    const status = find(page, widget => widget instanceof Adw.ActionRow && widget.get_title() === 'Catalog Status');
    assert(automatic?.get_active() && refresh?.get_sensitive(), 'Catalog settings controls are missing');
    assert(requests === 0, 'Opening settings started a network request');
    automatic.set_active(false);
    assert(state.enabled === false, 'Automatic update toggle did not persist');
    refresh.emit('clicked');
    assert(!refresh.get_sensitive(), 'Refresh control allowed concurrent requests');
    await service.refresh({ force: true });
    assert(requests === 1 && refresh.get_sensitive(), 'Manual refresh did not finish once');
    assert(status.get_subtitle().includes(`Revision ${data.revision}`), 'Status did not show the accepted revision');
    assert(store.getProvider('openai').defaultModelId === 'catalog-ui-model', 'Provider settings did not receive the new catalog');
    const providerRow = find(page, widget => widget instanceof Adw.ExpanderRow && widget.get_title() === 'OpenAI');
    const models = find(providerRow, widget => widget instanceof Adw.ComboRow && widget.get_title() === 'Default model');
    assert(models.get_selected_item().get_string() === 'Catalog UI Model', 'Model dropdown did not refresh after download');
    models.set_selected(1);
    assert(store.getProvider('openai').defaultModelId === 'gpt-5.6-terra', 'Selecting a model after refresh used a stale list');
    store.dispose();
    service.stop();
    print('Cusco model catalog settings smoke passed');
}
