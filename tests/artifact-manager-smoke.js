import GLib from 'gi://GLib?version=2.0';

import { ArtifactManager } from '../src/artifacts/manager.js';
import {
    ArtifactRevisionConflictError,
    normalizeArtifactReference,
} from '../src/artifacts/model.js';
import {
    ArtifactFileStore,
    normalizeArtifactBundlePath,
} from '../src/storage/artifactStore.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const tempRoot = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-artifact-manager-${GLib.uuid_string_random()}`,
]);
const store = new ArtifactFileStore({ root: tempRoot });
const manager = new ArtifactManager({ store });
const created = manager.createArtifact({
    title: 'Interactive chart',
    kind: 'html',
    format: 'html',
    files: {
        'index.html': '<!doctype html><html><body><script src="app.js"></script></body></html>',
        'app.js': 'document.body.dataset.ready = "true";',
    },
    entrypoint: 'index.html',
    preferredPresentation: 'inline',
    capabilities: ['scripts', 'unknown-capability'],
}, {
    originConversationId: 'conversation-1',
    createdBy: 'assistant',
});

assertEqual(created.artifact.kind, 'html', 'Created artifact kind');
assertEqual(created.revision.manifest.files.length, 2, 'Created artifact file count');
assertEqual(created.reference.artifactId, created.artifact.id, 'Created artifact reference ID');
assertEqual(created.artifact.capabilities.length, 1, 'Unknown capabilities were removed');
assert(
    GLib.file_test(
        store.revisionFilePath(created.artifact.id, created.revision.id, 'index.html'),
        GLib.FileTest.EXISTS,
    ),
    'Created artifact entrypoint was not persisted',
);

const updated = manager.updateArtifact(created.artifact.id, {
    baseRevisionId: created.revision.id,
    changes: [{
        path: 'app.js',
        content: 'document.body.dataset.ready = "updated";',
        mimeType: 'text/javascript',
    }],
}, {
    createdBy: 'user',
});

assertEqual(updated.revision.parentRevisionId, created.revision.id, 'Revision parent');
assertEqual(updated.revision.manifest.files.length, 2, 'Revision update dropped unchanged bundle files');
assert(updated.artifact.userEdited, 'User edit marker was not persisted');
assertEqual(
    manager.readText(updated.artifact.id, updated.revision.id, 'app.js'),
    'document.body.dataset.ready = "updated";',
    'Updated artifact content',
);
assertEqual(
    manager.readText(created.artifact.id, created.revision.id, 'app.js'),
    'document.body.dataset.ready = "true";',
    'Earlier revision was mutated',
);

let conflict = null;

try {
    manager.updateArtifact(created.artifact.id, {
        baseRevisionId: created.revision.id,
        content: 'stale',
    });
} catch (error) {
    conflict = error;
}

assert(conflict instanceof ArtifactRevisionConflictError, 'Stale update did not report a revision conflict');
assertEqual(conflict.actualRevisionId, updated.revision.id, 'Conflict current revision');

const restarted = new ArtifactManager({ store: new ArtifactFileStore({ root: tempRoot }) });
const reloaded = restarted.resolveReference(updated.reference);

assert(reloaded, 'Artifact reference did not resolve after restart');
assertEqual(reloaded.revision.id, updated.revision.id, 'Reloaded artifact revision');
assertEqual(restarted.listArtifacts({ conversationId: 'conversation-1' }).length, 1, 'Conversation artifact list');

const exportRoot = GLib.build_filenamev([tempRoot, 'exported-site']);
const exportedFiles = restarted.exportRevision(
    updated.artifact.id,
    updated.revision.id,
    exportRoot,
    { asDirectory: true },
);
assertEqual(exportedFiles.length, 2, 'Exported artifact file count');
assert(
    GLib.file_test(GLib.build_filenamev([exportRoot, 'index.html']), GLib.FileTest.EXISTS),
    'Artifact bundle entrypoint was not exported',
);

const forked = restarted.forkArtifact(created.artifact.id, created.revision.id, {
    originConversationId: 'conversation-2',
});
assert(forked.artifact.id !== created.artifact.id, 'Fork reused the original artifact ID');
assertEqual(
    restarted.readText(forked.artifact.id, forked.revision.id, 'app.js'),
    'document.body.dataset.ready = "true";',
    'Fork did not use the selected revision',
);

restarted.archiveArtifact(forked.artifact.id);
assertEqual(restarted.listArtifacts({ conversationId: 'conversation-2' }).length, 0, 'Archived artifact remained visible');
assertEqual(
    restarted.listArtifacts({ conversationId: 'conversation-2', includeArchived: true }).length,
    1,
    'Archived artifact was not retained',
);

const legacyPath = GLib.build_filenamev([tempRoot, 'legacy.svg']);
GLib.file_set_contents(legacyPath, '<svg viewBox="0 0 1 1"></svg>');
const legacyReference = restarted.importLegacyArtifact({
    id: GLib.uuid_string_random(),
    kind: 'svg',
    title: 'Legacy SVG',
    mimeType: 'image/svg+xml',
    path: legacyPath,
    sourceBlockIndex: 3,
    generatedBy: 'assistant',
}, {
    originConversationId: 'conversation-1',
});

assert(normalizeArtifactReference(legacyReference), 'Legacy artifact did not produce a managed reference');
assertEqual(legacyReference.sourceBlockIndex, 3, 'Legacy source block index was lost');

let rejectedTraversal = false;

try {
    normalizeArtifactBundlePath('../secret.txt');
} catch (_error) {
    rejectedTraversal = true;
}

assert(rejectedTraversal, 'Artifact path traversal was accepted');

let rejectedManifest = false;

try {
    restarted.createArtifact({
        title: 'Reserved file',
        kind: 'file',
        files: { 'manifest.json': '{}' },
    });
} catch (_error) {
    rejectedManifest = true;
}

assert(rejectedManifest, 'Reserved artifact manifest path was accepted');

const corruptedPath = restarted.filePath(updated.artifact.id, updated.revision.id, 'app.js');
GLib.file_set_contents(corruptedPath, 'corrupted');
let rejectedCorruption = false;

try {
    restarted.readText(updated.artifact.id, updated.revision.id, 'app.js');
} catch (_error) {
    rejectedCorruption = true;
}

assert(rejectedCorruption, 'Corrupted artifact content passed its integrity check');

const corruptedExportRoot = GLib.build_filenamev([tempRoot, 'corrupted-export']);
let rejectedCorruptedExport = false;

try {
    restarted.exportRevision(
        updated.artifact.id,
        updated.revision.id,
        corruptedExportRoot,
        { asDirectory: true },
    );
} catch (_error) {
    rejectedCorruptedExport = true;
}

assert(rejectedCorruptedExport, 'Corrupted artifact content was exported');
assert(
    !GLib.file_test(corruptedExportRoot, GLib.FileTest.EXISTS),
    'Corrupted artifact export left a partial directory',
);

print('Cusco artifact manager smoke passed');
