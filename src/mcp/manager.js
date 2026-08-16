import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('mcp/manager.js');

export const { McpManager } = implementation;
