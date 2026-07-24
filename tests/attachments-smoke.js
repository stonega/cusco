import GLib from 'gi://GLib?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';

import {
    createFileAttachment,
    createPastedTextAttachment,
    fileAttachmentSummary,
    hideBinaryAttachmentData,
    isTextAttachmentContentType,
    PASTED_TEXT_ATTACHMENT_THRESHOLD,
    savePastedImageTexture,
    shouldAttachPastedText,
} from '../src/chat/attachments.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const tempRoot = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-attachments-${GLib.uuid_string_random()}`,
]);
const textPath = GLib.build_filenamev([tempRoot, 'notes.txt']);
const pdfPath = GLib.build_filenamev([tempRoot, 'document.pdf']);
GLib.mkdir_with_parents(tempRoot, 0o700);
GLib.file_set_contents(textPath, 'Readable attachment content');
GLib.file_set_contents(pdfPath, Uint8Array.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
    0x0a, 0xff, 0xd8, 0x00, 0x01,
]));

assert(isTextAttachmentContentType('text/plain'), 'Plain text was not recognized as text');
assert(!isTextAttachmentContentType('application/pdf'), 'PDF was incorrectly recognized as text');

const textAttachment = createFileAttachment(textPath);
const pdfAttachment = createFileAttachment(pdfPath);

assert(!textAttachment.binary, 'Text attachment was marked as binary');
assert(textAttachment.content === 'Readable attachment content', 'Text attachment was not decoded');
assert(pdfAttachment.binary, 'PDF attachment was not marked as binary');
assert(pdfAttachment.content === '', 'Raw PDF bytes leaked into attachment content');
assert(
    fileAttachmentSummary(pdfAttachment) === 'PDF attachment: document.pdf (preview unavailable)',
    'PDF attachment summary was not user friendly',
);
assert(!fileAttachmentSummary(pdfAttachment).includes('%PDF'), 'PDF summary exposed raw bytes');

const thresholdText = 'a'.repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD);
assert(
    !shouldAttachPastedText(thresholdText)
        && shouldAttachPastedText(`${thresholdText}a`),
    'Long pasted text did not respect the article attachment threshold',
);
assert(
    shouldAttachPastedText('界'.repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD + 1)),
    'Long pasted Unicode text was not counted by character',
);

const pastedTextDirectory = GLib.build_filenamev([tempRoot, 'pasted-text']);
const pastedArticleContent = [
    'A pasted article',
    '',
    'This content should remain intact in its durable text attachment.',
].join('\n');
const pastedArticle = createPastedTextAttachment(pastedArticleContent, {
    directory: pastedTextDirectory,
});
const [, pastedArticleBytes] = GLib.file_get_contents(pastedArticle.path);

assert(
    GLib.file_test(pastedArticle.path, GLib.FileTest.IS_REGULAR),
    'Pasted article text was not persisted as an attachment',
);
assert(
    pastedArticle.name.startsWith('pasted-article-') && pastedArticle.name.endsWith('.txt'),
    'Pasted article did not receive a descriptive text filename',
);
assert(
    !pastedArticle.binary
        && new TextDecoder().decode(pastedArticleBytes) === pastedArticleContent
        && pastedArticle.content === pastedArticleContent,
    'Pasted article attachment did not preserve its text content',
);

const legacyPdfAttachment = {
    kind: 'file',
    name: 'document.pdf',
    path: pdfPath,
    content: '%PDF-1.4\nraw binary data',
    truncated: true,
};
const legacyBody = [
    'Summarize this document',
    '',
    'File attachment: document.pdf (truncated)',
    '```text',
    legacyPdfAttachment.content,
    '```',
].join('\n');
const cleanedLegacyBody = hideBinaryAttachmentData(legacyBody, [legacyPdfAttachment]);

assert(cleanedLegacyBody.includes('PDF attachment: document.pdf (preview unavailable)'),
    'Legacy PDF message did not receive a clean summary');
assert(!cleanedLegacyBody.includes('%PDF'), 'Legacy PDF raw bytes remained visible');

const texture = Gdk.MemoryTexture.new(
    1,
    1,
    Gdk.MemoryFormat.R8G8B8A8,
    new GLib.Bytes(Uint8Array.from([0x33, 0x66, 0x99, 0xff])),
    4,
);
const pastedImageDirectory = GLib.build_filenamev([tempRoot, 'pasted-images']);
const pastedImagePath = savePastedImageTexture(texture, {
    directory: pastedImageDirectory,
});

assert(
    GLib.file_test(pastedImagePath, GLib.FileTest.IS_REGULAR),
    'Pasted clipboard texture was not persisted as an image attachment',
);
assert(
    GLib.path_get_basename(pastedImagePath).startsWith('pasted-image-')
        && pastedImagePath.endsWith('.png'),
    'Pasted clipboard texture did not receive a durable PNG path',
);

print('Cusco attachments smoke passed');
