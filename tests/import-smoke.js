import { APP_ID, CuscoApplication } from '../src/application.js';

if (APP_ID !== 'io.github.stonega.Cusco')
    throw new Error(`Unexpected application id: ${APP_ID}`);

if (typeof CuscoApplication !== 'function')
    throw new Error('CuscoApplication did not import as a class');

print('Cusco import smoke passed');
