import GLib from 'gi://GLib?version=2.0';

import { artifactReferenceFor } from '../artifacts/model.js';
import { TOOL_PERMISSION_ALLOW } from './permissions.js';

const ARTIFACT_READ_MAX_CHARS = 64000;
const SAFE_AGENT_CAPABILITIES = new Set(['scripts']);

function parseJsonInput(input, label) {
    let value;

    try {
        value = typeof input === 'string' ? JSON.parse(input) : input;
    } catch (_error) {
        const error = new Error(`${label} input must be valid JSON.`);
        error.userMessage = error.message;
        throw error;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        const error = new Error(`${label} input must be a JSON object.`);
        error.userMessage = error.message;
        throw error;
    }

    return value;
}

function safeCapabilities(values) {
    return Array.isArray(values)
        ? values.map(String).filter((value) => SAFE_AGENT_CAPABILITIES.has(value))
        : undefined;
}

function decodeBase64Content(value, label) {
    const encoded = String(value ?? '').replace(/\s/g, '');

    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        throw new Error(`${label} is not valid base64.`);

    return GLib.base64_decode(encoded);
}

function decodeContent(value, encoding, label) {
    if (encoding === undefined || encoding === '' || encoding === 'text')
        return value;

    if (encoding !== 'base64')
        throw new Error(`${label} uses an unsupported encoding.`);

    return decodeBase64Content(value, label);
}

function decodeArtifactInput(spec) {
    const decoded = { ...spec };

    if (Object.hasOwn(spec, 'content'))
        decoded.content = decodeContent(spec.content, spec.encoding, 'Artifact content');

    if (spec.files && typeof spec.files === 'object' && !Array.isArray(spec.files)) {
        decoded.files = Object.fromEntries(Object.entries(spec.files).map(([path, file]) => {
            if (!file || typeof file !== 'object' || Array.isArray(file))
                return [path, file];

            return [path, {
                ...file,
                content: decodeContent(file.content, file.encoding, `Artifact file ${path}`),
            }];
        }));
    }

    if (Array.isArray(spec.changes)) {
        decoded.changes = spec.changes.map((change) => {
            if (!Object.hasOwn(change ?? {}, 'content'))
                return change;

            return {
                ...change,
                content: decodeContent(
                    change.content,
                    change.encoding,
                    `Artifact file ${String(change.path ?? '')}`,
                ),
            };
        });
    }

    return decoded;
}

function artifactSummary(artifact, revision) {
    return {
        artifactId: artifact.id,
        revisionId: revision.id,
        title: artifact.title,
        kind: artifact.kind,
        format: artifact.format,
        presentation: artifact.preferredPresentation,
        entrypoint: revision.manifest.entrypoint,
        files: revision.manifest.files.map((file) => ({
            path: file.path,
            mimeType: file.mimeType,
            size: file.size,
        })),
    };
}

