import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { APP_ID } from '../appInfo.js';

const TEXT_APPLICATION_TYPES = new Set([
    'application/javascript',
    'application/json',
    'application/ld+json',
    'application/sql',
    'application/toml',
    'application/x-javascript',
    'application/x-shellscript',
    'application/x-yaml',
    'application/xml',
    'application/yaml',
    'image/svg+xml',
]);
export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 8000;

export function defaultPastedImageDirectory() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        APP_ID,
        'pasted-images',
    ]);
}

export function defaultPastedTextDirectory() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        APP_ID,
        'pasted-text',
    ]);
}

export function shouldAttachPastedText(
    text,
    threshold = PASTED_TEXT_ATTACHMENT_THRESHOLD,
) {
    const minimumCharacters = Math.max(0, Number(threshold) || 0);
    let characterCount = 0;

    for (const _character of String(text ?? '')) {
        characterCount += 1;

        if (characterCount > minimumCharacters)
            return true;
    }

    return false;
}

/**
 * Persist a clipboard texture as a private, durable PNG for conversation history.
 */
export function savePastedImageTexture(texture, options = {}) {
    if (typeof texture?.save_to_png !== 'function')
        throw new Error('The clipboard did not provide a usable image texture.');

    const directory = String(options.directory ?? defaultPastedImageDirectory()).trim();

    if (!directory)
        throw new Error('The pasted-image directory is not available.');

    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error('Could not create the pasted-image directory.');
    if (GLib.chmod(directory, 0o700) !== 0)
        throw new Error('Could not secure the pasted-image directory.');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const uuid = GLib.uuid_string_random();
    const name = `pasted-image-${timestamp}-${uuid}.png`;
    const path = GLib.build_filenamev([directory, name]);
    const temporaryPath = GLib.build_filenamev([
        directory,
        `.${name}.${GLib.uuid_string_random()}.tmp`,
    ]);

    try {
        if (texture.save_to_png(temporaryPath) === false)
            throw new Error('Could not encode the pasted image as PNG.');
        if (GLib.chmod(temporaryPath, 0o600) !== 0)
            throw new Error('Could not secure the temporary pasted image.');

        Gio.File.new_for_path(temporaryPath).move(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.NONE,
            null,
            null,
        );

        if (GLib.chmod(path, 0o600) !== 0)
            throw new Error('Could not secure the pasted image.');
    } finally {
        if (GLib.file_test(temporaryPath, GLib.FileTest.EXISTS))
            GLib.unlink(temporaryPath);
    }

    return path;
}

/**
 * Persist long clipboard text as a private, durable article for conversation history.
 */
export function savePastedText(text, options = {}) {
    const content = String(text ?? '');

    if (!content)
        throw new Error('The clipboard did not provide usable text.');

    const directory = String(options.directory ?? defaultPastedTextDirectory()).trim();

    if (!directory)
        throw new Error('The pasted-text directory is not available.');

    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error('Could not create the pasted-text directory.');
    if (GLib.chmod(directory, 0o700) !== 0)
        throw new Error('Could not secure the pasted-text directory.');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const uuid = GLib.uuid_string_random();
    const name = `pasted-article-${timestamp}-${uuid}.txt`;
    const path = GLib.build_filenamev([directory, name]);
    const temporaryPath = GLib.build_filenamev([
        directory,
        `.${name}.${GLib.uuid_string_random()}.tmp`,
    ]);

    try {
        if (GLib.file_set_contents(temporaryPath, content) === false)
            throw new Error('Could not write the pasted text.');
        if (GLib.chmod(temporaryPath, 0o600) !== 0)
            throw new Error('Could not secure the temporary pasted text.');

        Gio.File.new_for_path(temporaryPath).move(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.NONE,
            null,
            null,
        );

        if (GLib.chmod(path, 0o600) !== 0)
            throw new Error('Could not secure the pasted text.');
    } finally {
        if (GLib.file_test(temporaryPath, GLib.FileTest.EXISTS))
            GLib.unlink(temporaryPath);
    }

    return path;
}

function attachmentContentType(path) {
    const file = Gio.File.new_for_path(path);
    const info = file.query_info(
        Gio.FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE,
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
    );

    return info.get_content_type() || 'application/octet-stream';
}

export function isTextAttachmentContentType(contentType) {
    const mimeType = String(Gio.content_type_get_mime_type(contentType) ?? contentType ?? '')
        .toLowerCase();

    return mimeType.startsWith('text/')
        || mimeType.endsWith('+json')
        || mimeType.endsWith('+xml')
        || TEXT_APPLICATION_TYPES.has(mimeType);
}

export function createFileAttachment(path, { maxTextCharacters = 20000 } = {}) {
    const name = GLib.path_get_basename(path);
    const contentType = attachmentContentType(path);
    const maxCharacters = Math.max(0, Number(maxTextCharacters) || 0);

    if (!isTextAttachmentContentType(contentType)) {
        return {
            kind: 'file',
            name,
            path,
            contentType,
            binary: true,
            content: '',
            truncated: false,
        };
    }

    const [, contents] = GLib.file_get_contents(path);
    let text = '';

    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    } catch (_error) {
        return {
            kind: 'file',
            name,
            path,
            contentType,
            binary: true,
            content: '',
            truncated: false,
        };
    }

    return {
        kind: 'file',
        name,
        path,
        contentType,
        binary: false,
        content: text.slice(0, maxCharacters),
        truncated: text.length > maxCharacters,
    };
}

export function createPastedTextAttachment(text, options = {}) {
    const path = savePastedText(text, options);

    return createFileAttachment(path, {
        maxTextCharacters: options.maxTextCharacters,
    });
}

export function fileAttachmentSummary(attachment) {
    const name = String(attachment?.name ?? 'file');

    if (attachment?.binary) {
        const contentType = String(attachment?.contentType ?? '').toLowerCase();

        return contentType === 'application/pdf'
            ? `PDF attachment: ${name} (preview unavailable)`
            : `File attachment: ${name} (preview unavailable for this file type)`;
    }

    return [
        `File attachment: ${name}${attachment?.truncated ? ' (truncated)' : ''}`,
        '```text',
        String(attachment?.content ?? ''),
        '```',
    ].join('\n');
}

function attachmentIsBinary(attachment) {
    if (attachment?.binary === true)
        return true;

    if (attachment?.binary === false)
        return false;

    const contentType = attachment?.contentType
        || Gio.content_type_guess(String(attachment?.name ?? ''), null)[0];

    return !isTextAttachmentContentType(contentType);
}

export function hideBinaryAttachmentData(body, attachments = []) {
    let displayBody = String(body ?? '');

    for (const attachment of Array.isArray(attachments) ? attachments : []) {
        if (attachment?.kind !== 'file' || !attachmentIsBinary(attachment))
            continue;

        const legacyBlock = [
            `File attachment: ${attachment.name}${attachment.truncated ? ' (truncated)' : ''}`,
            '```text',
            String(attachment.content ?? ''),
            '```',
        ].join('\n');
        const binaryAttachment = {
            ...attachment,
            binary: true,
            contentType: attachment.contentType
                || Gio.content_type_guess(String(attachment.name ?? ''), null)[0],
        };

        displayBody = displayBody.replace(legacyBlock, fileAttachmentSummary(binaryAttachment));
    }

    return displayBody;
}
