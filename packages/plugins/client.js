import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    MCP_TRANSPORT_HTTP,
    normalizeMcpServerConfig,
    parseMcpConfigFile,
    sanitizeMcpName,
} from '../mcp/config.js';

export const PLUGIN_MANIFEST_PATH = '.cusco-plugin/plugin.json';
const PORTED_PLUGIN_MANIFEST_PATH = '.codex-plugin/plugin.json';
const PORTED_PLUGIN_MCP_PATH = '.mcp.json';

const moduleDirectory = Gio.File.new_for_uri(import.meta.url).get_parent();
const configuredRepositoryRoot = String(GLib.getenv('CUSCO_REPOSITORY_ROOT') ?? '').trim();

export const DEFAULT_CUSCO_REPOSITORY_ROOT = GLib.canonicalize_filename(
    configuredRepositoryRoot || moduleDirectory.get_parent().get_parent().get_path(),
    null,
);

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_MARKETPLACE_BYTES = 2 * 1024 * 1024;
const MAX_PLUGIN_FILES = 20_000;
const MAX_PLUGIN_BYTES = 1024 * 1024 * 1024;
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLUGIN_SELECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const HIDDEN_CUSCO_MARKETPLACE_PLUGINS = new Set([
    'browser',
    'build-ios-apps',
    'build-macos-apps',
    'build-web-apps',
    'codex-app-tools',
    'chrome',
]);

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function titleCasePluginName(value) {
    return normalizeText(value)
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(' ');
}

function normalizeStringList(values) {
    return Array.isArray(values)
        ? values.map(normalizeText).filter(Boolean)
        : [];
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensurePluginName(value) {
    const name = normalizeText(value);

    if (!PLUGIN_NAME_PATTERN.test(name))
        throw new Error(`Invalid plugin name: ${name || '(empty)'}`);

    return name;
}

function readJsonFile(path, { maxBytes = MAX_MARKETPLACE_BYTES, fallback = null } = {}) {
    if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR))
        return fallback;

    const file = Gio.File.new_for_path(path);
    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);

    if (info.get_size() > maxBytes)
        throw new Error(`JSON file is larger than ${maxBytes} bytes: ${path}`);

    const [, contents] = GLib.file_get_contents(path);
    return JSON.parse(new TextDecoder().decode(contents));
}

function deleteRecursively(file, cancellable = null) {
    if (!file.query_exists(cancellable))
        return;

    const info = file.query_info(
        'standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        cancellable,
    );

    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            cancellable,
        );

        try {
            let childInfo = enumerator.next_file(cancellable);

            while (childInfo) {
                deleteRecursively(file.get_child(childInfo.get_name()), cancellable);
                childInfo = enumerator.next_file(cancellable);
            }
        } finally {
            enumerator.close(cancellable);
        }
    }

    file.delete(cancellable);
}

function copyPluginDirectory(source, destination, cancellable = null, state = { files: 0, bytes: 0 }) {
    const info = source.query_info(
        'standard::type,standard::size',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        cancellable,
    );
    const fileType = info.get_file_type();

    state.files += 1;

    if (state.files > MAX_PLUGIN_FILES)
        throw new Error('Plugin exceeds Cusco installation limits.');

    if (fileType === Gio.FileType.REGULAR) {
        state.bytes += Number(info.get_size());

        if (state.bytes > MAX_PLUGIN_BYTES)
            throw new Error('Plugin exceeds Cusco installation limits.');

        source.copy(destination, Gio.FileCopyFlags.NONE, cancellable, null);
        return;
    }

    if (fileType !== Gio.FileType.DIRECTORY)
        throw new Error(`Plugin contains an unsupported file type: ${source.get_path()}`);

    destination.make_directory(cancellable);
    const enumerator = source.enumerate_children(
        'standard::name',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        cancellable,
    );

    try {
        let childInfo = enumerator.next_file(cancellable);

        while (childInfo) {
            const name = childInfo.get_name();
            copyPluginDirectory(
                source.get_child(name),
                destination.get_child(name),
                cancellable,
                state,
            );
            childInfo = enumerator.next_file(cancellable);
        }
    } finally {
        enumerator.close(cancellable);
    }
}

