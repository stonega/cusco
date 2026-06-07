import { createMessage } from '../src/providers/provider.js';
import { MockProvider } from '../src/providers/mockProvider.js';

const provider = new MockProvider();
let streamedText = '';

for await (const chunk of provider.streamChat([createMessage('user', 'hello')]))
    streamedText += chunk;

if (!streamedText.includes('hello'))
    throw new Error(`Mock provider did not include prompt in response: ${streamedText}`);

print('Cusco mock provider smoke passed');
