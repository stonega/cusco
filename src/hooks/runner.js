import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('hooks/runner.js');

export const { runHookCommand } = implementation;
