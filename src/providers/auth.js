import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('providerAuth/index.js');

export const {
    createDefaultProviderAuthManager,
    createPkceChallenge,
    listProviderAuthMethods,
    MemoryProviderTokenStore,
    ProviderAuthManager,
    SecretServiceProviderTokenStore,
} = implementation;
