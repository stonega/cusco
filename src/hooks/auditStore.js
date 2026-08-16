import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('hooks/auditStore.js');

export const { HookAuditStore } = implementation;
