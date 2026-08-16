import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('mcp/auth.js');

export const {
    canonicalMcpResourceUri,
    parseWwwAuthenticate,
    createMcpAuthRequiredError,
    isMcpAuthRequiredStatus,
    createPkceChallenge,
    SecretServiceMcpTokenStore,
    MemoryMcpTokenStore,
    createDefaultMcpTokenStore,
    authorizeMcpServer,
} = implementation;
