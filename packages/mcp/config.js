import GLib from 'gi://GLib?version=2.0';

export const MCP_CONFIG_APP_ID = 'io.github.stonega.Cusco';
export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_TRANSPORT_STDIO = 'stdio';
export const MCP_TRANSPORT_HTTP = 'streamable-http';

function normalizeList(values) {
    return Array.isArray(values)
        ? values.map((value) => String(value).trim()).filter(Boolean)
        : [];
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
        url,
        headers: normalizeStringMap(server?.headers),
        roots: normalizeList(server?.roots),
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

    GLib.file_set_contents(path, `${JSON.stringify(config, null, 2)}\n`);
}
