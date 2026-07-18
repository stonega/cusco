import GLib from 'gi://GLib?version=2.0';

export const ARTIFACT_DATABASE_VERSION = 1;
export const ARTIFACT_PRESENTATIONS = ['inline', 'panel'];
export const ARTIFACT_CAPABILITIES = [
    'scripts',
    'network',
    'persistent-storage',
    'clipboard',
    'host-actions',
];
export const ARTIFACT_KINDS = [
    'document',
    'code',
    'data',
    'chart',
    'diagram',
    'image',
    'svg',
    'html',
    'pdf',
    'file',
];

const DEFAULT_MIME_TYPES = {
    document: 'text/markdown',
    code: 'text/plain',
    data: 'application/json',
    chart: 'application/vnd.cusco.chart+json',
    diagram: 'text/plain',
    image: 'image/png',
    svg: 'image/svg+xml',
    html: 'text/html',
    pdf: 'application/pdf',
    file: 'application/octet-stream',
};

const DEFAULT_FORMATS = {
    document: 'markdown',
    code: 'text',
    data: 'json',
    chart: 'cusco-chart',
    diagram: 'mermaid',
    image: 'png',
    svg: 'svg',
    html: 'html',
    pdf: 'pdf',
    file: 'binary',
};

function now() {
    return new Date().toISOString();
}

