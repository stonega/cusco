import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    ArtifactRevisionConflictError,
    artifactReferenceFor,
    defaultFormatForArtifactKind,
    normalizeArtifactRecord,
    normalizeArtifactReference,
    normalizeArtifactRevision,
} from './model.js';
import { ArtifactFileStore } from '../storage/artifactStore.js';

function now() {
    return new Date().toISOString();
}

function cloneManifest(manifest) {
    return {
        entrypoint: manifest.entrypoint,
        totalBytes: manifest.totalBytes,
        files: manifest.files.map((file) => ({ ...file })),
    };
}

function cloneArtifact(artifact) {
    return artifact ? {
        ...artifact,
        revisionIds: [...artifact.revisionIds],
        capabilities: [...artifact.capabilities],
    } : null;
}

function cloneRevision(revision) {
    return revision ? {
        ...revision,
        manifest: cloneManifest(revision.manifest),
    } : null;
}

function fileExtensionForMimeType(mimeType) {
    switch (String(mimeType ?? '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
        return 'jpg';
    case 'image/webp':
        return 'webp';
    case 'image/gif':
        return 'gif';
    case 'image/svg+xml':
        return 'svg';
    case 'image/png':
        return 'png';
    case 'application/pdf':
        return 'pdf';
    default:
        return 'bin';
    }
}

function defaultFilename(input) {
    const kind = String(input?.kind ?? 'file');
    const format = String(input?.format ?? defaultFormatForArtifactKind(kind)).toLowerCase();

    switch (kind) {
    case 'html':
        return 'index.html';
    case 'svg':
        return 'artifact.svg';
    case 'image':
        return `image.${fileExtensionForMimeType(input?.mimeType)}`;
    case 'document':
        return format === 'markdown' ? 'document.md' : 'document.txt';
    case 'code':
        return `source.${format === 'text' ? 'txt' : format}`;
    case 'data':
        return format === 'csv' ? 'data.csv' : 'data.json';
    case 'chart':
        return 'chart.json';
    case 'diagram':
        return format === 'mermaid' ? 'diagram.mmd' : 'diagram.txt';
    case 'pdf':
        return 'document.pdf';
    default:
        return 'artifact.bin';
    }
}

function normalizedInputFiles(input) {
    if (input?.files && (Array.isArray(input.files) || typeof input.files === 'object'))
        return input.files;

    if (input && Object.hasOwn(input, 'content')) {
        const filename = String(input.filename ?? '').trim() || defaultFilename(input);
        return {
            [filename]: {
                content: input.content,
                mimeType: input.mimeType,
            },
        };
    }

    throw new Error('Artifact content or files are required.');
}

function applyFileChanges(files, changes = []) {
    const nextFiles = { ...files };

    for (const change of Array.isArray(changes) ? changes : []) {
        const path = String(change?.path ?? '').trim();

        if (!path)
            throw new Error('Artifact file change is missing a path.');

        if (change.delete) {
            delete nextFiles[path];
            continue;
        }

        if (!Object.hasOwn(change ?? {}, 'content'))
            throw new Error(`Artifact file change is missing content: ${path}`);

        nextFiles[path] = {
            content: change.content,
            mimeType: change.mimeType,
        };
    }

    return nextFiles;
}

export class ArtifactManager {
    constructor(options = {}) {
        this._store = options.store ?? new ArtifactFileStore(options.storeOptions);
        this._listeners = new Set();
        this._database = this._store.load();
        this._refreshIndexes();
    }

    _refreshIndexes() {
        this._artifacts = new Map(this._database.artifacts.map((artifact) => [artifact.id, artifact]));
        this._revisions = new Map(this._database.revisions.map((revision) => [revision.id, revision]));
    }

    _persist() {
        this._database = {
            version: this._database.version,
            artifacts: [...this._artifacts.values()],
            revisions: [...this._revisions.values()],
        };
        this._store.save(this._database);
    }

    _emit(type, artifact, revision = null) {
        const event = {
            type,
            artifact: cloneArtifact(artifact),
            revision: cloneRevision(revision),
        };

        for (const listener of this._listeners) {
            try {
                listener(event);
            } catch (error) {
                logError(error, 'Artifact change listener failed');
            }
        }
    }

    connectChanged(listener) {
        if (typeof listener !== 'function')
            throw new Error('Artifact change listener must be a function.');

        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    listArtifacts(options = {}) {
        const conversationId = String(options.conversationId ?? '').trim();

        return [...this._artifacts.values()]
            .filter((artifact) => (
                (options.includeArchived || !artifact.archivedAt)
                && (!conversationId || artifact.originConversationId === conversationId)
            ))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .map(cloneArtifact);
    }

    getArtifact(artifactId) {
        return cloneArtifact(this._artifacts.get(String(artifactId ?? '').trim()));
    }

    getRevision(revisionId) {
        return cloneRevision(this._revisions.get(String(revisionId ?? '').trim()));
    }

    getArtifactRevision(artifactId, revisionId = '') {
        const artifact = this._artifacts.get(String(artifactId ?? '').trim());

        if (!artifact)
            return null;

        const selectedRevisionId = String(revisionId ?? '').trim() || artifact.currentRevisionId;
        const revision = this._revisions.get(selectedRevisionId);

        if (!revision || revision.artifactId !== artifact.id)
            return null;

        return {
            artifact: cloneArtifact(artifact),
            revision: cloneRevision(revision),
        };
    }

    resolveReference(reference) {
        const normalizedReference = normalizeArtifactReference(reference);

        if (!normalizedReference)
            return null;

        const resolved = this.getArtifactRevision(
            normalizedReference.artifactId,
            normalizedReference.revisionId,
        );

        return resolved ? {
            ...resolved,
            reference: normalizedReference,
        } : null;
    }

    createArtifact(input = {}, options = {}) {
        const artifactId = String(input.id ?? '').trim() || GLib.uuid_string_random();

        if (this._artifacts.has(artifactId))
            throw new Error(`Artifact already exists: ${artifactId}`);

        const revisionId = GLib.uuid_string_random();
        const timestamp = now();
        const files = normalizedInputFiles(input);
        const writeResult = this._store.writeRevision(artifactId, revisionId, files, {
            entrypoint: input.entrypoint,
        });
        const revision = normalizeArtifactRevision({
            id: revisionId,
            artifactId,
            parentRevisionId: '',
            manifest: writeResult.manifest,
            contentHash: writeResult.contentHash,
            createdBy: options.createdBy ?? input.createdBy ?? input.generatedBy,
            createdAt: timestamp,
            message: options.message ?? input.message,
        });
        const artifact = normalizeArtifactRecord({
            ...input,
            id: artifactId,
            currentRevisionId: revisionId,
            revisionIds: [revisionId],
            originConversationId: options.originConversationId ?? input.originConversationId,
            generatedBy: options.createdBy ?? input.generatedBy,
            createdAt: timestamp,
            updatedAt: timestamp,
            userEdited: (options.createdBy ?? input.createdBy) === 'user',
        });

        this._artifacts.set(artifact.id, artifact);
        this._revisions.set(revision.id, revision);

        try {
            this._persist();
        } catch (error) {
            this._artifacts.delete(artifact.id);
            this._revisions.delete(revision.id);
            this._store.removeUnindexedRevision(artifact.id, revision.id);
            throw error;
        }

        this._emit('created', artifact, revision);
        return {
            artifact: cloneArtifact(artifact),
            revision: cloneRevision(revision),
            reference: artifactReferenceFor(artifact, revision.id, input),
        };
    }

    updateArtifact(artifactId, update = {}, options = {}) {
        const artifact = this._artifacts.get(String(artifactId ?? '').trim());

        if (!artifact)
            throw new Error(`Artifact does not exist: ${artifactId}`);

        const baseRevisionId = String(update.baseRevisionId ?? options.baseRevisionId ?? '').trim();

        if (baseRevisionId && baseRevisionId !== artifact.currentRevisionId) {
            throw new ArtifactRevisionConflictError(
                artifact.id,
                baseRevisionId,
                artifact.currentRevisionId,
            );
        }

        const currentRevision = this._revisions.get(artifact.currentRevisionId);

        if (!currentRevision)
            throw new Error(`Current artifact revision is missing: ${artifact.currentRevisionId}`);

        let files;

        if (update.files) {
            files = update.files;
        } else if (Array.isArray(update.changes)) {
            files = applyFileChanges(
                this._store.readRevisionFiles(artifact.id, currentRevision),
                update.changes,
            );
        } else if (Object.hasOwn(update, 'content')) {
            const entrypoint = update.filename ?? currentRevision.manifest.entrypoint;
            files = this._store.readRevisionFiles(artifact.id, currentRevision);
            files[entrypoint] = {
                content: update.content,
                mimeType: update.mimeType ?? files[entrypoint]?.mimeType ?? artifact.mimeType,
            };
        } else {
            throw new Error('Artifact update requires files, changes, or content.');
        }

        const revisionId = GLib.uuid_string_random();
        const writeResult = this._store.writeRevision(artifact.id, revisionId, files, {
            entrypoint: update.entrypoint
                ?? (Object.hasOwn(update, 'content') && update.filename
                    ? update.filename
                    : currentRevision.manifest.entrypoint),
        });
        const timestamp = now();
        const createdBy = options.createdBy ?? update.createdBy ?? 'assistant';
        const revision = normalizeArtifactRevision({
            id: revisionId,
            artifactId: artifact.id,
            parentRevisionId: currentRevision.id,
            manifest: writeResult.manifest,
            contentHash: writeResult.contentHash,
            createdBy,
            createdAt: timestamp,
            message: options.message ?? update.message,
        });
        const previousArtifact = cloneArtifact(artifact);

        artifact.currentRevisionId = revision.id;
        artifact.revisionIds.push(revision.id);
        artifact.updatedAt = timestamp;
        artifact.userEdited = artifact.userEdited || createdBy === 'user';

        if (String(update.title ?? '').trim())
            artifact.title = String(update.title).trim();

        this._revisions.set(revision.id, revision);

        try {
            this._persist();
        } catch (error) {
            this._artifacts.set(artifact.id, previousArtifact);
            this._revisions.delete(revision.id);
            this._store.removeUnindexedRevision(artifact.id, revision.id);
            throw error;
        }

        this._emit('updated', artifact, revision);
        return {
            artifact: cloneArtifact(artifact),
            revision: cloneRevision(revision),
            reference: artifactReferenceFor(artifact, revision.id, update),
        };
    }

    renameArtifact(artifactId, title) {
        const artifact = this._artifacts.get(String(artifactId ?? '').trim());
        const normalizedTitle = String(title ?? '').trim();

        if (!artifact)
            throw new Error(`Artifact does not exist: ${artifactId}`);

        if (!normalizedTitle)
            throw new Error('Artifact title cannot be empty.');

        const previousTitle = artifact.title;
        const previousUpdatedAt = artifact.updatedAt;
        artifact.title = normalizedTitle;
        artifact.updatedAt = now();

        try {
            this._persist();
        } catch (error) {
            artifact.title = previousTitle;
            artifact.updatedAt = previousUpdatedAt;
            throw error;
        }

        this._emit('renamed', artifact);
        return cloneArtifact(artifact);
    }

    archiveArtifact(artifactId, archived = true) {
        const artifact = this._artifacts.get(String(artifactId ?? '').trim());

        if (!artifact)
            throw new Error(`Artifact does not exist: ${artifactId}`);

        const previousArchivedAt = artifact.archivedAt;
        const previousUpdatedAt = artifact.updatedAt;
        artifact.archivedAt = archived ? now() : '';
        artifact.updatedAt = now();

        try {
            this._persist();
        } catch (error) {
            artifact.archivedAt = previousArchivedAt;
            artifact.updatedAt = previousUpdatedAt;
            throw error;
        }

        this._emit(archived ? 'archived' : 'restored', artifact);
        return cloneArtifact(artifact);
    }

    forkArtifact(artifactId, revisionId = '', options = {}) {
        const resolved = this.getArtifactRevision(artifactId, revisionId);

        if (!resolved)
            throw new Error(`Artifact revision does not exist: ${artifactId}/${revisionId}`);

        const files = this._store.readRevisionFiles(resolved.artifact.id, resolved.revision);
        return this.createArtifact({
            title: options.title ?? `${resolved.artifact.title} copy`,
            kind: resolved.artifact.kind,
            format: resolved.artifact.format,
            mimeType: resolved.artifact.mimeType,
            files,
            entrypoint: resolved.revision.manifest.entrypoint,
            preferredPresentation: resolved.artifact.preferredPresentation,
            capabilities: resolved.artifact.capabilities,
            generatedBy: options.createdBy ?? 'user',
        }, {
            originConversationId: options.originConversationId ?? resolved.artifact.originConversationId,
            createdBy: options.createdBy ?? 'user',
            message: `Forked from ${resolved.artifact.id}/${resolved.revision.id}`,
        });
    }

    importLegacyArtifact(legacyArtifact, options = {}) {
        const existingReference = normalizeArtifactReference(legacyArtifact);

        if (existingReference && this.resolveReference(existingReference))
            return existingReference;

        const legacyId = String(legacyArtifact?.id ?? '').trim();
        const alreadyImported = legacyId ? this._artifacts.get(legacyId) : null;

        if (alreadyImported)
            return artifactReferenceFor(alreadyImported, alreadyImported.currentRevisionId, legacyArtifact);

        const path = String(legacyArtifact?.path ?? '').trim();

        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
            return null;

        const [, contents] = GLib.file_get_contents(path);
        const filename = GLib.path_get_basename(path) || defaultFilename(legacyArtifact);
        const created = this.createArtifact({
            id: legacyArtifact.id,
            title: legacyArtifact.title,
            kind: legacyArtifact.kind,
            format: legacyArtifact.format,
            mimeType: legacyArtifact.mimeType,
            content: contents,
            filename,
            entrypoint: filename,
            preferredPresentation: legacyArtifact.kind === 'html' ? 'panel' : 'inline',
            sourceBlockIndex: legacyArtifact.sourceBlockIndex,
            sourceLanguage: legacyArtifact.sourceLanguage,
            generatedBy: legacyArtifact.generatedBy,
            createdAt: legacyArtifact.createdAt,
        }, {
            originConversationId: options.originConversationId,
            createdBy: legacyArtifact.generatedBy || 'assistant',
            message: 'Imported from the legacy artifact store',
        });

        return artifactReferenceFor(created.artifact, created.revision.id, legacyArtifact);
    }

    filePath(artifactId, revisionId, relativePath = '') {
        const resolved = this.getArtifactRevision(artifactId, revisionId);

        if (!resolved)
            return '';

        const selectedPath = String(relativePath ?? '').trim() || resolved.revision.manifest.entrypoint;
        return this._store.revisionFilePath(artifactId, resolved.revision.id, selectedPath);
    }

    readFile(artifactId, revisionId, relativePath = '') {
        const resolved = this.getArtifactRevision(artifactId, revisionId);

        if (!resolved)
            throw new Error(`Artifact revision does not exist: ${artifactId}/${revisionId}`);

        const selectedPath = String(relativePath ?? '').trim() || resolved.revision.manifest.entrypoint;
        const descriptor = resolved.revision.manifest.files.find((file) => file.path === selectedPath);

        if (!descriptor)
            throw new Error(`Artifact file does not exist in the revision: ${selectedPath}`);

        const contents = this._store.readRevisionFile(artifactId, resolved.revision.id, selectedPath);
        const checksum = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, contents);

        if (descriptor.sha256 && checksum !== descriptor.sha256)
            throw new Error(`Artifact file failed its integrity check: ${selectedPath}`);

        return contents;
    }

    readText(artifactId, revisionId, relativePath = '') {
        return new TextDecoder().decode(this.readFile(artifactId, revisionId, relativePath));
    }

    exportRevision(artifactId, revisionId, targetPath, options = {}) {
        const resolved = this.getArtifactRevision(artifactId, revisionId);
        const normalizedTargetPath = String(targetPath ?? '').trim();

        if (!resolved)
            throw new Error(`Artifact revision does not exist: ${artifactId}/${revisionId}`);

        if (!normalizedTargetPath)
            throw new Error('Artifact export target cannot be empty.');

        const files = resolved.revision.manifest.files;
        const exportAsDirectory = options.asDirectory || files.length > 1;
        const copyFlags = options.overwrite
            ? Gio.FileCopyFlags.OVERWRITE
            : Gio.FileCopyFlags.NONE;

        if (!exportAsDirectory) {
            this.readFile(
                resolved.artifact.id,
                resolved.revision.id,
                files[0].path,
            );
            Gio.File.new_for_path(this.filePath(
                resolved.artifact.id,
                resolved.revision.id,
                files[0].path,
            )).copy(
                Gio.File.new_for_path(normalizedTargetPath),
                copyFlags,
                null,
                null,
            );
            return [normalizedTargetPath];
        }

        for (const file of files) {
            this.readFile(
                resolved.artifact.id,
                resolved.revision.id,
                file.path,
            );
        }

        GLib.mkdir_with_parents(normalizedTargetPath, 0o700);
        const exported = [];

        for (const file of files) {
            const destination = GLib.build_filenamev([
                normalizedTargetPath,
                ...file.path.split('/'),
            ]);

            GLib.mkdir_with_parents(GLib.path_get_dirname(destination), 0o700);
            Gio.File.new_for_path(this.filePath(
                resolved.artifact.id,
                resolved.revision.id,
                file.path,
            )).copy(
                Gio.File.new_for_path(destination),
                copyFlags,
                null,
                null,
            );
            exported.push(destination);
        }

        return exported;
    }
}