function manifestPathForPlugin(pluginPath) {
    const rootPath = String(pluginPath ?? '');

    for (const relativePath of [PLUGIN_MANIFEST_PATH, PORTED_PLUGIN_MANIFEST_PATH]) {
        const path = GLib.build_filenamev([rootPath, ...relativePath.split('/')]);

        if (GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            return path;
    }

    return GLib.build_filenamev([rootPath, ...PLUGIN_MANIFEST_PATH.split('/')]);
}

function resolveManifestAsset(pluginPath, assetPath) {
    const rootPath = GLib.canonicalize_filename(String(pluginPath ?? ''), null);
    const relativePath = String(assetPath ?? '').trim().replace(/^\.\//, '');

    if (!rootPath || !relativePath || GLib.path_is_absolute(relativePath))
        return '';

    const resolvedPath = GLib.canonicalize_filename(relativePath, rootPath);

    if (resolvedPath !== rootPath && !resolvedPath.startsWith(`${rootPath}/`))
        return '';

    return GLib.file_test(resolvedPath, GLib.FileTest.IS_REGULAR)
        ? resolvedPath
        : '';
}

function pluginMcpDeclaration(pluginPath, manifest) {
    if (manifest?.mcpServers !== undefined)
        return manifest.mcpServers;

    return resolveManifestAsset(pluginPath, PORTED_PLUGIN_MCP_PATH)
        ? `./${PORTED_PLUGIN_MCP_PATH}`
        : null;
}

function pluginParts(pluginPath, manifest) {
    return {
        hasSkills: Boolean(manifest?.skills),
        hasApps: Boolean(manifest?.apps),
        hasMcpServers: Boolean(pluginMcpDeclaration(pluginPath, manifest)),
        hasHooks: Boolean(manifest?.hooks),
    };
}

function manifestObject(pluginPath, value) {
    if (isRecord(value))
        return value;

    if (typeof value !== 'string')
        return null;

    const assetPath = resolveManifestAsset(pluginPath, value);
    return assetPath
        ? readJsonFile(assetPath, { maxBytes: MAX_MANIFEST_BYTES, fallback: null })
        : null;
}

function pluginMcpServers(pluginPath, value) {
    if (!value)
        return [];

    try {
        const manifest = manifestObject(pluginPath, value);

        if (!isRecord(manifest))
            return [];

        return parseMcpConfigFile(JSON.stringify(manifest));
    } catch (error) {
        logError(error, `Failed to load plugin MCP configuration from ${pluginPath}`);
        return [];
    }
}

function pluginAppDeclarations(pluginPath, value) {
    if (!value)
        return [];

    try {
        const manifest = manifestObject(pluginPath, value);

        if (!isRecord(manifest))
            return [];

        const apps = isRecord(manifest.apps) ? manifest.apps : manifest;
        return Object.entries(apps).map(([name, declaration]) => ({
            name: normalizeText(name),
            required: !isRecord(declaration) || declaration.required !== false,
        })).filter((declaration) => declaration.name);
    } catch (error) {
        logError(error, `Failed to load plugin connector declarations from ${pluginPath}`);
        return [];
    }
}

function pluginConnectors(pluginPath, pluginName, manifest) {
    const servers = pluginMcpServers(
        pluginPath,
        pluginMcpDeclaration(pluginPath, manifest),
    );
    const serversByName = new Map(servers.map((server) => [
        sanitizeMcpName(server.name || server.id),
        server,
    ]));
    const nativeDeclarations = Array.isArray(manifest?.cusco?.connectors)
        ? manifest.cusco.connectors.filter(isRecord)
        : [];
    const nativeByName = new Map(nativeDeclarations.map((connector) => {
        const name = normalizeText(connector.name || connector.id || connector.provider);
        return [sanitizeMcpName(name), connector];
    }));
    const appDeclarations = pluginAppDeclarations(pluginPath, manifest?.apps);
    const names = new Set([
        ...servers.map((server) => server.name || server.id),
        ...nativeDeclarations.map((connector) => (
            connector.name || connector.id || connector.provider
        )),
    ]);
    const hasCuscoBackends = names.size > 0;

    for (const declaration of appDeclarations) {
        const backedByCusco = serversByName.has(sanitizeMcpName(declaration.name))
            || nativeByName.has(sanitizeMcpName(declaration.name));

        if (backedByCusco || declaration.required || !hasCuscoBackends)
            names.add(declaration.name);
    }

    return [...names].map((name) => {
        const normalizedName = sanitizeMcpName(name);
        const server = serversByName.get(normalizedName) ?? null;
        const native = nativeByName.get(normalizedName) ?? null;
        const id = `plugin_${sanitizeMcpName(pluginName, 'plugin')}_${normalizedName}`;

        return {
            id,
            name: titleCasePluginName(name) || titleCasePluginName(pluginName) || 'Connector',
            type: normalizeText(native?.type) || 'mcp',
            runtime: normalizeText(native?.runtime),
            provider: normalizeText(native?.provider),
            service: normalizeText(native?.service),
            connected: false,
            status: 'unconfigured',
            server: server
                ? normalizeMcpServerConfig({
                    ...server,
                    id,
                    name: server.name || titleCasePluginName(name),
                    transport: server.transport === 'http'
                        ? MCP_TRANSPORT_HTTP
                        : server.transport,
                    enabled: true,
                    permissionPolicy: server.permissionPolicy || 'ask',
                }, { source: 'workspace' })
                : null,
        };
    });
}

export function validatePluginSelector(value) {
    const selector = String(value ?? '').trim();

    if (!PLUGIN_SELECTOR_PATTERN.test(selector))
        throw new Error(`Invalid plugin selector: ${selector || '(empty)'}`);

    return selector;
}

export function loadPluginManifest(pluginPath) {
    const path = manifestPathForPlugin(pluginPath);

    if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR))
        return null;

    const file = Gio.File.new_for_path(path);
    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);

    if (info.get_size() > MAX_MANIFEST_BYTES)
        throw new Error(`Plugin manifest is larger than ${MAX_MANIFEST_BYTES} bytes: ${path}`);

    const [, contents] = GLib.file_get_contents(path);
    const manifest = JSON.parse(new TextDecoder().decode(contents));

    if (!isRecord(manifest))
        throw new Error(`Plugin manifest must contain a JSON object: ${path}`);

    return manifest;
}

