import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { APP_VERSION } from '../appInfo.js';
import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('modelCatalog/index.js');
export const { CatalogSnapshot, CatalogService, FileCatalogStorage, fetchCatalog, clone,
    mergeMetadata, RUNTIME_PARAMETERS, IMAGE_PARAMETER_FIELDS, parameterValues } = implementation;

export function loadCatalogResource(name) {
    const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
    const candidates = [
        root.resolve_relative_path(name),
        root.resolve_relative_path(`../data/${name}`),
        Gio.File.new_for_uri(`resource:///io/github/stonega/Cusco/${name}`),
    ];
    for (const file of candidates) {
        if (!file.query_exists(null))
            continue;
        const [, contents] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(contents));
    }
    throw new Error(`Bundled catalog resource not found: ${name}`);
}

export const CATALOG_SCHEMA = loadCatalogResource('model-catalog.schema.json');
export const CATALOG_OPTIONS = { appVersion: APP_VERSION, runtimeParameters: RUNTIME_PARAMETERS };
export const BUNDLED_CATALOG = new CatalogSnapshot(loadCatalogResource('model-catalog.v1.json'), CATALOG_SCHEMA, CATALOG_OPTIONS);
export const CATALOG_URL = 'https://api.github.com/repos/stonega/cusco/contents/data/model-catalog.v1.json?ref=main';

let defaultService = null;
export function getDefaultCatalogService() {
    if (!defaultService) {
        defaultService = new CatalogService({
            bundled: BUNDLED_CATALOG, schema: CATALOG_SCHEMA, validationOptions: CATALOG_OPTIONS,
            storage: new FileCatalogStorage(GLib.build_filenamev([GLib.get_user_cache_dir(), 'cusco', 'model-catalog']),
                GLib.build_filenamev([GLib.get_user_config_dir(), 'cusco', 'catalog-updates.json'])),
            fetch: (options) => fetchCatalog(CATALOG_URL, options),
        });
    }
    return defaultService;
}
