import GLib from 'gi://GLib?version=2.0';

import { ArtifactManager } from '../src/artifacts/manager.js';
import { ArtifactFileStore } from '../src/storage/artifactStore.js';
import { createArtifactTools } from '../src/tools/artifacts.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function toolByName(tools, name) {
    const tool = tools.find((candidate) => candidate.name === name);

    if (!tool)
        throw new Error(`Missing artifact tool: ${name}`);

    return tool;
}

const root = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-artifact-tools-${GLib.uuid_string_random()}`,
]);
const manager = new ArtifactManager({ store: new ArtifactFileStore({ root }) });
let presentedReference = null;
const tools = createArtifactTools(manager, {
    getConversationId: () => 'conversation-1',
    onPresent: (reference) => {
        presentedReference = reference;
    },
});
const createTool = toolByName(tools, 'artifact_create');
const createResult = createTool.run(JSON.stringify({
    title: 'Tool site',
    kind: 'html',
    files: {
        'index.html': '<!doctype html><html><body>Hello</body></html>',
        'app.js': 'console.log("hello")',
    },
    entrypoint: 'index.html',
    preferredPresentation: 'panel',
    capabilities: ['scripts', 'network'],
}));
const reference = createResult.artifacts[0];
const created = manager.resolveReference(reference);

assert(created, 'Create tool did not persist an artifact');
assert(created.artifact.originConversationId === 'conversation-1', 'Create tool lost the conversation owner');
assert(created.artifact.capabilities.includes('scripts'), 'Create tool lost the scripts capability');
assert(!created.artifact.capabilities.includes('network'), 'Create tool granted network access');

const updateResult = toolByName(tools, 'artifact_update').run(JSON.stringify({
    artifactId: reference.artifactId,
    baseRevisionId: reference.revisionId,
    changes: [{ path: 'index.html', content: '<!doctype html><html><body>Updated</body></html>' }],
}));
const updatedReference = updateResult.artifacts[0];

assert(updatedReference.revisionId !== reference.revisionId, 'Update tool did not create a revision');
assert(
    manager.readText(updatedReference.artifactId, updatedReference.revisionId, 'index.html').includes('Updated'),
    'Update tool did not persist the changed file',
);

const readResult = toolByName(tools, 'artifact_read').run(JSON.stringify({
    artifactId: updatedReference.artifactId,
    revisionId: updatedReference.revisionId,
    path: 'index.html',
}));
assert(readResult.output.includes('Updated'), 'Read tool did not return text content');

const pdfResult = createTool.run(JSON.stringify({
    title: 'Binary PDF',
    kind: 'pdf',
    mimeType: 'application/pdf',
    filename: 'document.pdf',
    content: 'JVBERi0xLjQK',
    encoding: 'base64',
}));
const pdfReference = pdfResult.artifacts[0];
assert(
    new TextDecoder().decode(manager.readFile(
        pdfReference.artifactId,
        pdfReference.revisionId,
    )) === '%PDF-1.4\n',
    'Create tool did not decode binary artifact content',
);

let rejectedInvalidBase64 = false;

try {
    createTool.run(JSON.stringify({
        title: 'Invalid binary',
        kind: 'file',
        content: 'not-base64',
        encoding: 'base64',
    }));
} catch (_error) {
    rejectedInvalidBase64 = true;
}

assert(rejectedInvalidBase64, 'Create tool accepted invalid base64 content');

const listResult = toolByName(tools, 'artifact_list').run('{}');
assert(listResult.output.includes('Tool site'), 'List tool did not return the conversation artifact');

const otherConversationArtifact = manager.createArtifact({
    title: 'Private to another chat',
    kind: 'document',
    content: 'not available here',
}, {
    originConversationId: 'conversation-2',
});
let rejectedCrossConversationRead = false;

try {
    toolByName(tools, 'artifact_read').run(JSON.stringify({
        artifactId: otherConversationArtifact.artifact.id,
    }));
} catch (_error) {
    rejectedCrossConversationRead = true;
}

assert(rejectedCrossConversationRead, 'Artifact read crossed the conversation boundary');

toolByName(tools, 'artifact_present').run(JSON.stringify({
    artifactId: updatedReference.artifactId,
    revisionId: updatedReference.revisionId,
}));
assert(presentedReference?.revisionId === updatedReference.revisionId, 'Present tool did not emit its reference');

print('Cusco artifact tools smoke passed');
