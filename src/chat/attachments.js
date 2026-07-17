import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

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
