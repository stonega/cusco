import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('toolRuntime/permissions.js');

export const {
    TOOL_PERMISSION_ALLOW,
    TOOL_PERMISSION_ASK,
    TOOL_PERMISSION_DENY,
    normalizePermissionPolicy,
    createToolPermissionDecision,
} = implementation;
