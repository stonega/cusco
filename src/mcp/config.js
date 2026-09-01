import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('mcp/config.js');

export const {
    MCP_CONFIG_APP_ID,
    MCP_LEGACY_PROTOCOL_VERSION,
    MCP_PROTOCOL_VERSION,
    MCP_SUPPORTED_PROTOCOL_VERSIONS,
    MCP_TRANSPORT_STDIO,
    MCP_TRANSPORT_HTTP,
    defaultMcpConfigFilePath,
    sanitizeMcpName,
    normalizeMcpServerConfig,
    parseMcpConfigFile,
    loadMcpConfigFile,
    setMcpConfigFileServerEnabled,
    upsertMcpConfigFileServer,
} = implementation;
