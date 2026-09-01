import { createMcpManagementTools } from '../src/tools/mcpManagement.js';
import { ToolManager } from '../src/tools/tools.js';

class FakeMcpManager {
    constructor() {
        this.server = null;
        this.connected = false;
        this.lastCall = null;
    }

    upsertFileServer(config) {
        this.server = {
            key: 'file:deepx_code_truth',
            id: 'deepx_code_truth',
            namespace: 'deepx_code_truth',
            source: 'file',
            transport: 'streamable-http',
            authenticated: false,
            status: { state: 'auth_required', message: 'Authorization required.', updatedAt: '' },
            oauth: { scopes: [...(config.oauth?.scopes ?? [])] },
            allowedTools: config.allowedTools ?? null,
            ...config,
        };
        return { ...this.server };
    }

    getServer(reference) {
        if (!this.server || ![this.server.key, this.server.id, this.server.name].includes(reference))
            throw new Error(`Unknown server: ${reference}`);
        return { ...this.server };
    }

    listServers() {
        return this.server ? [{ ...this.server }] : [];
    }

    listServerToolNames() {
        return this.connected ? ['list_code_targets'] : [];
    }

    async refreshTools(toolManager) {
        if (this.connected) {
            toolManager.registerTool({
                name: 'mcp__deepx_code_truth__list_code_targets',
                label: 'List code targets',
                run: async () => 'ready target',
                permissionPolicy: 'allow',
                requiresPermission: false,
            });
        }
    }

    async connectServer() {
        this.connected = true;
        this.server = {
            ...this.server,
            authenticated: true,
            status: { state: 'connected', message: '1 tool.', updatedAt: '' },
        };
        return { ...this.server };
    }

    async callTool(serverKey, toolName, input) {
        this.lastCall = { serverKey, toolName, input: JSON.parse(input) };
        return 'ready target';
    }
}

const manager = new FakeMcpManager();
const toolManager = new ToolManager();
const managementTools = createMcpManagementTools(manager, toolManager);

for (const tool of managementTools)
    toolManager.registerTool(tool);

for (const name of [
    'mcp_server_configure',
    'mcp_server_connect',
    'mcp_server_status',
    'mcp_server_call',
]) {
    if (!toolManager.getTool(name))
        throw new Error(`MCP management tool was not registered: ${name}`);
}

const configure = managementTools.find((tool) => tool.name === 'mcp_server_configure');
const configured = await configure.run(JSON.stringify({
    name: 'deepx-code-truth',
    url: 'https://code-truth-mcp.deepx.fi/mcp',
    oauthScopes: ['code:read'],
    allowedTools: ['list_code_targets'],
    permissionPolicy: 'ask',
}));

if (manager.server.allowedTools?.[0] !== 'list_code_targets'
    || manager.server.oauth?.scopes?.[0] !== 'code:read'
    || !configured.output.includes('auth_required')) {
    throw new Error('MCP configure tool did not retain scope, allowlist, and status');
}

const connect = managementTools.find((tool) => tool.name === 'mcp_server_connect');
const connected = await connect.run('{"server":"deepx-code-truth"}');

if (!connected.output.includes('list_code_targets')
    || !toolManager.getTool('mcp__deepx_code_truth__list_code_targets')) {
    throw new Error('MCP connect tool did not refresh live server tools');
}

const call = managementTools.find((tool) => tool.name === 'mcp_server_call');
const called = await call.run(JSON.stringify({
    server: 'deepx-code-truth',
    tool: 'list_code_targets',
    arguments: {},
}));

if (called.output !== 'ready target'
    || manager.lastCall?.toolName !== 'list_code_targets') {
    throw new Error('MCP generic call tool did not invoke the selected raw server tool');
}

const status = managementTools.find((tool) => tool.name === 'mcp_server_status');
const statusResult = await status.run('{"server":"deepx-code-truth"}');

if (!statusResult.output.includes('"authenticated": true')
    || /accessToken|refreshToken|authorizationCode|clientSecret/.test(statusResult.output)) {
    throw new Error('MCP status tool exposed an invalid or sensitive result');
}

print('Cusco MCP management smoke passed');
