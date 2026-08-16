import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('hooks/manager.js');

export const {
    HookManager,
    createTurnHookContext,
} = implementation;