export function normalizePluginEntry(entry, manifest = null) {
    const sourcePath = normalizeText(entry?.source?.path);
    const pluginManifest = isRecord(manifest) ? manifest : {};
    const pluginInterface = isRecord(pluginManifest.interface) ? pluginManifest.interface : {};
    const name = normalizeText(entry?.name || pluginManifest.name);
    const marketplaceName = normalizeText(entry?.marketplaceName);
    const pluginId = normalizeText(entry?.pluginId) || [name, marketplaceName]
        .filter(Boolean)
        .join('@');
    const displayName = normalizeText(pluginInterface.displayName)
        || titleCasePluginName(name)
        || 'Plugin';
    const description = normalizeText(
        pluginInterface.shortDescription
        || pluginManifest.description
        || pluginInterface.longDescription,
    );
    const logoPath = resolveManifestAsset(
        sourcePath,
        pluginInterface.logo || pluginInterface.composerIcon,
    );
    const connectors = pluginConnectors(sourcePath, name, pluginManifest);

    return {
        pluginId,
        name,
        displayName,
        description,
        longDescription: normalizeText(pluginInterface.longDescription || description),
        developerName: normalizeText(
            pluginInterface.developerName
            || pluginManifest.author?.name,
        ),
        category: normalizeText(pluginInterface.category || entry?.category) || 'Other',
        capabilities: normalizeStringList(pluginInterface.capabilities),
        defaultPrompts: normalizeStringList(pluginInterface.defaultPrompt),
        brandColor: normalizeText(pluginInterface.brandColor),
        logoPath,
        version: normalizeText(pluginManifest.version || entry?.version),
        marketplaceName,
        installed: Boolean(entry?.installed),
        enabled: Boolean(entry?.enabled),
        installPolicy: normalizeText(entry?.installPolicy) || 'AVAILABLE',
        authPolicy: normalizeText(entry?.authPolicy) || 'ON_INSTALL',
        sourcePath,
        marketplaceSource: isRecord(entry?.marketplaceSource)
            ? { ...entry.marketplaceSource }
            : null,
        manifest: pluginManifest,
        connectors,
        ...pluginParts(sourcePath, pluginManifest),
    };
}

