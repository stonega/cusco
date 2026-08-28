import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import {
    authorizeMcpServer,
    createPkceChallenge,
    MemoryMcpTokenStore,
    parseWwwAuthenticate,
    refreshMcpToken,
    shouldRefreshMcpToken,
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
            bearerTokenEnvVar: 'REMOTE_MCP_TOKEN',
            headers: {
                Authorization: 'Bearer test',
            },
            headerEnv: {
                'X-Workspace': 'MCP_WORKSPACE',
            },
            oauth_resource: 'https://example.test/mcp',
            oauth: {
                client_id: 'configured-client',
                client_secret_env_var: 'REMOTE_MCP_CLIENT_SECRET',
                token_endpoint_auth_method: 'client_secret_post',
                callback_url: 'http://127.0.0.1:32123/callback',
                callback_port: 32123,
                scope: 'tools:read resources:read',
            },
        },
        local: {
            command: gjs,
            args: ['-m', fakeServerPath],
            envPassthrough: ['PATH', 'HOME'],
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

if (parsed.find((server) => server.id === 'remote')?.bearerTokenEnvVar !== 'REMOTE_MCP_TOKEN'
    || parsed.find((server) => server.id === 'remote')?.headerEnv?.['X-Workspace'] !== 'MCP_WORKSPACE'
    || parsed.find((server) => server.id === 'local')?.envPassthrough?.length !== 2) {
    throw new Error('Environment-backed MCP configuration was not normalized');
}

const parsedRemoteOauth = parsed.find((server) => server.id === 'remote')?.oauth;

if (parsedRemoteOauth?.resource !== 'https://example.test/mcp'
    || parsedRemoteOauth?.clientId !== 'configured-client'
    || parsedRemoteOauth?.clientSecretEnvVar !== 'REMOTE_MCP_CLIENT_SECRET'
    || parsedRemoteOauth?.tokenEndpointAuthMethod !== 'client_secret_post'
    || parsedRemoteOauth?.callbackPort !== 32123
    || parsedRemoteOauth?.scopes?.join(' ') !== 'tools:read resources:read') {
    throw new Error('MCP OAuth configuration was not normalized');
}

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
    envPassthrough: ['PATH'],
    enabled: true,
    permissionPolicy: 'allow',
});

const managerTokenStore = new MemoryMcpTokenStore();
const manager = new McpManager({
    workspaceManager: workspace,
    configPath,
    tokenStore: managerTokenStore,
});
if (manager.listServers().find((server) => server.name === 'local-mcp')?.envPassthrough?.[0] !== 'PATH')
    throw new Error('Workspace MCP environment passthrough was not retained');
const tools = new ToolManager();
const httpServer = new Soup.Server();
let httpListening = false;
let sawEnvironmentBackedHeaders = false;
let sawProtocolVersionHeader = false;
let oauthRegistration = null;
let oauthAuthorizationUrl = '';
let oauthTokenExchange = null;
let oauthRefreshExchange = null;
let oauthBasicAuthorization = '';
let oauthBasicExchange = null;
let managerUsedRefreshedToken = false;

function requestJson(message) {
    return JSON.parse(new TextDecoder().decode(message.get_request_body().flatten().get_data()));
}

function setJsonResponse(message, body) {
    message.set_status(Soup.Status.OK, null);
    message.set_response('application/json', Soup.MemoryUse.COPY, JSON.stringify(body));
}

function requestText(message) {
    return new TextDecoder().decode(message.get_request_body().flatten().get_data());
}

function requestForm(message) {
    return Object.fromEntries(requestText(message).split('&').filter(Boolean).map((entry) => {
        const [name, value = ''] = entry.split('=');
        return [
            GLib.uri_unescape_string(name.replace(/\+/g, '%20'), null),
            GLib.uri_unescape_string(value.replace(/\+/g, '%20'), null),
        ];
    }));
}

