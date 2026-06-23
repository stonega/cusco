import GLib from 'gi://GLib?version=2.0';

import {
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
});
const tools = new ToolManager();

try {
    if (!manager.listServers().find((server) => server.source === 'file' && server.name === 'file-mcp'))
        throw new Error('MCP config file server was not loaded');

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

    if (GLib.file_test(configPath, GLib.FileTest.EXISTS))
        GLib.unlink(configPath);
}
