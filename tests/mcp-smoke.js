import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import {
    createPkceChallenge,
    MemoryMcpTokenStore,
    parseWwwAuthenticate,
} from '../src/mcp/auth.js';
import {
    MCP_PROTOCOL_VERSION,
    MCP_TRANSPORT_HTTP,
    MCP_TRANSPORT_STDIO,
    parseMcpConfigFile,
} from '../src/mcp/config.js';
import { McpManager } from '../src/mcp/manager.js';
import { ToolManager } from '../src/tools/tools.js';
import { WorkspaceManager } from '../src/workspace/workspace.js';

const gjs = GLib.find_program_in_path('gjs');

if (!gjs)
    throw new Error('gjs was not found in PATH');

const fakeServerPath = GLib.build_filenamev([
    GLib.get_current_dir(),
    'tests',
    'fixtures',
    'fake-mcp-server.js',
]);

const parsed = parseMcpConfigFile(JSON.stringify({
    mcpServers: {
        remote: {
            url: 'https://example.test/mcp',
            headers: {
                Authorization: 'Bearer test',
            },
        },
        local: {
            command: gjs,
            args: ['-m', fakeServerPath],
        },
        disabled: {
            command: gjs,
            args: ['-m', fakeServerPath],
            disabled: true,
        },
    },
}));

if (parsed.find((server) => server.id === 'remote')?.transport !== MCP_TRANSPORT_HTTP)
    throw new Error('HTTP MCP config was not normalized');

if (parsed.find((server) => server.id === 'local')?.transport !== MCP_TRANSPORT_STDIO)
    throw new Error('stdio MCP config was not normalized');

if (parsed.find((server) => server.id === 'disabled')?.enabled !== false)
    throw new Error('Disabled MCP config was not normalized');

const authChallenge = parseWwwAuthenticate(
    'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"',
);

if (authChallenge?.resourceMetadataUrl !== 'https://mcp.example.com/.well-known/oauth-protected-resource'
    || authChallenge.scope !== 'files:read') {
    throw new Error('MCP WWW-Authenticate challenge was not parsed');
}

const pkceChallenge = createPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');