export function parsePluginMarketplaceJson(contents, options = {}) {
    const parsed = JSON.parse(String(contents ?? '{}'));
    const manifestLoader = options.manifestLoader ?? loadPluginManifest;
    const installedPluginNames = options.installedPluginNames instanceof Set
        ? options.installedPluginNames
        : new Set();
    const repositoryRoot = String(options.repositoryRoot ?? '').trim();
    const marketplaceName = normalizeText(parsed?.name) || 'cusco';
    const marketplacePlugins = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    const entries = [];

    for (const entry of marketplacePlugins) {
        if (!isRecord(entry))
            continue;

        if (HIDDEN_CUSCO_MARKETPLACE_PLUGINS.has(normalizeText(entry.name).toLowerCase()))
            continue;

        const configuredSourcePath = normalizeText(entry?.source?.path);
        const sourcePath = configuredSourcePath && !GLib.path_is_absolute(configuredSourcePath)
            ? GLib.canonicalize_filename(configuredSourcePath, repositoryRoot || null)
            : configuredSourcePath;
        let manifest = null;

        try {
            manifest = sourcePath ? manifestLoader(sourcePath) : null;
        } catch (error) {
            logError(error, `Failed to load plugin manifest for ${entry?.name ?? 'plugin'}`);
        }

        const name = normalizeText(entry.name || manifest?.name);
        const plugin = normalizePluginEntry({
            ...entry,
            name,
            pluginId: `${name}@${marketplaceName}`,
            marketplaceName,
            installed: installedPluginNames.has(name),
            enabled: installedPluginNames.has(name),
            installPolicy: normalizeText(entry?.policy?.installation) || 'AVAILABLE',
            authPolicy: normalizeText(entry?.policy?.authentication) || 'ON_INSTALL',
            source: {
                ...(isRecord(entry.source) ? entry.source : {}),
                path: sourcePath,
            },
        }, manifest);

        if (!plugin.pluginId)
            continue;

        entries.push(plugin);
    }

    return entries.sort((left, right) => {
        if (left.installed !== right.installed)
            return left.installed ? -1 : 1;

        return left.displayName.localeCompare(right.displayName)
            || left.marketplaceName.localeCompare(right.marketplaceName);
    });
}

function localPluginEntry(pluginPath, manifest) {
    const directoryName = ensurePluginName(GLib.path_get_basename(pluginPath));
    const name = ensurePluginName(manifest?.name);

    if (name !== directoryName)
        throw new Error(`Installed plugin directory does not match manifest name: ${pluginPath}`);

    return normalizePluginEntry({
        pluginId: `${name}@cusco`,
        name,
        marketplaceName: 'cusco',
        installed: true,
        enabled: true,
        source: { source: 'local', path: pluginPath },
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_INSTALL',
    }, manifest);
}

export class CuscoPluginStore {
    constructor({ repositoryRoot = DEFAULT_CUSCO_REPOSITORY_ROOT } = {}) {
        const repositoryPath = String(repositoryRoot ?? '').trim();

        if (!repositoryPath)
            throw new Error('Cusco repository root cannot be empty.');

        this.repositoryRoot = GLib.canonicalize_filename(repositoryPath, null);
        this.pluginsRoot = GLib.build_filenamev([this.repositoryRoot, 'plugins']);
        this.marketplacePath = GLib.build_filenamev([
            this.repositoryRoot,
            '.agents',
            'plugins',
            'marketplace.json',
        ]);
    }

    listInstalledPlugins() {
        const root = Gio.File.new_for_path(this.pluginsRoot);

        if (!root.query_exists(null))
            return [];

        const enumerator = root.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
        );
        const installed = [];

