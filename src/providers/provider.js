import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('providerRuntime/provider.js');

export const {
    ChatProvider,
    createMessage,
} = implementation;
