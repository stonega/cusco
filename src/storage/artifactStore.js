import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { APP_ID } from '../appInfo.js';
import {
    ARTIFACT_DATABASE_VERSION,
    normalizeArtifactDatabase,
} from '../artifacts/model.js';

export const ARTIFACT_MAX_FILE_COUNT = 128;
export const ARTIFACT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const ARTIFACT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const TEXT_ENCODER = new TextEncoder();

export function defaultArtifactStoreRoot() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        APP_ID,
        'artifacts-v2',
    ]);
}

function safePathSegment(value, label) {
    const segment = String(value ?? '').trim();

    if (!segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))
        throw new Error(`Invalid ${label}.`);

    return segment;
}

export function normalizeArtifactBundlePath(value) {
    const path = String(value ?? '').trim().replace(/\\/g, '/');

    if (!path || path.startsWith('/') || path.includes('\0') || path.length > 512)
        throw new Error('Artifact file path must be a relative path.');

    const parts = path.split('/');

    if (parts.some((part) => !part || part === '.' || part === '..'))
        throw new Error(`Unsafe artifact file path: ${path}`);

    return parts.join('/');
}

function contentBytes(value) {
    if (typeof value === 'string')
        return TEXT_ENCODER.encode(value);

    if (value instanceof Uint8Array)
        return value;

    if (value instanceof GLib.Bytes)
        return value.get_data();

    throw new Error('Artifact file content must be text or bytes.');
}

function mimeTypeForPath(path) {
    const extension = String(path).split('.').pop()?.toLowerCase();

    switch (extension) {
    case 'html':
    case 'htm':
        return 'text/html';
    case 'css':
        return 'text/css';
    case 'js':
    case 'mjs':
        return 'text/javascript';
    case 'json':
        return 'application/json';
    case 'md':
    case 'markdown':
        return 'text/markdown';
    case 'csv':
        return 'text/csv';
    case 'svg':
        return 'image/svg+xml';
    case 'png':
        return 'image/png';
    case 'jpg':
    case 'jpeg':
        return 'image/jpeg';
    case 'webp':
        return 'image/webp';
    case 'gif':
        return 'image/gif';
    case 'pdf':
        return 'application/pdf';
    case 'txt':
        return 'text/plain';
    default:
        return 'application/octet-stream';
    }
}

function normalizeFiles(files, limits = {}) {
    const entries = Array.isArray(files)
        ? files.map((file) => [file?.path, file])
        : Object.entries(files ?? {});
    const maxFileCount = limits.maxFileCount ?? ARTIFACT_MAX_FILE_COUNT;
    const maxFileBytes = limits.maxFileBytes ?? ARTIFACT_MAX_FILE_BYTES;
    const maxTotalBytes = limits.maxTotalBytes ?? ARTIFACT_MAX_TOTAL_BYTES;

    if (entries.length === 0)
        throw new Error('An artifact revision must contain at least one file.');

    if (entries.length > maxFileCount)
        throw new Error(`Artifact contains more than ${maxFileCount} files.`);

    const seen = new Set();
    const normalized = [];
    let totalBytes = 0;

    for (const [rawPath, rawValue] of entries) {
        const path = normalizeArtifactBundlePath(rawPath);

        if (path === 'manifest.json')
            throw new Error('manifest.json is reserved for artifact metadata.');

        if (seen.has(path))
            throw new Error(`Duplicate artifact file path: ${path}`);

        seen.add(path);
        const descriptor = rawValue && typeof rawValue === 'object'
            && !(rawValue instanceof Uint8Array)
            && !(rawValue instanceof GLib.Bytes)
            && Object.hasOwn(rawValue, 'content')
            ? rawValue
            : { content: rawValue };
        const bytes = contentBytes(descriptor.content);

        if (bytes.length > maxFileBytes)
            throw new Error(`Artifact file exceeds the ${maxFileBytes}-byte limit: ${path}`);

        totalBytes += bytes.length;

        if (totalBytes > maxTotalBytes)
            throw new Error(`Artifact exceeds the ${maxTotalBytes}-byte bundle limit.`);

        normalized.push({
            path,
            bytes,
            mimeType: String(descriptor.mimeType ?? '').trim() || mimeTypeForPath(path),
            size: bytes.length,
            sha256: GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes),
        });
    }

    normalized.sort((left, right) => left.path.localeCompare(right.path));
    return { files: normalized, totalBytes };
}

function writeFileAtomically(path, contents) {
    const directory = GLib.path_get_dirname(path);
    const basename = GLib.path_get_basename(path);
    const tempPath = GLib.build_filenamev([
        directory,
        `.${basename}.${GLib.uuid_string_random()}.tmp`,
    ]);

    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(tempPath, contents);

    try {
        Gio.File.new_for_path(tempPath).move(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null,
        );
    } finally {
        if (GLib.file_test(tempPath, GLib.FileTest.EXISTS))
            GLib.unlink(tempPath);
    }
}

function removeTree(path) {
    const file = Gio.File.new_for_path(path);
    const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);

    if (type === Gio.FileType.UNKNOWN)
        return;

    if (type === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
        );

        try {
            let info;

            while ((info = enumerator.next_file(null)) !== null)
                removeTree(file.get_child(info.get_name()).get_path());
        } finally {
            enumerator.close(null);
        }
    }

    file.delete(null);
}

function readBytes(path) {
    const [, contents] = GLib.file_get_contents(path);
    return contents;
}

export class ArtifactFileStore {
    constructor(options = {}) {
        this.root = options.root ?? defaultArtifactStoreRoot();
        this.indexPath = options.indexPath ?? GLib.build_filenamev([this.root, 'index.json']);
        this.limits = {
            maxFileCount: options.maxFileCount ?? ARTIFACT_MAX_FILE_COUNT,
            maxFileBytes: options.maxFileBytes ?? ARTIFACT_MAX_FILE_BYTES,
            maxTotalBytes: options.maxTotalBytes ?? ARTIFACT_MAX_TOTAL_BYTES,
        };
    }