        try {
            let info = enumerator.next_file(null);

            while (info) {
                if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                    const name = info.get_name();
                    const pluginPath = GLib.build_filenamev([this.pluginsRoot, name]);

                    if (!name.startsWith('.')) {
                        try {
                            const manifest = loadPluginManifest(pluginPath);

                            if (manifest)
                                installed.push(localPluginEntry(pluginPath, manifest));
                        } catch (error) {
                            logError(error, `Failed to load installed Cusco plugin: ${pluginPath}`);
                        }
                    }
                }

                info = enumerator.next_file(null);
            }
        } finally {
            enumerator.close(null);
        }

        return installed.sort((left, right) => left.displayName.localeCompare(right.displayName));
    }

    listMarketplacePlugins({ manifestLoader = loadPluginManifest } = {}) {
        const installedNames = new Set(
            this.listInstalledPlugins().map((plugin) => plugin.name),
        );

        return parsePluginMarketplaceJson(JSON.stringify(this._readMarketplace()), {
            installedPluginNames: installedNames,
            manifestLoader,
            repositoryRoot: this.repositoryRoot,
        });
    }

    install(plugin, { cancellable = null } = {}) {
        const name = ensurePluginName(plugin?.name);
        const sourceValue = String(plugin?.sourcePath ?? '').trim();

        if (!sourceValue)
            throw new Error(`Plugin source is unavailable: ${plugin?.displayName || name}`);

        const sourcePath = GLib.canonicalize_filename(sourceValue, null);
        const destinationPath = GLib.build_filenamev([this.pluginsRoot, name]);
        const source = Gio.File.new_for_path(sourcePath);
        const destination = Gio.File.new_for_path(destinationPath);

        if (!source.query_exists(cancellable))
            throw new Error(`Plugin source is unavailable: ${plugin?.displayName || name}`);
        if (destination.query_exists(cancellable))
            throw new Error(`${plugin?.displayName || name} is already installed in Cusco.`);

        const sourceManifest = loadPluginManifest(sourcePath);

        if (!sourceManifest)
            throw new Error(`Plugin source is missing ${PLUGIN_MANIFEST_PATH} or a compatible ported manifest.`);
        if (ensurePluginName(sourceManifest.name) !== name)
            throw new Error('Plugin manifest name does not match its catalog entry.');

        GLib.mkdir_with_parents(this.pluginsRoot, 0o755);
        const stagingPath = GLib.build_filenamev([
            this.pluginsRoot,
            `.${name}.installing-${GLib.uuid_string_random()}`,
        ]);
        const staging = Gio.File.new_for_path(stagingPath);

        try {
            copyPluginDirectory(source, staging, cancellable);

            const stagedManifest = loadPluginManifest(stagingPath);

            if (!stagedManifest || ensurePluginName(stagedManifest.name) !== name)
                throw new Error('Copied plugin failed manifest validation.');

            staging.move(destination, Gio.FileCopyFlags.NONE, cancellable, null);
        } catch (error) {
            if (staging.query_exists(null)) {
                try {
                    deleteRecursively(staging, null);
                } catch (cleanupError) {
                    logError(cleanupError, `Failed to remove plugin staging directory: ${stagingPath}`);
                }
            }
            throw error;
        }

        return { pluginId: plugin.pluginId, path: destinationPath, success: true };
    }

    uninstall(plugin, { cancellable = null } = {}) {
        const name = ensurePluginName(plugin?.name);
        const destinationPath = GLib.build_filenamev([this.pluginsRoot, name]);
        const destination = Gio.File.new_for_path(destinationPath);

        if (!destination.query_exists(cancellable))
            return { pluginId: plugin.pluginId, path: destinationPath, success: true };

        const stagingPath = GLib.build_filenamev([
            this.pluginsRoot,
            `.${name}.removing-${GLib.uuid_string_random()}`,
        ]);
        const staging = Gio.File.new_for_path(stagingPath);

        destination.move(staging, Gio.FileCopyFlags.NONE, cancellable, null);

        try {
            deleteRecursively(staging, cancellable);
        } catch (error) {
            try {
                if (staging.query_exists(null) && !destination.query_exists(null))
                    staging.move(destination, Gio.FileCopyFlags.NONE, null, null);
            } catch (rollbackError) {
                logError(rollbackError, `Failed to roll back plugin removal: ${destinationPath}`);
            }
            throw error;
        }

        return { pluginId: plugin.pluginId, path: destinationPath, success: true };
    }

    _readMarketplace() {
        const marketplace = readJsonFile(this.marketplacePath, {
            fallback: {
                name: 'cusco',
                interface: { displayName: 'Cusco' },
                plugins: [],
            },
        });

        if (!isRecord(marketplace) || !Array.isArray(marketplace.plugins))
            throw new Error(`Invalid Cusco marketplace file: ${this.marketplacePath}`);

        return marketplace;
    }

}

export class CuscoPluginClient {
    constructor({
        manifestLoader = loadPluginManifest,
        repositoryRoot = DEFAULT_CUSCO_REPOSITORY_ROOT,
        store = null,
    } = {}) {
        this._manifestLoader = manifestLoader;
        this._store = store ?? new CuscoPluginStore({ repositoryRoot });
        this._catalogById = new Map();
    }

    async listPlugins() {
        const plugins = this._store.listMarketplacePlugins({
            manifestLoader: this._manifestLoader,
        });
        this._catalogById = new Map(plugins.map((plugin) => [plugin.pluginId, plugin]));
        return plugins;
    }

    async install(pluginId, options = {}) {
        const selector = validatePluginSelector(pluginId);
        let plugin = this._catalogById.get(selector);

        if (!plugin) {
            await this.listPlugins(options);
            plugin = this._catalogById.get(selector);
        }

        if (!plugin)
            throw new Error(`Plugin is not available in the Cusco catalog: ${selector}`);

        return this._store.install(plugin, options);
    }

    async uninstall(pluginId, options = {}) {
        const selector = validatePluginSelector(pluginId);
        const plugin = this._catalogById.get(selector) ?? {
            pluginId: selector,
            name: selector.split('@')[0],
        };

        return this._store.uninstall(plugin, options);
    }
}