export function createArtifactTools(artifactManager, options = {}) {
    const currentConversationId = () => String(options.getConversationId?.() ?? '').trim();
    const requiredConversationId = () => {
        const conversationId = currentConversationId();

        if (!conversationId)
            throw new Error('Artifact tools require an active conversation.');

        return conversationId;
    };
    const requireScopedArtifact = (artifactId) => {
        const artifact = artifactManager.getArtifact(artifactId);

        if (!artifact)
            throw new Error(`Artifact does not exist: ${artifactId}`);

        if (artifact.originConversationId !== requiredConversationId())
            throw new Error(`Artifact is not available in the current conversation: ${artifactId}`);

        return artifact;
    };

    return [
        {
            name: 'artifact_create',
            label: 'Create artifact',
            description: 'Create a durable document, code, data, chart, diagram, image, HTML, PDF, or file artifact.',
            inputDescription: 'JSON with title, kind, format, content or files, entrypoint, presentation, and optional base64 encoding.',
            inputSchema: {
                type: 'object',
                required: ['title', 'kind'],
                properties: {
                    title: { type: 'string' },
                    kind: {
                        type: 'string',
                        enum: ['document', 'code', 'data', 'chart', 'diagram', 'image', 'svg', 'html', 'pdf', 'file'],
                    },
                    format: { type: 'string' },
                    mimeType: { type: 'string' },
                    content: { type: 'string' },
                    encoding: { type: 'string', enum: ['text', 'base64'] },
                    filename: { type: 'string' },
                    files: {
                        type: 'object',
                        additionalProperties: {
                            oneOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    required: ['content'],
                                    properties: {
                                        content: { type: 'string' },
                                        mimeType: { type: 'string' },
                                        encoding: { type: 'string', enum: ['text', 'base64'] },
                                    },
                                },
                            ],
                        },
                    },
                    entrypoint: { type: 'string' },
                    preferredPresentation: { type: 'string', enum: ['inline', 'panel'] },
                    capabilities: {
                        type: 'array',
                        items: { type: 'string', enum: ['scripts'] },
                    },
                },
            },
            permissionPolicy: TOOL_PERMISSION_ALLOW,
            concurrencySafe: false,
            run(input) {
                const spec = decodeArtifactInput(parseJsonInput(input, 'Create artifact'));
                const created = artifactManager.createArtifact({
                    ...spec,
                    capabilities: safeCapabilities(spec.capabilities),
                    generatedBy: 'assistant',
                }, {
                    originConversationId: requiredConversationId(),
                    createdBy: 'assistant',
                });
                const summary = artifactSummary(created.artifact, created.revision);

                return {
                    output: `Created artifact ${created.artifact.title} (${created.artifact.id}, revision ${created.revision.id}).`,
                    artifact: summary,
                    artifacts: [created.reference],
                };
            },
        },
        {
            name: 'artifact_update',
            label: 'Update artifact',
            description: 'Create a new immutable revision of an existing artifact.',
            inputDescription: 'JSON with artifactId, baseRevisionId, and text/base64 content, files, or file changes.',
            inputSchema: {
                type: 'object',
                required: ['artifactId', 'baseRevisionId'],
                properties: {
                    artifactId: { type: 'string' },
                    baseRevisionId: { type: 'string' },
                    title: { type: 'string' },
                    content: { type: 'string' },
                    encoding: { type: 'string', enum: ['text', 'base64'] },
                    filename: { type: 'string' },
                    entrypoint: { type: 'string' },
                    files: { type: 'object' },
                    changes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['path'],
                            properties: {
                                path: { type: 'string' },
                                content: { type: 'string' },
                                mimeType: { type: 'string' },
                                encoding: { type: 'string', enum: ['text', 'base64'] },
                                delete: { type: 'boolean' },
                            },
                        },
                    },
                    message: { type: 'string' },
                },
            },
            permissionPolicy: TOOL_PERMISSION_ALLOW,
            concurrencySafe: false,
            run(input) {
                const spec = decodeArtifactInput(parseJsonInput(input, 'Update artifact'));
                requireScopedArtifact(spec.artifactId);
                const updated = artifactManager.updateArtifact(spec.artifactId, spec, {
                    createdBy: 'assistant',
                });
                const summary = artifactSummary(updated.artifact, updated.revision);

                return {
                    output: `Updated artifact ${updated.artifact.title} to revision ${updated.revision.id}.`,
                    artifact: summary,
                    artifacts: [updated.reference],
                };
            },
        },
        {
            name: 'artifact_read',
            label: 'Read artifact',
            description: 'Read metadata and a bounded text file from a selected artifact revision.',
            inputDescription: 'JSON with artifactId and optional revisionId and path.',
            inputSchema: {
                type: 'object',
                required: ['artifactId'],
                properties: {
                    artifactId: { type: 'string' },
                    revisionId: { type: 'string' },
                    path: { type: 'string' },
                },
            },
            permissionPolicy: TOOL_PERMISSION_ALLOW,
            concurrencySafe: true,
            run(input) {
                const spec = parseJsonInput(input, 'Read artifact');
                requireScopedArtifact(spec.artifactId);
                const resolved = artifactManager.getArtifactRevision(spec.artifactId, spec.revisionId);

                if (!resolved)
                    throw new Error(`Artifact revision does not exist: ${spec.artifactId}`);

                const path = String(spec.path ?? '').trim() || resolved.revision.manifest.entrypoint;
                const descriptor = resolved.revision.manifest.files.find((file) => file.path === path);
                let content = '';
                let truncated = false;

                if (descriptor?.mimeType.startsWith('text/')
                    || ['application/json', 'image/svg+xml'].includes(descriptor?.mimeType)) {
                    const fullContent = artifactManager.readText(resolved.artifact.id, resolved.revision.id, path);
                    content = fullContent.slice(0, ARTIFACT_READ_MAX_CHARS);
                    truncated = content.length < fullContent.length;
                }

                const reference = artifactReferenceFor(resolved.artifact, resolved.revision.id);
                return {
                    output: JSON.stringify({
                        ...artifactSummary(resolved.artifact, resolved.revision),
                        path,
                        content,
                        truncated,
                    }, null, 2),
                    artifacts: [reference],
                };
            },
        },
        {
            name: 'artifact_list',
            label: 'List artifacts',
            description: 'List durable artifacts associated with the current conversation.',
            inputDescription: 'An empty JSON object, or includeArchived boolean.',
            inputSchema: {
                type: 'object',
                properties: {
                    includeArchived: { type: 'boolean' },
                },
            },
            permissionPolicy: TOOL_PERMISSION_ALLOW,
            concurrencySafe: true,
            run(input) {
                const spec = parseJsonInput(input || '{}', 'List artifacts');
                const artifacts = artifactManager.listArtifacts({
                    conversationId: requiredConversationId(),
                    includeArchived: Boolean(spec.includeArchived),
                });
                return {
                    output: JSON.stringify(artifacts.map((artifact) => ({
                        artifactId: artifact.id,
                        currentRevisionId: artifact.currentRevisionId,
                        title: artifact.title,
                        kind: artifact.kind,
                        format: artifact.format,
                        presentation: artifact.preferredPresentation,
                        updatedAt: artifact.updatedAt,
                        archived: Boolean(artifact.archivedAt),
                    })), null, 2),
                };
            },
        },
        {
            name: 'artifact_present',
            label: 'Present artifact',
            description: 'Show an existing artifact revision in Cusco’s artifact workspace.',
            inputDescription: 'JSON with artifactId and optional revisionId.',
            inputSchema: {
                type: 'object',
                required: ['artifactId'],
                properties: {
                    artifactId: { type: 'string' },
                    revisionId: { type: 'string' },
                },
            },
            permissionPolicy: TOOL_PERMISSION_ALLOW,
            concurrencySafe: false,
            run(input) {
                const spec = parseJsonInput(input, 'Present artifact');
                requireScopedArtifact(spec.artifactId);
                const resolved = artifactManager.getArtifactRevision(spec.artifactId, spec.revisionId);

                if (!resolved)
                    throw new Error(`Artifact revision does not exist: ${spec.artifactId}`);

                const reference = artifactReferenceFor(resolved.artifact, resolved.revision.id);
                options.onPresent?.(reference);
                return {
                    output: `Presented artifact ${resolved.artifact.title}.`,
                    artifacts: [reference],
                };
            },
        },
    ];
}
