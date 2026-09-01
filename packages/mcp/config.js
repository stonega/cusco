import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

export const MCP_CONFIG_APP_ID = 'io.github.stonega.Cusco';
export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
    MCP_PROTOCOL_VERSION,
    MCP_LEGACY_PROTOCOL_VERSION,
]);
export const MCP_TRANSPORT_STDIO = 'stdio';
export const MCP_TRANSPORT_HTTP = 'streamable-http';

function normalizeList(values) {
    return Array.isArray(values)
        ? values.map((value) => String(value).trim()).filter(Boolean)
        : [];
}

function normalizeOptionalList(values) {
    if (values === undefined || values === null)
        return null;

    return [...new Set(normalizeList(values))];
}

function normalizeStringMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};

    const normalized = {};

    for (const [key, mapValue] of Object.entries(value)) {
        const normalizedKey = String(key ?? '').trim();
        const normalizedValue = String(mapValue ?? '').trim();

        if (normalizedKey && normalizedValue)
            normalized[normalizedKey] = normalizedValue;
    }

    return normalized;
}

function normalizePositivePort(value) {
    const port = Number.parseInt(value, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function normalizeOauthScopes(value) {
    if (Array.isArray(value))
        return normalizeList(value);

    return String(value ?? '').trim().split(/\s+/).filter(Boolean);
}

function normalizeOauthConfig(server) {
    const oauth = server?.oauth && typeof server.oauth === 'object' && !Array.isArray(server.oauth)
        ? server.oauth
        : {};

    return {
        resource: String(
            oauth.resource
            ?? server?.oauthResource
            ?? server?.oauth_resource
            ?? '',
        ).trim(),
        clientId: String(oauth.clientId ?? oauth.client_id ?? '').trim(),
        clientIdRequired: oauth.clientIdRequired === true
            || oauth.client_id_required === true,
        clientSecretEnvVar: String(
            oauth.clientSecretEnvVar
            ?? oauth.client_secret_env_var
            ?? '',
        ).trim(),
        tokenEndpointAuthMethod: String(
            oauth.tokenEndpointAuthMethod
            ?? oauth.token_endpoint_auth_method
            ?? '',
        ).trim(),
        callbackUrl: String(oauth.callbackUrl ?? oauth.callback_url ?? '').trim(),
        callbackPort: normalizePositivePort(oauth.callbackPort ?? oauth.callback_port),
        scopes: normalizeOauthScopes(oauth.scopes ?? oauth.scope),
    };
}

export function defaultMcpConfigFilePath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        MCP_CONFIG_APP_ID,
        'mcp.json',
    ]);
}

export function sanitizeMcpName(value, fallback = 'mcp') {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '');

    return normalized || fallback;
}

export function normalizeMcpServerConfig(server, options = {}) {
    const source = options.source ?? server?.source ?? 'workspace';
    const rawName = String(server?.name ?? options.name ?? '').trim();
    const name = rawName || 'MCP Server';
    const id = String(server?.id ?? options.id ?? sanitizeMcpName(name, 'mcp-server')).trim();
    const explicitTransport = String(server?.transport ?? '').trim().toLowerCase();
    const url = String(server?.url ?? '').trim();
    const command = String(server?.command ?? '').trim();
    const transport = explicitTransport
        || (url ? MCP_TRANSPORT_HTTP : MCP_TRANSPORT_STDIO);
    const enabled = server?.enabled === undefined
        ? server?.disabled !== true
        : server.enabled !== false;

    return {
        id,
        namespace: sanitizeMcpName(server?.namespace ?? name ?? id, sanitizeMcpName(id, 'mcp')),
        name,
        description: String(server?.description ?? '').trim(),
        source,
        sourcePath: String(options.sourcePath ?? server?.sourcePath ?? '').trim(),
        transport: transport === MCP_TRANSPORT_HTTP ? MCP_TRANSPORT_HTTP : MCP_TRANSPORT_STDIO,
        command,
        args: normalizeList(server?.args),
        cwd: String(server?.cwd ?? '').trim(),
        env: normalizeStringMap(server?.env),
        envPassthrough: normalizeList(server?.envPassthrough ?? server?.env_passthrough),
        url,
        headers: normalizeStringMap(server?.headers),
        headerEnv: normalizeStringMap(server?.headerEnv ?? server?.header_env),
        bearerTokenEnvVar: String(
            server?.bearerTokenEnvVar ?? server?.bearer_token_env_var ?? '',
        ).trim(),
        oauth: normalizeOauthConfig(server),
        roots: normalizeList(server?.roots),
        allowedTools: normalizeOptionalList(server?.allowedTools ?? server?.allowed_tools),
        enabled,
        permissionPolicy: String(server?.permissionPolicy ?? 'ask').trim().toLowerCase() || 'ask',
        createdAt: server?.createdAt ?? '',
        updatedAt: server?.updatedAt ?? '',
    };
}

