import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('plugins/client.js');

export const {
    CuscoPluginClient,
    CuscoPluginStore,
    DEFAULT_CUSCO_REPOSITORY_ROOT,
    loadPluginManifest,
    normalizePluginEntry,
    parsePluginMarketplaceJson,
    PLUGIN_MANIFEST_PATH,
    validatePluginSelector,
} = implementation;
