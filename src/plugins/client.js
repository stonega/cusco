import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('plugins/client.js');

export const {
    configureAutomaticPluginServers,
    CuscoPluginClient,
    CuscoPluginStore,
    DEFAULT_CUSCO_REPOSITORY_ROOT,
    isPluginRemoved,
    loadPluginManifest,
    normalizePluginEntry,
    parsePluginMarketplaceJson,
    pluginConnectorNeedsAuthentication,
    PLUGIN_MANIFEST_PATH,
    validatePluginSelector,
} = implementation;
