import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('hooks/protocol.js');

export const { reduceHookRuns } = implementation;
