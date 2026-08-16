import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('hooks/trustStore.js');

export const { HookTrustStore } = implementation;