if (pkceChallenge !== 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    throw new Error(`MCP PKCE challenge was not generated correctly: ${pkceChallenge}`);

const configPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-mcp-${GLib.uuid_string_random()}.json`,
]);
GLib.file_set_contents(configPath, JSON.stringify({
    mcpServers: {
        'file-mcp': {
            command: gjs,
            args: ['-m', fakeServerPath],
            enabled: false,
        },
    },
}));

const workspace = new WorkspaceManager({
    autoDiscoverSkills: false,
});
workspace.addMcpServer({
    name: 'local-mcp',
    transport: MCP_TRANSPORT_STDIO,
    command: gjs,
    args: ['-m', fakeServerPath],
    enabled: true,
    permissionPolicy: 'allow',
});

const manager = new McpManager({
    workspaceManager: workspace,
    configPath,
    tokenStore: new MemoryMcpTokenStore(),
});
const tools = new ToolManager();
const httpServer = new Soup.Server();
let httpListening = false;
let sawProtocolVersionHeader = false;

function requestJson(message) {
    return JSON.parse(new TextDecoder().decode(message.get_request_body().flatten().get_data()));
}

function setJsonResponse(message, body) {
    message.set_status(Soup.Status.OK, null);
    message.set_response('application/json', Soup.MemoryUse.COPY, JSON.stringify(body));
}

GLib.setenv('NO_PROXY', '127.0.0.1,localhost', true);
GLib.setenv('no_proxy', '127.0.0.1,localhost', true);
GLib.unsetenv('HTTP_PROXY');
GLib.unsetenv('HTTPS_PROXY');
GLib.unsetenv('http_proxy');
GLib.unsetenv('https_proxy');

httpServer.add_handler('/mcp', (_server, message) => {
    message.set_status(Soup.Status.UNAUTHORIZED, null);
    message.get_response_headers().append(
        'WWW-Authenticate',
        'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource", scope="tools:read"',
    );
    message.set_response('application/json', Soup.MemoryUse.COPY, JSON.stringify({
        error: {
            message: 'Authorization required',
        },
    }));
});
httpServer.add_handler('/versioned-mcp', (_server, message) => {
    const request = requestJson(message);

    if (request.method !== 'initialize') {
        const protocolVersion = message.get_request_headers().get_one('MCP-Protocol-Version') ?? '';

        if (protocolVersion !== MCP_PROTOCOL_VERSION) {
            message.set_status(Soup.Status.BAD_REQUEST, null);
            message.set_response('application/json', Soup.MemoryUse.COPY, JSON.stringify({
                error: {
                    message: `Missing MCP-Protocol-Version: ${protocolVersion}`,
                },
            }));
            return;
        }

        sawProtocolVersionHeader = true;
    }

    switch (request.method) {
    case 'initialize':
        setJsonResponse(message, {
            jsonrpc: '2.0',
            id: request.id,
            result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {
                    tools: { listChanged: false },
                },
                serverInfo: {
                    name: 'Versioned MCP',
                    version: '1.0.0',
                },
            },
        });
        break;
    case 'tools/list':
        setJsonResponse(message, {
            jsonrpc: '2.0',
            id: request.id,
            result: {
                tools: [],
            },
        });
        break;
    default:
        setJsonResponse(message, {
            jsonrpc: '2.0',
            id: request.id,
            result: {},
        });
        break;
    }
});

try {
    httpServer.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    httpListening = true;
} catch (error) {
    print(`Cusco MCP HTTP auth smoke skipped: ${error.message}`);
}

try {
    if (!manager.listServers().find((server) => server.source === 'file' && server.name === 'file-mcp'))
        throw new Error('MCP config file server was not loaded');

    if (httpListening) {
        workspace.addMcpServer({
            name: 'auth-mcp',
            transport: MCP_TRANSPORT_HTTP,
            url: `${httpServer.get_uris()[0].to_string().replace(/\/$/, '')}/mcp`,
            enabled: true,
            permissionPolicy: 'allow',
        });
        await manager.refreshServers({ timeoutSeconds: 5 });
        const authServer = manager.listServers().find((item) => item.name === 'auth-mcp');

        if (authServer?.status.state !== 'auth_required')
            throw new Error(`MCP auth-required status was not recorded: ${authServer?.status.message}`);

        if (authServer.status.auth?.scope !== 'tools:read'
            || !authServer.status.auth?.resourceMetadataUrl.includes('oauth-protected-resource')) {
            throw new Error('MCP auth challenge metadata was not preserved');
        }

        workspace.addMcpServer({
            name: 'versioned-mcp',
            transport: MCP_TRANSPORT_HTTP,
            url: `${httpServer.get_uris()[0].to_string().replace(/\/$/, '')}/versioned-mcp`,
            enabled: true,
            permissionPolicy: 'allow',
        });
        manager.reloadConfig();
        const versionedServer = manager.listServers().find((item) => item.name === 'versioned-mcp');

        await manager.refreshServer(versionedServer.key, { timeoutSeconds: 5 });

        if (!sawProtocolVersionHeader)
            throw new Error('MCP HTTP protocol version header was not sent after initialization');
    }

    await manager.refreshTools(tools, { timeoutSeconds: 5 });

    const server = manager.listServers().find((item) => item.name === 'local-mcp');

    if (!server || server.status.state !== 'connected')
        throw new Error(`MCP server did not connect: ${server?.status?.message}`);

    if (server.toolCount !== 1 || server.resourceCount !== 2 || server.promptCount !== 1)
        throw new Error('MCP discovery counts were not recorded');

    const toolNames = tools.listTools().map((tool) => tool.name);

    for (const expected of [
        'mcp__local_mcp__echo',
        'mcp__local_mcp__list_resources',
        'mcp__local_mcp__read_resource',
        'mcp__local_mcp__list_prompts',
        'mcp__local_mcp__get_prompt',
    ]) {
        if (!toolNames.includes(expected))
            throw new Error(`MCP tool was not registered: ${expected}`);
    }

    const echo = await tools.runRequest(
        tools.createRequest('mcp__local_mcp__echo', '{"message":"hello"}'),
        { timeoutSeconds: 5 },
    );

    if (!echo.output.includes('echo: hello') || !echo.output.includes('"ok": true'))
        throw new Error(`MCP tool output was not formatted: ${echo.output}`);

    const resourceList = await tools.runRequest(
        tools.createRequest('mcp__local_mcp__list_resources', ''),
        { timeoutSeconds: 5 },
    );

    if (!resourceList.output.includes('memory://note') || !resourceList.output.includes('memory://{name}'))
        throw new Error('MCP resource list helper failed');

    const resource = await tools.runRequest(
        tools.createRequest('mcp__local_mcp__read_resource', 'memory://note'),
        { timeoutSeconds: 5 },
    );

    if (!resource.output.includes('resource: memory://note'))
        throw new Error('MCP resource read helper failed');

    const prompt = await tools.runRequest(
        tools.createRequest('mcp__local_mcp__get_prompt', '{"name":"review","arguments":{"topic":"MCP"}}'),
        { timeoutSeconds: 5 },
    );

    if (!prompt.output.includes('Review MCP.'))
        throw new Error('MCP prompt helper failed');

    print('Cusco MCP smoke passed');
} finally {
    manager.shutdown();
    httpServer.disconnect();

    if (GLib.file_test(configPath, GLib.FileTest.EXISTS))
        GLib.unlink(configPath);
}
