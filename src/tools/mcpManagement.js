import GLib from 'gi://GLib?version=2.0';

function userVisibleError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
}

function parseInput(input) {
    if (input && typeof input === 'object' && !Array.isArray(input))
        return input;

    const source = String(input ?? '').trim();

    if (!source)
        return {};

    try {
        const parsed = JSON.parse(source);

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed;
    } catch (_error) {
    }

    throw userVisibleError('MCP management input must be a JSON object.');
}

function normalizeList(value, fieldName) {
    if (!Array.isArray(value))
        throw userVisibleError(`${fieldName} must be an array of strings.`);

    return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function isLoopbackHost(host) {
    return host === 'localhost'
        || host === '::1'
        || host === '127.0.0.1'
        || host.startsWith('127.');
}

function validateMcpUrl(value) {
    const url = String(value ?? '').trim();
    let uri;

    try {
        uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch (_error) {
        throw userVisibleError('MCP server URL is invalid.');
    }

    const scheme = String(uri.get_scheme() ?? '').toLowerCase();
    const host = String(uri.get_host() ?? '').toLowerCase();

    if (!host || (scheme !== 'https' && !(scheme === 'http' && isLoopbackHost(host)))) {
        throw userVisibleError(
            'MCP server URL must use HTTPS, except for a loopback development server.',
        );
    }

    return url;
}

function serverReference(input) {
    const reference = String(input.server ?? input.serverName ?? input.name ?? '').trim();

    if (!reference)
        throw userVisibleError('An MCP server name, ID, or key is required.');

    return reference;
}

function publicServerSummary(mcpManager, server) {
    return {
        key: server.key,
        id: server.id,
        name: server.name,
        namespace: server.namespace,
        source: server.source,
        transport: server.transport,
        url: server.url,
        enabled: server.enabled,
        authenticated: server.authenticated,
        oauthScopes: [...(server.oauth?.scopes ?? [])],
        allowedTools: server.allowedTools === null ? null : [...(server.allowedTools ?? [])],
        availableTools: mcpManager.listServerToolNames(server.key),
        status: {
            state: server.status?.state ?? 'idle',
            message: server.status?.message ?? '',
            updatedAt: server.status?.updatedAt ?? '',
        },
    };
}

function outputFor(value) {
    return JSON.stringify(value, null, 2);
}

function configurationFromInput(input) {
    const name = String(input.name ?? '').trim();

    if (!name)
        throw userVisibleError('MCP server name is required.');

    const permissionPolicy = String(input.permissionPolicy ?? 'ask').trim().toLowerCase();

    if (!['ask', 'allow'].includes(permissionPolicy))
        throw userVisibleError('permissionPolicy must be "ask" or "allow".');

    const server = {
        name,
        url: validateMcpUrl(input.url),
        enabled: input.enabled !== false,
        permissionPolicy,
    };

    if (input.namespace !== undefined)
        server.namespace = String(input.namespace ?? '').trim();
    if (input.allowedTools !== undefined)
        server.allowedTools = normalizeList(input.allowedTools, 'allowedTools');

    const oauth = {};

    if (input.oauthScopes !== undefined)
        oauth.scopes = normalizeList(input.oauthScopes, 'oauthScopes');
    if (input.oauthResource !== undefined)
        oauth.resource = String(input.oauthResource ?? '').trim();
    if (input.oauthClientId !== undefined)
        oauth.clientId = String(input.oauthClientId ?? '').trim();
    if (Object.keys(oauth).length > 0)
        server.oauth = oauth;

    return server;
}

export function createMcpManagementTools(mcpManager, toolManager) {
    if (!mcpManager || !toolManager)
        throw new TypeError('MCP management tools require MCP and tool managers.');

    return [
        {
            name: 'mcp_server_configure',
            label: 'Configure MCP Server',
            description: 'Add or update a direct, file-backed Streamable HTTP MCP server while preserving unrelated mcp.json settings. This does not install or register a plugin.',
            inputDescription: 'JSON with name, url, optional namespace, oauthScopes, oauthResource, oauthClientId, allowedTools, permissionPolicy, and enabled.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    url: { type: 'string' },
                    namespace: { type: 'string' },
                    oauthScopes: { type: 'array', items: { type: 'string' } },
                    oauthResource: { type: 'string' },
                    oauthClientId: { type: 'string' },
                    allowedTools: { type: 'array', items: { type: 'string' } },
                    permissionPolicy: { type: 'string', enum: ['ask', 'allow'] },
                    enabled: { type: 'boolean' },
                },
                required: ['name', 'url'],
                additionalProperties: false,
            },
            permissionPolicy: 'ask',
            requiresPermission: true,
            concurrencySafe: false,
            run: async (rawInput, options = {}) => {
                const configured = mcpManager.upsertFileServer(
                    configurationFromInput(parseInput(rawInput)),
                );
                await mcpManager.refreshTools(toolManager, options);
                const server = mcpManager.getServer(configured.key);
                const summary = publicServerSummary(mcpManager, server);

                return {
                    detail: summary.status.state,
                    output: outputFor(summary),
                };
            },
        },
        {
            name: 'mcp_server_connect',
            label: 'Connect MCP Server',
            description: 'Connect or reconnect a configured MCP server. When OAuth is required, opens the system browser, stores tokens in Secret Service, and refreshes the live Agent Mode tools after authorization.',
            inputDescription: 'JSON with server set to the configured server name, ID, or key.',
            inputSchema: {
                type: 'object',
                properties: {
                    server: { type: 'string' },
                },
                required: ['server'],
                additionalProperties: false,
            },
            permissionPolicy: 'ask',
            requiresPermission: true,
            concurrencySafe: false,
            run: async (rawInput, options = {}) => {
                const input = parseInput(rawInput);
                let server = mcpManager.getServer(serverReference(input));
                await mcpManager.connectServer(server.key, options);
                await mcpManager.refreshTools(toolManager, options);
                server = mcpManager.getServer(server.key);
                const summary = publicServerSummary(mcpManager, server);

                return {
                    detail: summary.status.state,
                    output: outputFor(summary),
                };
            },
        },
        {
            name: 'mcp_server_status',
            label: 'MCP Server Status',
            description: 'Show non-sensitive MCP configuration, connection state, allowlist, and currently available tool names.',
            inputDescription: 'Optional JSON with server set to a server name, ID, or key. Omit it to list every configured server.',
            inputSchema: {
                type: 'object',
                properties: {
                    server: { type: 'string' },
                },
                additionalProperties: false,
            },
            permissionPolicy: 'allow',
            requiresPermission: false,
            concurrencySafe: true,
            run: async (rawInput) => {
                const input = parseInput(rawInput);
                const servers = input.server
                    ? [mcpManager.getServer(serverReference(input))]
                    : mcpManager.listServers();
                const summaries = servers.map((server) => publicServerSummary(mcpManager, server));

                return {
                    detail: `${summaries.length} server${summaries.length === 1 ? '' : 's'}`,
                    output: outputFor(input.server ? summaries[0] : summaries),
                };
            },
        },
        {
            name: 'mcp_server_call',
            label: 'Call MCP Server Tool',
            description: 'Invoke one currently discovered and allowed MCP tool by its raw server tool name. Use this immediately after connecting when the direct namespaced tool was not present in the initial model prompt.',
            inputDescription: 'JSON with server, tool, and an optional arguments object.',
            inputSchema: {
                type: 'object',
                properties: {
                    server: { type: 'string' },
                    tool: { type: 'string' },
                    arguments: { type: 'object' },
                },
                required: ['server', 'tool'],
                additionalProperties: false,
            },
            permissionPolicy: 'ask',
            requiresPermission: true,
            concurrencySafe: false,
            run: async (rawInput, options = {}) => {
                const input = parseInput(rawInput);
                const server = mcpManager.getServer(serverReference(input));
                const toolName = String(input.tool ?? '').trim();

                if (!toolName)
                    throw userVisibleError('MCP tool name is required.');

                const output = await mcpManager.callTool(
                    server.key,
                    toolName,
                    JSON.stringify(input.arguments ?? {}),
                    options,
                );

                return {
                    detail: `${server.name}: ${toolName}`,
                    output,
                };
            },
        },
    ];
}