    load() {
        if (!GLib.file_test(this.indexPath, GLib.FileTest.EXISTS))
            return normalizeArtifactDatabase({});

        const [, contents] = GLib.file_get_contents(this.indexPath);
        return normalizeArtifactDatabase(JSON.parse(new TextDecoder().decode(contents)));
    }

    save(database) {
        const normalized = normalizeArtifactDatabase(database);
        const payload = JSON.stringify({
            version: ARTIFACT_DATABASE_VERSION,
            artifacts: normalized.artifacts,
            revisions: normalized.revisions,
        }, null, 2);

        writeFileAtomically(this.indexPath, `${payload}\n`);
    }

    artifactDirectory(artifactId) {
        return GLib.build_filenamev([
            this.root,
            safePathSegment(artifactId, 'artifact ID'),
        ]);
    }

    revisionDirectory(artifactId, revisionId) {
        return GLib.build_filenamev([
            this.artifactDirectory(artifactId),
            safePathSegment(revisionId, 'revision ID'),
        ]);
    }

    revisionFilePath(artifactId, revisionId, relativePath) {
        return GLib.build_filenamev([
            this.revisionDirectory(artifactId, revisionId),
            ...normalizeArtifactBundlePath(relativePath).split('/'),
        ]);
    }

    writeRevision(artifactId, revisionId, files, options = {}) {
        const normalizedArtifactId = safePathSegment(artifactId, 'artifact ID');
        const normalizedRevisionId = safePathSegment(revisionId, 'revision ID');
        const normalized = normalizeFiles(files, this.limits);
        const requestedEntrypoint = options.entrypoint
            ? normalizeArtifactBundlePath(options.entrypoint)
            : normalized.files[0].path;

        if (!normalized.files.some((file) => file.path === requestedEntrypoint))
            throw new Error(`Artifact entrypoint does not exist: ${requestedEntrypoint}`);

        const artifactDirectory = this.artifactDirectory(normalizedArtifactId);
        const targetDirectory = this.revisionDirectory(normalizedArtifactId, normalizedRevisionId);

        if (GLib.file_test(targetDirectory, GLib.FileTest.EXISTS))
            throw new Error(`Artifact revision already exists: ${normalizedRevisionId}`);

        GLib.mkdir_with_parents(artifactDirectory, 0o700);
        const tempDirectory = GLib.build_filenamev([
            artifactDirectory,
            `.${normalizedRevisionId}.${GLib.uuid_string_random()}.tmp`,
        ]);

        try {
            GLib.mkdir_with_parents(tempDirectory, 0o700);

            for (const file of normalized.files) {
                const targetPath = GLib.build_filenamev([
                    tempDirectory,
                    ...file.path.split('/'),
                ]);

                GLib.mkdir_with_parents(GLib.path_get_dirname(targetPath), 0o700);
                GLib.file_set_contents(targetPath, file.bytes);
            }

            const hashInput = normalized.files
                .map((file) => `${file.path}\0${file.sha256}\0${file.mimeType}`)
                .join('\n');
            const contentHash = GLib.compute_checksum_for_data(
                GLib.ChecksumType.SHA256,
                TEXT_ENCODER.encode(hashInput),
            );
            const manifest = {
                entrypoint: requestedEntrypoint,
                files: normalized.files.map(({ path, mimeType, size, sha256 }) => ({
                    path,
                    mimeType,
                    size,
                    sha256,
                })),
                totalBytes: normalized.totalBytes,
            };

            GLib.file_set_contents(
                GLib.build_filenamev([tempDirectory, 'manifest.json']),
                `${JSON.stringify({ ...manifest, contentHash }, null, 2)}\n`,
            );
            Gio.File.new_for_path(tempDirectory).move(
                Gio.File.new_for_path(targetDirectory),
                Gio.FileCopyFlags.NONE,
                null,
                null,
            );

            return { manifest, contentHash };
        } catch (error) {
            if (GLib.file_test(tempDirectory, GLib.FileTest.EXISTS))
                removeTree(tempDirectory);
            throw error;
        }
    }

    readRevisionFile(artifactId, revisionId, relativePath) {
        return readBytes(this.revisionFilePath(artifactId, revisionId, relativePath));
    }

    readRevisionText(artifactId, revisionId, relativePath) {
        return new TextDecoder().decode(this.readRevisionFile(artifactId, revisionId, relativePath));
    }

    readRevisionFiles(artifactId, revision) {
        const result = {};

        for (const file of revision.manifest.files) {
            result[file.path] = {
                content: this.readRevisionFile(artifactId, revision.id, file.path),
                mimeType: file.mimeType,
            };
        }

        return result;
    }

    importExternalFile(artifactId, revisionId, sourcePath, options = {}) {
        if (!GLib.file_test(sourcePath, GLib.FileTest.EXISTS))
            throw new Error(`Artifact source file does not exist: ${sourcePath}`);

        const targetName = normalizeArtifactBundlePath(
            options.targetName ?? GLib.path_get_basename(sourcePath),
        );

        return this.writeRevision(artifactId, revisionId, {
            [targetName]: {
                content: readBytes(sourcePath),
                mimeType: options.mimeType,
            },
        }, {
            entrypoint: targetName,
        });
    }

    removeUnindexedRevision(artifactId, revisionId) {
        const directory = this.revisionDirectory(artifactId, revisionId);

        if (GLib.file_test(directory, GLib.FileTest.EXISTS))
            removeTree(directory);
    }
}
