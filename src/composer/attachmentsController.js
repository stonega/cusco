import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { presentImageViewer } from '../imageEditor/window.js';
import { setLoadedPicturePaintable } from '../chat/messageView.js';
import {
    createFileAttachment,
    createPastedTextAttachment,
    fileAttachmentSummary,
    savePastedImageTexture,
    shouldAttachPastedText,
} from '../chat/attachments.js';
import {
    clipboardFormatsContainImage,
    clipboardFormatsContainText,
    replacePendingAttachment,
} from '../chat/presentation.js';
import {
    attachmentPathExists,
    isImageAttachment,
    isImageAttachmentName,
    loadScaledImagePaintableAsync,
} from './attachmentPresentation.js';
import { normalizeComposerReferences } from './presentation.js';

const MAX_ATTACHMENT_TEXT_CHARS = 20000;
const THUMBNAIL_WIDTH = 36;
const THUMBNAIL_HEIGHT = 28;

function isOperationCancelled(error, cancellable = null) {
    return Boolean(cancellable?.is_cancelled?.())
        || (typeof error?.matches === 'function'
            && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
}

function clearContainer(container) {
    for (let child = container?.get_first_child?.(); child;) {
        const next = child.get_next_sibling();
        container.remove(child);
        child = next;
    }
}

export class ComposerAttachments {
    constructor({
        providerConfigs,
        conversations,
        getProviderPicker,
        getComposer,
        getComposerBuffer,
        getAttachmentRow,
        getAttachmentPreviewList,
        getParentWindow,
        showToast,
        presentWindow,
        focusComposer,
    }) {
        this._providerConfigs = providerConfigs;
        this._conversations = conversations;
        this._getProviderPicker = getProviderPicker;
        this._getComposer = getComposer;
        this._getComposerBuffer = getComposerBuffer;
        this._getAttachmentRow = getAttachmentRow;
        this._getAttachmentPreviewList = getAttachmentPreviewList;
        this._getParentWindow = getParentWindow;
        this._showToast = showToast;
        this._presentWindow = presentWindow;
        this._focusComposer = focusComposer;
        this.attachments = [];
        this._pasteCancellables = new Set();
        this._imageViewer = null;
    }

    dispose() {
        for (const cancellable of this._pasteCancellables)
            cancellable.cancel();
        this._pasteCancellables.clear();
        this._imageViewer = null;
    }

    supportsImages() {
        const providerId = this._conversations.activeConversation?.providerId
            ?? this._getProviderPicker()?.get_active_id?.()
            ?? '';
        return this._providerConfigs.getProvider(providerId)?.supportsImageAttachments !== false;
    }

    imageAttachCapability() {
        const allowed = this.supportsImages();
        return { allowed, reason: allowed ? '' : this.unsupportedMessage() };
    }

    unsupportedMessage() {
        const providerId = this._conversations.activeConversation?.providerId
            ?? this._getProviderPicker()?.get_active_id?.()
            ?? '';
        const provider = this._providerConfigs.getProvider(providerId);
        return `${provider?.name ?? 'The selected provider'} does not support image attachments.`;
    }

    openImageViewer(image) {
        const path = String(image?.path ?? '').trim();
        const attachmentToReplace = image?.attachmentToReplace ?? null;

        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this._showToast('That image is no longer available.');
            return null;
        }

        try {
            const viewer = presentImageViewer({
                parent: this._getParentWindow(),
                image: {
                    path,
                    title: String(image?.title ?? GLib.path_get_basename(path)),
                    mimeType: String(image?.mimeType ?? ''),
                    sourceKind: String(image?.sourceKind ?? 'image'),
                },
                getAttachCapability: () => this.imageAttachCapability(),
                onAttach: (outputPath) => this.attachEditedImage(outputPath, attachmentToReplace),
            });

            this._imageViewer = viewer;
            viewer.connect('destroy', () => {
                if (this._imageViewer === viewer)
                    this._imageViewer = null;
            });
            return viewer;
        } catch (error) {
            logError(error, `Failed to open image viewer: ${path}`);
            this._showToast('The image could not be opened.');
            return null;
        }
    }

    attachEditedImage(path, attachmentToReplace = null) {
        const capability = this.imageAttachCapability();
        if (!capability.allowed) {
            this._showToast(capability.reason);
            return false;
        }
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this._showToast('The edited image could not be found.');
            return false;
        }
        const editedAttachment = this.createAttachmentFromPath(path);
        let replaced = false;
        if (attachmentToReplace) {
            replaced = replacePendingAttachment(
                this.attachments,
                attachmentToReplace,
                editedAttachment,
            );
            if (!replaced) {
                this._showToast('The original attachment is no longer in the composer.');
                return false;
            }
        } else if (!this.attachments.some((attachment) => attachment.path === path)) {
            this.attachments.push(editedAttachment);
        }
        this.updatePreview();
        this._presentWindow();
        this._focusComposer();
        this._showToast(replaced
            ? 'Attachment replaced with the edited image.'
            : 'Edited image added to the composer.');
        return true;
    }

    pasteClipboardContent() {
        return this.pasteClipboardImage() || this.pasteClipboardText();
    }

    pasteClipboardImage() {
        const clipboard = this._getComposer()?.get_clipboard?.();
        if (!clipboardFormatsContainImage(clipboard?.get_formats?.()))
            return false;
        const capability = this.imageAttachCapability();
        if (!capability.allowed) {
            this._showToast(capability.reason);
            return true;
        }
        const cancellable = new Gio.Cancellable();
        this._pasteCancellables.add(cancellable);
        clipboard.read_texture_async(cancellable, (source, result) => {
            this._pasteCancellables.delete(cancellable);
            try {
                const texture = source.read_texture_finish(result);
                if (!texture)
                    throw new Error('The clipboard did not provide an image texture.');
                const path = savePastedImageTexture(texture);
                this.attachments.push(this.createAttachmentFromPath(path));
                this.updatePreview();
                this._focusComposer();
            } catch (error) {
                if (isOperationCancelled(error, cancellable))
                    return;
                logError(error, 'Failed to paste clipboard image');
                this._showToast('The clipboard image could not be attached.');
            }
        });
        return true;
    }

    pasteClipboardText() {
        const clipboard = this._getComposer()?.get_clipboard?.();
        if (!clipboardFormatsContainText(clipboard?.get_formats?.()))
            return false;
        const cancellable = new Gio.Cancellable();
        this._pasteCancellables.add(cancellable);
        clipboard.read_text_async(cancellable, (source, result) => {
            this._pasteCancellables.delete(cancellable);
            try {
                const text = source.read_text_finish(result);
                if (text)
                    this.handlePastedText(text);
            } catch (error) {
                if (isOperationCancelled(error, cancellable))
                    return;
                logError(error, 'Failed to paste clipboard text');
                this._showToast('The clipboard text could not be pasted.');
            }
        });
        return true;
    }

    handlePastedText(text) {
        if (!shouldAttachPastedText(text)) {
            this.insertPastedText(text);
            return false;
        }
        try {
            this.attachments.push(createPastedTextAttachment(text, {
                maxTextCharacters: MAX_ATTACHMENT_TEXT_CHARS,
            }));
            this.updatePreview();
            this._focusComposer();
            this._showToast('Long pasted text added as an article attachment.');
            return true;
        } catch (error) {
            logError(error, 'Failed to create an attachment from pasted text');
            this.insertPastedText(text);
            this._showToast('The article attachment could not be created, so the text was pasted instead.');
            return false;
        }
    }

    insertPastedText(text) {
        const buffer = this._getComposerBuffer();
        buffer.begin_user_action();
        buffer.delete_selection(true, true);
        buffer.insert_at_cursor(String(text ?? ''), -1);
        buffer.end_user_action();
        this._focusComposer();
    }

    attachFile() {
        const dialog = new Gtk.FileDialog({ title: 'Attach File or Image' });
        dialog.open(this._getParentWindow(), null, (_dialog, result) => {
            try {
                const path = dialog.open_finish(result).get_path();
                if (!path)
                    throw new Error('Only local file attachments are supported right now');
                const isImage = isImageAttachmentName(GLib.path_get_basename(path));
                if (isImage && !this.supportsImages()) {
                    this._showToast(this.unsupportedMessage());
                    return;
                }
                this.attachments.push(this.createAttachmentFromPath(path));
                this.updatePreview();
            } catch (error) {
                logError(error, 'Failed to attach file');
            }
        });
    }

    createAttachmentFromPath(path) {
        const name = GLib.path_get_basename(path);
        if (isImageAttachmentName(name))
            return { kind: 'image', name, path };
        return createFileAttachment(path, { maxTextCharacters: MAX_ATTACHMENT_TEXT_CHARS });
    }

    createAttachmentsForReferences(references, existingAttachments = []) {
        const attachments = existingAttachments.map((attachment) => ({ ...attachment }));
        const attachedPaths = new Set(attachments.map((attachment) => attachment.path).filter(Boolean));
        for (const reference of normalizeComposerReferences(references)) {
            if (reference.kind !== 'file' || attachedPaths.has(reference.value))
                continue;
            if (!GLib.file_test(reference.value, GLib.FileTest.EXISTS)) {
                this._showToast(`${reference.title || 'Referenced file'} no longer exists.`);
                continue;
            }
            if (isImageAttachmentName(reference.value) && !this.supportsImages()) {
                this._showToast(this.unsupportedMessage());
                continue;
            }
            try {
                attachments.push(this.createAttachmentFromPath(reference.value));
                attachedPaths.add(reference.value);
            } catch (error) {
                logError(error, `Failed to read referenced file ${reference.value}`);
                this._showToast(`Could not read ${reference.title || GLib.path_get_basename(reference.value)}.`);
            }
        }
        return attachments;
    }

    consume() {
        const attachments = this.attachments.map((attachment) => ({ ...attachment }));
        this.attachments = [];
        this.updatePreview();
        return attachments;
    }

    discardUnsupportedImages() {
        if (this.supportsImages())
            return;
        const nextAttachments = this.attachments.filter((attachment) => !isImageAttachment(attachment));
        if (nextAttachments.length === this.attachments.length)
            return;
        this.attachments = nextAttachments;
        this.updatePreview();
        this._showToast(this.unsupportedMessage());
    }

    remove(index) {
        this.attachments.splice(index, 1);
        this.updatePreview();
        this._focusComposer();
    }

    updatePreview() {
        const list = this._getAttachmentPreviewList();
        const row = this._getAttachmentRow();
        if (!list || !row)
            return;
        clearContainer(list);
        if (this.attachments.length === 0) {
            row.set_visible(false);
            return;
        }
        this.attachments.forEach((attachment, index) => {
            list.append(this.createPendingPreview(attachment, index));
        });
        row.set_visible(true);
    }

    createPendingPreview(attachment, index) {
        return this.createPreviewCard(attachment, {
            onRemove: () => this.remove(index),
            removeTooltip: `Remove ${attachment.name}`,
            attachmentToReplace: attachment,
        });
    }

    createPreviewCard(attachment, options = {}) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });
        card.add_css_class('cusco-composer-attachment-preview');
        const canLoadImage = isImageAttachment(attachment) && attachmentPathExists(attachment);
        if (canLoadImage) {
            const picture = new Gtk.Picture({ can_shrink: true, keep_aspect_ratio: true });
            picture.set_content_fit(Gtk.ContentFit.COVER);
            picture.set_size_request(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
            picture.add_css_class('cusco-composer-attachment-thumbnail');
            const imageButton = new Gtk.Button({
                child: picture,
                tooltip_text: `Open ${attachment.name}`,
                valign: Gtk.Align.CENTER,
            });
            imageButton.add_css_class('flat');
            imageButton.add_css_class('cusco-attachment-image-button');
            imageButton.connect('clicked', () => this.openImageViewer({
                path: attachment.path,
                title: attachment.name,
                mimeType: attachment.contentType ?? '',
                sourceKind: options.onRemove ? 'composer-attachment' : 'message-attachment',
                attachmentToReplace: options.attachmentToReplace ?? null,
            }));
            card.append(imageButton);
            loadScaledImagePaintableAsync(
                attachment.path,
                THUMBNAIL_WIDTH,
                THUMBNAIL_HEIGHT,
                (paintable) => setLoadedPicturePaintable(picture, paintable),
            );
        } else {
            const icon = new Gtk.Image({
                icon_name: isImageAttachment(attachment)
                    ? 'image-missing-symbolic'
                    : 'text-x-generic-symbolic',
                pixel_size: 22,
                valign: Gtk.Align.CENTER,
            });
            icon.add_css_class('cusco-composer-attachment-icon');
            card.append(icon);
        }
        const textBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            valign: Gtk.Align.CENTER,
        });
        const nameLabel = new Gtk.Label({
            label: attachment.name,
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 24,
        });
        const kindLabel = new Gtk.Label({
            label: isImageAttachment(attachment) ? 'Image' : 'File',
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 24,
        });
        kindLabel.add_css_class('caption');
        kindLabel.add_css_class('dim-label');
        textBox.append(nameLabel);
        textBox.append(kindLabel);
        card.append(textBox);
        if (options.onRemove) {
            const removeButton = new Gtk.Button({
                icon_name: 'window-close-symbolic',
                tooltip_text: options.removeTooltip ?? `Remove ${attachment.name}`,
                valign: Gtk.Align.CENTER,
            });
            removeButton.add_css_class('flat');
            removeButton.add_css_class('circular');
            removeButton.connect('clicked', options.onRemove);
            card.append(removeButton);
        }
        return card;
    }

    formatUserMessageContent(text, attachments) {
        if (attachments.length === 0)
            return text;
        const attachmentText = attachments.map((attachment) => (
            attachment.kind === 'image'
                ? `Image attachment: ${attachment.name}`
                : fileAttachmentSummary(attachment)
        )).join('\n\n');
        return [text, attachmentText].filter(Boolean).join('\n\n');
    }
}
