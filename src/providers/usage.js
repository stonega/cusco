import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('providerRuntime/usage.js');

export const { normalizeTokenUsage } = implementation;