function oauthBaseUrl() {
    return httpServer.get_uris()[0].to_string().replace(/\/$/, '');
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
    const environmentHeader = message.get_request_headers().get_one('X-MCP-Test') ?? '';
    const authorizationHeader = message.get_request_headers().get_one('Authorization') ?? '';

    if (environmentHeader === 'from-environment'
        && authorizationHeader === 'Bearer environment-token') {
        sawEnvironmentBackedHeaders = true;
    }

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
httpServer.add_handler('/.well-known/oauth-protected-resource/oauth-mcp', (_server, message) => {
    setJsonResponse(message, {
        resource: `${oauthBaseUrl()}/oauth-mcp`,
        authorization_servers: [oauthBaseUrl()],
        scopes_supported: ['mcp:connect'],
    });
});
httpServer.add_handler('/.well-known/oauth-authorization-server', (_server, message) => {
    setJsonResponse(message, {
        issuer: oauthBaseUrl(),
        authorization_endpoint: `${oauthBaseUrl()}/oauth/authorize`,
        token_endpoint: `${oauthBaseUrl()}/oauth/token`,
        registration_endpoint: `${oauthBaseUrl()}/oauth/register`,
        grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        scopes_supported: ['mcp:connect'],
    });
});
httpServer.add_handler('/oauth/register', (_server, message) => {
    oauthRegistration = requestJson(message);
    setJsonResponse(message, {
        client_id: 'dynamic-client',
        client_secret: 'dynamic-secret',
        token_endpoint_auth_method: 'client_secret_post',
    });
});
httpServer.add_handler('/oauth/token', (_server, message) => {
    const form = requestForm(message);

    if (form.code === 'basic-authorization-code') {
        oauthBasicAuthorization = message.get_request_headers().get_one('Authorization') ?? '';
        oauthBasicExchange = form;
        setJsonResponse(message, {
            access_token: 'basic-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'mcp:connect',
        });
        return;
    }

    if (form.grant_type === 'refresh_token') {
        oauthRefreshExchange = form;
        setJsonResponse(message, {
            access_token: 'refreshed-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'mcp:connect',
        });
        return;
    }

    oauthTokenExchange = form;
    setJsonResponse(message, {
        access_token: 'initial-access-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        expires_in: 1,
        scope: 'mcp:connect',
    });
});
httpServer.add_handler('/refreshing-mcp', (_server, message) => {
    const request = requestJson(message);
    const authorization = message.get_request_headers().get_one('Authorization') ?? '';

    if (authorization === 'Bearer refreshed-access-token')
        managerUsedRefreshedToken = true;
    else {
        message.set_status(Soup.Status.UNAUTHORIZED, null);
        message.get_response_headers().append('WWW-Authenticate', 'Bearer scope="mcp:connect"');
        message.set_response('application/json', Soup.MemoryUse.COPY, JSON.stringify({
            error: { message: 'Authorization required' },
        }));
        return;
    }

    setJsonResponse(message, {
        jsonrpc: '2.0',
        id: request.id,
        result: request.method === 'initialize'
            ? {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: 'Refreshing MCP', version: '1.0.0' },
            }
            : request.method === 'tools/list'
                ? { tools: [] }
                : request.method === 'resources/list'
                    ? { resources: [] }
                    : request.method === 'resources/templates/list'
                        ? { resourceTemplates: [] }
                        : request.method === 'prompts/list'
                            ? { prompts: [] }
                            : {},
    });
});

try {
    httpServer.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    httpListening = true;
} catch (error) {
    print(`Cusco MCP HTTP auth smoke skipped: ${error.message}`);
}