function configEntriesFromObject(mcpServers, sourcePath) {
    const entries = [];

    for (const [name, server] of Object.entries(mcpServers ?? {})) {
        entries.push(normalizeMcpServerConfig({
            ...server,
            name: server?.name ?? name,
            id: server?.id ?? sanitizeMcpName(name, 'mcp-server'),
        }, {
            source: 'file',
            sourcePath,
            name,
            id: sanitizeMcpName(name, 'mcp-server'),
        }));
    }

    return entries;
}

function configEntriesFromArray(mcpServers, sourcePath) {
    return mcpServers
        .map((server, index) => normalizeMcpServerConfig(server, {
            source: 'file',
            sourcePath,
            id: server?.id ?? sanitizeMcpName(server?.name ?? `server-${index + 1}`, 'mcp-server'),
        }));
}

export function parseMcpConfigFile(contents, { sourcePath = '' } = {}) {
    const parsed = JSON.parse(String(contents ?? '{}'));
    const servers = parsed?.mcpServers ?? parsed?.servers ?? parsed;

    if (Array.isArray(servers))
        return configEntriesFromArray(servers, sourcePath);

    if (servers && typeof servers === 'object')
        return configEntriesFromObject(servers, sourcePath);

    return [];
}

export function loadMcpConfigFile(path = defaultMcpConfigFilePath()) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return [];

    const [, contents] = GLib.file_get_contents(path);
    return parseMcpConfigFile(new TextDecoder().decode(contents), { sourcePath: path });
}

function getMcpServerContainer(config) {
    if (config?.mcpServers !== undefined)
        return config.mcpServers;

    if (config?.servers !== undefined)
        return config.servers;

    return config;
}

function normalizeFileServerEntry(server, keyOrIndex, sourcePath) {
    if (typeof keyOrIndex === 'number') {
        return normalizeMcpServerConfig(server, {
            source: 'file',
            sourcePath,
            id: server?.id ?? sanitizeMcpName(server?.name ?? `server-${keyOrIndex + 1}`, 'mcp-server'),
        });
    }

    return normalizeMcpServerConfig({
        ...server,
        name: server?.name ?? keyOrIndex,
        id: server?.id ?? sanitizeMcpName(keyOrIndex, 'mcp-server'),
    }, {
        source: 'file',
        sourcePath,
        name: keyOrIndex,
        id: sanitizeMcpName(keyOrIndex, 'mcp-server'),
    });
}

function setServerEnabledValue(server, enabled) {
    server.enabled = Boolean(enabled);
    delete server.disabled;
}

function writeJsonFileAtomically(path, config) {
    const directory = GLib.path_get_dirname(path);
    const basename = GLib.path_get_basename(path);
    const temporaryPath = GLib.build_filenamev([
        directory,
        `.${basename}.${GLib.uuid_string_random()}.tmp`,
    ]);
    const payload = `${JSON.stringify(config, null, 2)}\n`;

    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(temporaryPath, payload);
    GLib.chmod(temporaryPath, 0o600);

    try {
        Gio.File.new_for_path(temporaryPath).move(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null,
        );
    } finally {
        if (GLib.file_test(temporaryPath, GLib.FileTest.EXISTS))
            GLib.unlink(temporaryPath);
    }
}

function looksLikeServerConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;

    return ['url', 'command', 'transport', 'args', 'oauth'].some((key) => (
        Object.hasOwn(value, key)
    ));
}

function writableMcpServerContainer(config) {
    if (config?.mcpServers !== undefined)
        return config.mcpServers;

    if (config?.servers !== undefined)
        return config.servers;

    if (Array.isArray(config))
        return config;

    const entries = Object.entries(config ?? {});

    if (entries.length > 0 && entries.every(([, value]) => looksLikeServerConfig(value)))
        return config;

    config.mcpServers = {};
    return config.mcpServers;
}

function mergedServerConfig(existing, updates) {
    const next = {
        ...(existing ?? {}),
        ...updates,
    };

    if (updates?.oauth && typeof updates.oauth === 'object' && !Array.isArray(updates.oauth)) {
        next.oauth = {
            ...(existing?.oauth && typeof existing.oauth === 'object' ? existing.oauth : {}),
            ...updates.oauth,
        };
    }

    return next;
}

export function upsertMcpConfigFileServer(path, name, updates = {}) {
    const serverName = String(name ?? updates?.name ?? '').trim();

    if (!serverName)
        throw new Error('MCP server name cannot be empty.');

    let config = {};

    if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        const [, contents] = GLib.file_get_contents(path);
        config = JSON.parse(new TextDecoder().decode(contents));

        if (!config || typeof config !== 'object')
            throw new Error('MCP config file must contain a JSON object or array.');
    }

    const container = writableMcpServerContainer(config);
    const targetId = sanitizeMcpName(updates.id ?? serverName, 'mcp-server');
    let stored;
    let storedKeyOrIndex;

    if (Array.isArray(container)) {
        const index = container.findIndex((server, itemIndex) => {
            const normalized = normalizeFileServerEntry(server, itemIndex, path);
            return normalized.id === targetId || normalized.name === serverName;
        });
        const existing = index >= 0 ? container[index] : null;
        stored = mergedServerConfig(existing, {
            ...updates,
            id: String(updates.id ?? existing?.id ?? targetId),
            name: serverName,
        });

        if (index >= 0)
            container[index] = stored;
        else
            container.push(stored);
        storedKeyOrIndex = index >= 0 ? index : container.length - 1;
    } else if (container && typeof container === 'object') {
        const entry = Object.entries(container).find(([entryName, server]) => {
            const normalized = normalizeFileServerEntry(server, entryName, path);
            return normalized.id === targetId || normalized.name === serverName;
        });
        const key = entry?.[0] ?? serverName;
        stored = mergedServerConfig(entry?.[1], updates);
        container[key] = stored;
        storedKeyOrIndex = key;
    } else {
        throw new Error('MCP config file does not contain a writable server list.');
    }

    writeJsonFileAtomically(path, config);
    return normalizeFileServerEntry(
        stored,
        storedKeyOrIndex,
        path,
    );
}

export function setMcpConfigFileServerEnabled(path, targetServer, enabled) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        throw new Error(`MCP config file does not exist: ${path}`);

    const [, contents] = GLib.file_get_contents(path);
    const config = JSON.parse(new TextDecoder().decode(contents));
    const container = getMcpServerContainer(config);

    if (Array.isArray(container)) {
        const index = container.findIndex((server, itemIndex) => (
            normalizeFileServerEntry(server, itemIndex, path)?.id === targetServer.id
        ));

        if (index < 0)
            throw new Error(`MCP server does not exist in config file: ${targetServer.name}`);

        setServerEnabledValue(container[index], enabled);
    } else if (container && typeof container === 'object') {
        const entry = Object.entries(container).find(([name, server]) => (
            normalizeFileServerEntry(server, name, path)?.id === targetServer.id
        ));

        if (!entry)
            throw new Error(`MCP server does not exist in config file: ${targetServer.name}`);

        setServerEnabledValue(entry[1], enabled);
    } else {
        throw new Error('MCP config file does not contain a server list.');
    }

    writeJsonFileAtomically(path, config);
}
