import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('mcp/client.js');

export const {
    McpClient,
    MCP_TRANSPORT_HTTP,
    MCP_TRANSPORT_STDIO,
} = implementation;