try {
    let fileServer = manager.listServers().find((server) => server.source === 'file' && server.name === 'file-mcp');

    if (!fileServer)
        throw new Error('MCP config file server was not loaded');

    manager.setServerEnabled(fileServer.key, true);
    fileServer = manager.listServers().find((server) => server.source === 'file' && server.name === 'file-mcp');

    if (!fileServer?.enabled)
        throw new Error('MCP config file server was not enabled through manager');

    manager.setServerEnabled(fileServer.key, false);
    fileServer = manager.listServers().find((server) => server.source === 'file' && server.name === 'file-mcp');

    if (fileServer?.enabled)
        throw new Error('MCP config file server was not disabled through manager');

    if (httpListening) {
        const oauthTokenStore = new MemoryMcpTokenStore();
        const oauthServer = {
            key: 'test:oauth-mcp',
            id: 'oauth-mcp',
            name: 'OAuth MCP',
            transport: MCP_TRANSPORT_HTTP,
            url: `${oauthBaseUrl()}/oauth-mcp`,
            oauth: {
                resource: `${oauthBaseUrl()}/oauth-mcp`,
                scopes: [],
            },
        };
        let callbackClosed = false;
        const token = await authorizeMcpServer(oauthServer, {}, oauthTokenStore, {
            timeoutSeconds: 5,
            createCallbackListener: () => ({
                redirectUri: 'http://127.0.0.1:32123/callback',
                promise: Promise.resolve({ code: 'authorization-code' }),
                close: () => {
                    callbackClosed = true;
                },
            }),
            openUri: async (url) => {
                oauthAuthorizationUrl = url;
            },
        });

        if (oauthRegistration?.token_endpoint_auth_method !== 'client_secret_post'
            || !oauthRegistration?.grant_types?.includes('refresh_token')) {
            throw new Error('MCP OAuth registration did not negotiate confidential client authentication');
        }
        if (oauthTokenExchange?.client_id !== 'dynamic-client'
            || oauthTokenExchange?.client_secret !== 'dynamic-secret'
            || oauthTokenExchange?.resource !== oauthServer.url
            || !oauthTokenExchange?.code_verifier) {
            throw new Error('MCP OAuth token exchange did not include client authentication, resource, and PKCE');
        }
        if (!oauthAuthorizationUrl.includes('code_challenge=')
            || !oauthAuthorizationUrl.includes('scope=mcp%3Aconnect')
            || !callbackClosed
            || token.accessToken !== 'initial-access-token'
            || token.refreshToken !== 'refresh-token') {
            throw new Error('MCP OAuth authorization result was incomplete');
        }
        if (!shouldRefreshMcpToken(token, {
            nowMilliseconds: Date.parse(token.expiresAt),
            skewMilliseconds: 0,
        })) {
            throw new Error('Expiring MCP OAuth token was not detected');
        }

        const refreshed = await refreshMcpToken(oauthServer, token, oauthTokenStore, {
            timeoutSeconds: 5,
        });

        if (oauthRefreshExchange?.refresh_token !== 'refresh-token'
            || oauthRefreshExchange?.client_secret !== 'dynamic-secret'
            || refreshed.accessToken !== 'refreshed-access-token'
            || refreshed.refreshToken !== 'refresh-token'
            || oauthTokenStore.lookup(oauthServer.key)?.accessToken !== 'refreshed-access-token') {
            throw new Error('MCP OAuth refresh token flow failed');
        }

        GLib.setenv('CUSCO_MCP_BASIC_SECRET', 'configured-secret', true);
        const basicServer = {
            ...oauthServer,
            key: 'test:oauth-basic',
            name: 'OAuth Basic MCP',
            oauth: {
                ...oauthServer.oauth,
                clientId: 'configured-client',
                clientSecretEnvVar: 'CUSCO_MCP_BASIC_SECRET',
                tokenEndpointAuthMethod: 'client_secret_basic',
            },
        };
        const basicToken = await authorizeMcpServer(basicServer, {}, oauthTokenStore, {
            timeoutSeconds: 5,
            createCallbackListener: () => ({
                redirectUri: 'http://127.0.0.1:32123/callback',
                promise: Promise.resolve({ code: 'basic-authorization-code' }),
                close: () => {},
            }),
            openUri: async () => {},
        });
        const expectedBasic = GLib.base64_encode(
            new TextEncoder().encode('configured-client:configured-secret'),
        );

        if (oauthBasicAuthorization !== `Basic ${expectedBasic}`
            || oauthBasicExchange?.client_secret
            || basicToken.accessToken !== 'basic-access-token'
            || basicToken.clientSecret
            || basicToken.clientSecretEnvVar !== 'CUSCO_MCP_BASIC_SECRET') {
            throw new Error('Configured MCP OAuth client_secret_basic flow failed');
        }

        workspace.addMcpServer({
            id: 'refreshing-mcp',
            name: 'refreshing-mcp',
            transport: MCP_TRANSPORT_HTTP,
            url: `${oauthBaseUrl()}/refreshing-mcp`,
            enabled: true,
            permissionPolicy: 'allow',
        });
        manager.reloadConfig();
        const refreshingServer = manager.listServers()
            .find((item) => item.id === 'refreshing-mcp');
        managerTokenStore.store(refreshingServer.key, refreshingServer.name, {
            version: 2,
            accessToken: 'expired-access-token',
            refreshToken: 'refresh-token',
            tokenType: 'Bearer',
            scope: 'mcp:connect',
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            resource: refreshingServer.url,
            authorizationServer: oauthBaseUrl(),
            tokenEndpoint: `${oauthBaseUrl()}/oauth/token`,
            clientId: 'dynamic-client',
            clientSecret: 'dynamic-secret',
            clientSecretEnvVar: '',
            tokenEndpointAuthMethod: 'client_secret_post',
            registrationType: 'dynamic',
        });
        await manager.refreshServer(refreshingServer.key, { timeoutSeconds: 5 });

        if (!managerUsedRefreshedToken
            || manager.listServers().find((item) => item.key === refreshingServer.key)
                ?.status?.state !== 'connected') {
            throw new Error('MCP manager did not refresh an expired token before connecting');
        }

        manager.clearServerAuthorization(refreshingServer.key);
        if (manager.listServers().find((item) => item.key === refreshingServer.key)?.authenticated)
            throw new Error('MCP sign out did not clear stored authorization');

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
            bearerTokenEnvVar: 'CUSCO_MCP_TEST_TOKEN',
            headerEnv: {
                'X-MCP-Test': 'CUSCO_MCP_TEST_HEADER',
            },
            enabled: true,
            permissionPolicy: 'allow',
        });
        GLib.setenv('CUSCO_MCP_TEST_TOKEN', 'environment-token', true);
        GLib.setenv('CUSCO_MCP_TEST_HEADER', 'from-environment', true);
        manager.reloadConfig();
        const versionedServer = manager.listServers().find((item) => item.name === 'versioned-mcp');

        await manager.refreshServer(versionedServer.key, { timeoutSeconds: 5 });

        if (!sawProtocolVersionHeader)
            throw new Error('MCP HTTP protocol version header was not sent after initialization');
        if (!sawEnvironmentBackedHeaders)
            throw new Error('MCP HTTP environment-backed headers were not resolved');
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

    const echoTool = tools.getTool('mcp__local_mcp__echo');

    if (echoTool.inputSchema?.properties?.message?.type !== 'string')
        throw new Error('MCP tool input schema was not preserved');

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
