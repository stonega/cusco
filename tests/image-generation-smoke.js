import GLib from 'gi://GLib?version=2.0';

import {
    buildGeminiImageGenerationBody,
    buildOpenAiImageGenerationBody,
    buildZaiImageGenerationBody,
    createImageGenerationTool,
    extractImageResponsePayload,
    generateImageForProvider,
} from '../src/providers/imageGeneration.js';
import { ProviderConfigStore } from '../src/providers/config.js';
import { MemoryApiKeyStore } from '../src/secrets/apiKeyStore.js';

function assertEqual(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const openAiBody = buildOpenAiImageGenerationBody('Draw Cusco', 'gpt-image-2');
assertEqual(openAiBody.model, 'gpt-image-2', 'OpenAI image model');
assertEqual(openAiBody.prompt, 'Draw Cusco', 'OpenAI image prompt');

const geminiBody = buildGeminiImageGenerationBody('Draw Machu Picchu', 'gemini-3.1-flash-image');
assertEqual(geminiBody.model, 'gemini-3.1-flash-image', 'Gemini image model');
assertEqual(geminiBody.input[0].text, 'Draw Machu Picchu', 'Gemini image prompt');

const zaiBody = buildZaiImageGenerationBody('Draw a poster', 'glm-image');
assertEqual(zaiBody.model, 'glm-image', 'Z.ai image model');
assertEqual(zaiBody.size, '1280x1280', 'Z.ai default size');

const geminiPayload = extractImageResponsePayload({
    interaction: {
        output_image: {
            data: GLib.base64_encode(new TextEncoder().encode('gemini-image')),
            mime_type: 'image/png',
        },
    },
});
assertEqual(geminiPayload.type, 'base64', 'Gemini image payload type');

const geminiStepsPayload = extractImageResponsePayload({
    steps: [{
        type: 'model_output',
        content: [{
            type: 'image',
            data: GLib.base64_encode(new TextEncoder().encode('gemini-steps-image')),
            mime_type: 'image/png',
        }],
    }],
});
assertEqual(geminiStepsPayload.type, 'base64', 'Gemini steps image payload type');

const zaiPayload = extractImageResponsePayload({
    data: [{ url: 'https://example.invalid/image.png' }],
});
assertEqual(zaiPayload.type, 'url', 'Z.ai image payload type');

const generated = await generateImageForProvider(
    {
        id: 'zai',
        name: 'Z.ai',
        imageApiFormat: 'zai-images',
        apiKey: 'zai-key',
        baseUrl: 'https://api.z.ai/api/paas/v4',
    },
    { id: 'glm-image', name: 'GLM-Image' },
    'A native GNOME app icon',
    {
        requestJson: async (url, headers, body) => {
            assertEqual(url, 'https://api.z.ai/api/paas/v4/images/generations', 'Z.ai image endpoint');
            assertEqual(headers.Authorization, 'Bearer zai-key', 'Z.ai auth header');
            assertEqual(body.model, 'glm-image', 'Z.ai request model');
            return {
                data: [{ url: 'https://example.invalid/generated.png' }],
            };
        },
        downloadBytes: async (url) => {
            assertEqual(url, 'https://example.invalid/generated.png', 'Z.ai image download URL');
            return {
                bytes: new TextEncoder().encode('png-data'),
                mimeType: 'image/png',
            };
        },
        saveImage: async (bytes, options) => {
            assertEqual(new TextDecoder().decode(bytes), 'png-data', 'Saved image bytes');
            assertEqual(options.modelId, 'glm-image', 'Saved image model metadata');
            return {
                path: '/tmp/generated-image.png',
                mimeType: options.mimeType,
            };
        },
    },
);

assertEqual(generated.imagePath, '/tmp/generated-image.png', 'Generated image path');
assertEqual(generated.providerId, 'zai', 'Generated image provider id');
assertEqual(generated.artifacts[0].kind, 'image', 'Generated image artifact kind');
assertEqual(generated.artifacts[0].path, '/tmp/generated-image.png', 'Generated image artifact path');

const providerConfigs = new ProviderConfigStore(undefined, {
    settings: null,
    apiKeyStore: new MemoryApiKeyStore({ zai: 'zai-key' }),
    envLookup: () => '',
});
providerConfigs.setDefaultImageSelection('zai', 'glm-image');
const tool = createImageGenerationTool(providerConfigs, {
    requestJson: async (_url, _headers, body) => {
        assertEqual(body.model, 'glm-image', 'Standalone image provider model');
        return {
            data: [{ url: 'https://example.invalid/generated.png' }],
        };
    },
    downloadBytes: async () => ({
        bytes: new TextEncoder().encode('png-data'),
        mimeType: 'image/png',
    }),
    saveImage: async () => ({
        path: '/tmp/tool-image.png',
        mimeType: 'image/png',
    }),
});
const toolResult = await tool.run('A quiet desktop chat app', { providerId: 'openai' });

assertEqual(toolResult.imagePath, '/tmp/tool-image.png', 'Tool image path');
assertEqual(toolResult.modelId, 'glm-image', 'Tool image model');
assertEqual(toolResult.providerId, 'zai', 'Tool standalone image provider');
assertEqual(toolResult.artifacts[0].kind, 'image', 'Tool image artifact kind');

print('Cusco image generation smoke passed');