function normalizeString(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function normalizeStringList(values, allowed = null) {
    const normalized = Array.isArray(values)
        ? values.map((value) => normalizeString(value)).filter(Boolean)
        : [];
    const unique = [...new Set(normalized)];

    return allowed
        ? unique.filter((value) => allowed.includes(value))
        : unique;
}

export function normalizeArtifactKind(value, fallback = 'file') {
    const kind = normalizeString(value).toLowerCase();
    return ARTIFACT_KINDS.includes(kind) ? kind : fallback;
}

export function defaultMimeTypeForArtifactKind(kind) {
    return DEFAULT_MIME_TYPES[normalizeArtifactKind(kind)] ?? DEFAULT_MIME_TYPES.file;
}

export function defaultFormatForArtifactKind(kind) {
    return DEFAULT_FORMATS[normalizeArtifactKind(kind)] ?? DEFAULT_FORMATS.file;
}

export function normalizeArtifactPresentation(value, fallback = 'panel') {
    const presentation = normalizeString(value).toLowerCase();
    return ARTIFACT_PRESENTATIONS.includes(presentation) ? presentation : fallback;
}

export function normalizeArtifactManifest(manifest = {}) {
    const files = Array.isArray(manifest?.files)
        ? manifest.files.map((file) => ({
            path: normalizeString(file?.path),
            mimeType: normalizeString(file?.mimeType, 'application/octet-stream'),
            size: Math.max(0, Number(file?.size) || 0),
            sha256: normalizeString(file?.sha256),
        })).filter((file) => file.path)
        : [];
    const entrypoint = normalizeString(manifest?.entrypoint, files[0]?.path ?? '');

    return {
        entrypoint,
        files,
        totalBytes: Math.max(
            0,
            Number(manifest?.totalBytes) || files.reduce((sum, file) => sum + file.size, 0),
        ),
    };
}

export function normalizeArtifactRevision(revision = {}) {
    const artifactId = normalizeString(revision?.artifactId);

    if (!artifactId)
        return null;

    return {
        id: normalizeString(revision?.id, GLib.uuid_string_random()),
        artifactId,
        parentRevisionId: normalizeString(revision?.parentRevisionId),
        manifest: normalizeArtifactManifest(revision?.manifest),
        contentHash: normalizeString(revision?.contentHash),
        createdBy: normalizeString(revision?.createdBy, 'assistant'),
        createdAt: normalizeString(revision?.createdAt, now()),
        message: normalizeString(revision?.message),
    };
}

export function normalizeArtifactRecord(artifact = {}) {
    const kind = normalizeArtifactKind(artifact?.kind);
    const id = normalizeString(artifact?.id, GLib.uuid_string_random());
    const revisionIds = normalizeStringList(artifact?.revisionIds);
    const currentRevisionId = normalizeString(
        artifact?.currentRevisionId,
        revisionIds[revisionIds.length - 1] ?? '',
    );

    if (currentRevisionId && !revisionIds.includes(currentRevisionId))
        revisionIds.push(currentRevisionId);

    const defaultCapabilities = kind === 'html' && artifact?.capabilities === undefined
        ? ['scripts']
        : artifact?.capabilities;

    return {
        id,
        title: normalizeString(artifact?.title, 'Untitled artifact'),
        kind,
        format: normalizeString(artifact?.format, defaultFormatForArtifactKind(kind)),
        mimeType: normalizeString(artifact?.mimeType, defaultMimeTypeForArtifactKind(kind)),
        originConversationId: normalizeString(artifact?.originConversationId),
        currentRevisionId,
        revisionIds,
        preferredPresentation: normalizeArtifactPresentation(
            artifact?.preferredPresentation,
            kind === 'html' ? 'panel' : 'inline',
        ),
        capabilities: normalizeStringList(defaultCapabilities, ARTIFACT_CAPABILITIES),
        generatedBy: normalizeString(artifact?.generatedBy, 'assistant'),
        createdAt: normalizeString(artifact?.createdAt, now()),
        updatedAt: normalizeString(artifact?.updatedAt, artifact?.createdAt ?? now()),
        archivedAt: normalizeString(artifact?.archivedAt),
        userEdited: Boolean(artifact?.userEdited),
    };
}

export function normalizeArtifactReference(reference = {}) {
    const artifactId = normalizeString(reference?.artifactId ?? reference?.id);
    const revisionId = normalizeString(reference?.revisionId ?? reference?.currentRevisionId);

    if (!artifactId || !revisionId)
        return null;

    const kind = normalizeArtifactKind(reference?.kind);

    return {
        artifactId,
        revisionId,
        title: normalizeString(reference?.title, 'Untitled artifact'),
        kind,
        format: normalizeString(reference?.format, defaultFormatForArtifactKind(kind)),
        mimeType: normalizeString(reference?.mimeType, defaultMimeTypeForArtifactKind(kind)),
        preferredPresentation: normalizeArtifactPresentation(
            reference?.preferredPresentation,
            kind === 'html' ? 'panel' : 'inline',
        ),
        sourceBlockIndex: Number.isInteger(Number(reference?.sourceBlockIndex))
            ? Math.max(-1, Number(reference.sourceBlockIndex))
            : -1,
        sourceLanguage: normalizeString(reference?.sourceLanguage),
        generatedBy: normalizeString(reference?.generatedBy),
        createdAt: normalizeString(reference?.createdAt, now()),
    };
}

export function artifactReferenceFor(artifact, revisionId = '', options = {}) {
    const normalizedArtifact = normalizeArtifactRecord(artifact);
    const selectedRevisionId = normalizeString(revisionId, normalizedArtifact.currentRevisionId);

    if (!selectedRevisionId)
        return null;

    return normalizeArtifactReference({
        artifactId: normalizedArtifact.id,
        revisionId: selectedRevisionId,
        title: normalizedArtifact.title,
        kind: normalizedArtifact.kind,
        format: normalizedArtifact.format,
        mimeType: normalizedArtifact.mimeType,
        preferredPresentation: options.preferredPresentation ?? normalizedArtifact.preferredPresentation,
        sourceBlockIndex: options.sourceBlockIndex,
        sourceLanguage: options.sourceLanguage,
        generatedBy: normalizedArtifact.generatedBy,
        createdAt: options.createdAt ?? normalizedArtifact.createdAt,
    });
}

export function normalizeArtifactDatabase(database = {}) {
    const artifacts = Array.isArray(database?.artifacts)
        ? database.artifacts.map(normalizeArtifactRecord)
        : [];
    const knownArtifactIds = new Set(artifacts.map((artifact) => artifact.id));
    const revisions = Array.isArray(database?.revisions)
        ? database.revisions.map(normalizeArtifactRevision).filter((revision) => (
            revision && knownArtifactIds.has(revision.artifactId)
        ))
        : [];

    return {
        version: ARTIFACT_DATABASE_VERSION,
        artifacts,
        revisions,
    };
}

export class ArtifactRevisionConflictError extends Error {
    constructor(artifactId, expectedRevisionId, actualRevisionId) {
        super(`Artifact ${artifactId} changed from revision ${expectedRevisionId} to ${actualRevisionId}.`);
        this.name = 'ArtifactRevisionConflictError';
        this.code = 'ARTIFACT_REVISION_CONFLICT';
        this.artifactId = artifactId;
        this.expectedRevisionId = expectedRevisionId;
        this.actualRevisionId = actualRevisionId;
    }
}
