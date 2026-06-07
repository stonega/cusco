import { APP_ID, CuscoApplication } from '../src/application.js';
import { MockProvider } from '../src/providers/mockProvider.js';

if (APP_ID !== 'io.github.stonega.Cusco')
    throw new Error(`Unexpected application id: ${APP_ID}`);

if (typeof CuscoApplication !== 'function')
    throw new Error('CuscoApplication did not import as a class');

const provider = new MockProvider();

if (provider.id !== 'mock')
    throw new Error(`Unexpected provider id: ${provider.id}`);

print('Cusco import smoke passed');
