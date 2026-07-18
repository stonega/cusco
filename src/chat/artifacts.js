import GLib from 'gi://GLib?version=2.0';

import { APP_ID } from '../appInfo.js';
import { parseMarkdownBlocks } from './markdown.js';

export const ARTIFACT_TEXT_MAX_BYTES = 1024 * 1024;

const ARTIFACT_MIME_TYPES = {
    image: 'image/png',
    svg: 'image/svg+xml',
    html: 'text/html',
};

const ARTIFACT_EXTENSIONS = {
    image: 'png',
    svg: 'svg',
    html: 'html',
};

function now() {
    return new Date().toISOString();
}

function normalizeString(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function normalizeArtifactKind(value) {
    const kind = String(value ?? '').trim().toLowerCase();
    return Object.hasOwn(ARTIFACT_MIME_TYPES, kind) ? kind : '';
}

function defaultArtifactDirectory(kind = '') {
    const parts = [
        GLib.get_user_data_dir(),
        APP_ID,
        'artifacts',
    ];

    if (kind)
        parts.push(kind);

    return GLib.build_filenamev(parts);
}

function extensionForArtifact(artifact) {
    if (artifact.kind === 'image') {
        switch (String(artifact.mimeType ?? '').toLowerCase()) {
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
        default:
            return 'png';
        }
    }

    return ARTIFACT_EXTENSIONS[artifact.kind] ?? 'txt';
}

function artifactFilename(kind, extension) {
    const timestamp = now().replace(/[:.]/g, '-');
    return `${timestamp}-${GLib.uuid_string_random()}.${extension}`;
}

function byteLength(text) {
    return new TextEncoder().encode(String(text ?? '')).length;
}

function sourceWithoutLeadingDeclarations(source) {
    return String(source ?? '')
        .trim()
        .replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
        .replace(/^<!doctype\s+svg[\s\S]*?>\s*/i, '')
        .trim();
}

export function isSvgArtifactSource(source) {
    const text = sourceWithoutLeadingDeclarations(source);
    return /^<svg(?:\s|>)[\s\S]*<\/svg>\s*$/i.test(text);
}

export function isHtmlArtifactSource(source) {
    const text = String(source ?? '').trim();
    return /^<!doctype\s+html(?:\s|>)/i.test(text) || /^<html(?:\s|>)[\s\S]*<\/html>\s*$/i.test(text);
}

export function artifactKindForCodeBlock(block) {
    if (block?.type !== 'code')
        return '';

    const language = String(block.language ?? '').trim().toLowerCase();
    const source = String(block.content ?? '');

    if (language === 'svg' && isSvgArtifactSource(source))
        return 'svg';

    if (language === 'xml' && isSvgArtifactSource(source))
        return 'svg';

    if ((language === 'html' || language === 'htm') && isHtmlArtifactSource(source))
        return 'html';

    return '';
}

export function normalizeArtifact(artifact) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
        return null;

    const kind = normalizeArtifactKind(artifact.kind);

    if (!kind)
        return null;

    const path = normalizeString(artifact.path);
    const sourceBlockIndex = Number(artifact.sourceBlockIndex);

    return {
        id: normalizeString(artifact.id, GLib.uuid_string_random()),
        kind,
        title: normalizeString(artifact.title, kind === 'html'
            ? 'HTML artifact'
            : kind === 'svg'
                ? 'SVG artifact'
                : 'Image artifact'),
        mimeType: normalizeString(artifact.mimeType, ARTIFACT_MIME_TYPES[kind]),
        path,
        sourceBlockIndex: Number.isInteger(sourceBlockIndex) && sourceBlockIndex >= 0
            ? sourceBlockIndex
            : -1,
        sourceLanguage: normalizeString(artifact.sourceLanguage),
        createdAt: normalizeString(artifact.createdAt, now()),
        generatedBy: normalizeString(artifact.generatedBy),
    };
}

export function normalizeArtifacts(artifacts) {
    if (!Array.isArray(artifacts))
        return [];

    return artifacts.map(normalizeArtifact).filter(Boolean);
}

export function saveTextArtifact(kind, source, options = {}) {
    const artifactKind = normalizeArtifactKind(kind);
    const text = String(source ?? '').trim();

    if (!artifactKind || artifactKind === 'image' || !text)
        return null;

    if (byteLength(text) > (options.maxBytes ?? ARTIFACT_TEXT_MAX_BYTES))
        return null;

    const directory = options.directory ?? defaultArtifactDirectory(artifactKind);
    const artifact = normalizeArtifact({
        id: options.id,
        kind: artifactKind,
        title: options.title,
        mimeType: ARTIFACT_MIME_TYPES[artifactKind],
        sourceBlockIndex: options.sourceBlockIndex,
        sourceLanguage: options.sourceLanguage,
        generatedBy: options.generatedBy,
        createdAt: options.createdAt,
    });
    const extension = extensionForArtifact(artifact);
    const path = GLib.build_filenamev([
        directory,
        artifactFilename(artifactKind, extension),
    ]);

    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(path, text);

    return {
        ...artifact,
        path,
    };
}

export function extractArtifactsFromMarkdown(markdown, options = {}) {
    const artifacts = [];

    parseMarkdownBlocks(markdown).forEach((block, index) => {
        const kind = artifactKindForCodeBlock(block);

        if (!kind)
            return;

        const artifact = saveTextArtifact(kind, block.content, {
            ...options,
            sourceBlockIndex: index,
            sourceLanguage: block.language,
            title: kind === 'svg' ? 'SVG artifact' : 'HTML artifact',
        });

        if (artifact)
            artifacts.push(artifact);
    });

    return artifacts;
}

export function artifactForCodeBlock(artifacts, blockIndex, block) {
    const normalizedArtifacts = normalizeArtifacts(artifacts);

    return normalizedArtifacts.find((artifact) => artifact.sourceBlockIndex === blockIndex)
        ?? normalizedArtifacts.find((artifact) => {
            const kind = artifactKindForCodeBlock(block);
            return kind && artifact.kind === kind && artifact.sourceBlockIndex < 0;
        })
        ?? null;
}

export function imageArtifactForToolCall(toolCall = {}) {
    const existing = normalizeArtifacts(toolCall.artifacts)
        .find((artifact) => artifact.kind === 'image');

    if (existing)
        return existing;

    const imagePath = normalizeString(toolCall.imagePath);

    if (!imagePath)
        return null;

    const toolName = normalizeString(toolCall.name);
    return createImageArtifactFromPath(imagePath, {
        title: toolName === 'image_gen' ? 'Generated image' : 'Tool result image',
        mimeType: normalizeString(toolCall.mimeType, ARTIFACT_MIME_TYPES.image),
        createdAt: toolCall.completedAt ?? toolCall.createdAt,
        generatedBy: toolName || 'tool',
    });
}

export function createImageArtifactFromPath(path, options = {}) {
    const artifact = normalizeArtifact({
        id: options.id,
        kind: 'image',
        title: options.title,
        mimeType: options.mimeType ?? ARTIFACT_MIME_TYPES.image,
        path,
        sourceBlockIndex: -1,
        sourceLanguage: '',
        createdAt: options.createdAt,
        generatedBy: options.generatedBy,
    });

    return artifact?.path ? artifact : null;
}
