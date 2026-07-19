import GLib from 'gi://GLib?version=2.0';

import { ArtifactManager } from '../src/artifacts/manager.js';
import {
    artifactKindForCodeBlock,
    createImageArtifactFromPath,
    extractArtifactsFromMarkdown,
    imageArtifactForToolCall,
    normalizeArtifacts,
} from '../src/chat/artifacts.js';
import { ArtifactFileStore } from '../src/storage/artifactStore.js';

function assertEqual(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const tempRoot = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-artifacts-${GLib.uuid_string_random()}`,
]);
const markdown = [
    '```svg',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    '```',
    '',
    'Body text',
    '',
    '```html',
    '<!doctype html><html><body><h1>Cusco</h1></body></html>',
    '```',
].join('\n');
const artifacts = extractArtifactsFromMarkdown(markdown, {
    directory: tempRoot,
    generatedBy: 'assistant',
});

assertEqual(artifacts.length, 2, 'Extracted artifact count');
assertEqual(artifacts[0].kind, 'svg', 'SVG artifact kind');
assertEqual(artifacts[0].sourceBlockIndex, 0, 'SVG source block index');
assertEqual(artifacts[1].kind, 'html', 'HTML artifact kind');
assertEqual(artifacts[1].sourceBlockIndex, 2, 'HTML source block index');

for (const artifact of artifacts) {
    if (!GLib.file_test(artifact.path, GLib.FileTest.EXISTS))
        throw new Error(`Artifact file was not saved: ${artifact.path}`);
}

assertEqual(artifactKindForCodeBlock({
    type: 'code',
    language: 'xml',
    content: '<svg viewBox="0 0 1 1"></svg>',
}), 'svg', 'XML SVG block detection');

assertEqual(extractArtifactsFromMarkdown('```html\n<p>fragment</p>\n```', {
    directory: tempRoot,
}).length, 0, 'HTML fragment was not promoted');

assertEqual(extractArtifactsFromMarkdown('```svg\n<svg viewBox="0 0 1 1"></svg>\n```', {
    directory: tempRoot,
    maxBytes: 4,
}).length, 0, 'Oversized artifact was not promoted');

const normalized = normalizeArtifacts([{ kind: 'svg', path: artifacts[0].path }]);
assertEqual(normalized[0].mimeType, 'image/svg+xml', 'Normalized SVG MIME type');

const imageArtifact = createImageArtifactFromPath('/tmp/generated.png', { mimeType: 'image/png' });
assertEqual(imageArtifact.kind, 'image', 'Image artifact kind');
assertEqual(imageArtifact.path, '/tmp/generated.png', 'Image artifact path');
assertEqual(imageArtifact.title, 'Image artifact', 'Generic image artifact title');

const toolResultImage = imageArtifactForToolCall({
    name: 'computer_observe',
    imagePath: '/tmp/observation.png',
    mimeType: 'image/png',
});
assertEqual(toolResultImage.title, 'Tool result image', 'Tool result image title');
assertEqual(toolResultImage.generatedBy, 'computer_observe', 'Tool result image source');

const generatedImage = imageArtifactForToolCall({
    name: 'image_gen',
    imagePath: '/tmp/generated.png',
    mimeType: 'image/png',
});
assertEqual(generatedImage.title, 'Generated image', 'Generated image title');

const managedArtifacts = new ArtifactManager({
    store: new ArtifactFileStore({
        root: GLib.build_filenamev([tempRoot, 'managed']),
    }),
});
const managedReferences = extractArtifactsFromMarkdown(markdown, {
    artifactManager: managedArtifacts,
    originConversationId: 'conversation-1',
    generatedBy: 'assistant',
});
assertEqual(managedReferences.length, 2, 'Managed artifact extraction count');
assertEqual(managedReferences[1].kind, 'html', 'Managed HTML reference kind');
assertEqual(managedReferences[1].sourceBlockIndex, 2, 'Managed HTML source block index');
const resolvedHtml = managedArtifacts.resolveReference(managedReferences[1]);
assertEqual(resolvedHtml.artifact.originConversationId, 'conversation-1', 'Managed artifact conversation');
assertEqual(resolvedHtml.artifact.capabilities[0], 'scripts', 'Managed HTML scripts capability');
assertEqual(
    managedArtifacts.readText(resolvedHtml.artifact.id, resolvedHtml.revision.id),
    '<!doctype html><html><body><h1>Cusco</h1></body></html>',
    'Managed HTML source',
);

print('Cusco artifacts smoke passed');
