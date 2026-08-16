import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const IMAGE_ATTACHMENT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const MAX_CACHED_ATTACHMENT_THUMBNAILS = 48;
const SCALED_IMAGE_PAINTABLE_CACHE = new Map();
const PENDING_SCALED_IMAGE_LOADS = new Map();

export function isImageAttachmentName(name) {
    const lowerName = String(name ?? '').toLowerCase();
    return IMAGE_ATTACHMENT_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

export function isImageAttachment(attachment) {
    return attachment?.kind === 'image' || isImageAttachmentName(attachment?.name);
}

function imageAttachmentSummaryLine(attachment) {
    return `Image attachment: ${attachment.name}`;
}

export function attachmentPathExists(attachment) {
    const path = String(attachment?.path ?? '').trim();
    return Boolean(path) && GLib.file_test(path, GLib.FileTest.EXISTS);
}

function cacheScaledImagePaintable(cacheKey, paintable) {
    SCALED_IMAGE_PAINTABLE_CACHE.delete(cacheKey);
    SCALED_IMAGE_PAINTABLE_CACHE.set(cacheKey, paintable);

    while (SCALED_IMAGE_PAINTABLE_CACHE.size > MAX_CACHED_ATTACHMENT_THUMBNAILS) {
        const oldestKey = SCALED_IMAGE_PAINTABLE_CACHE.keys().next().value;
        SCALED_IMAGE_PAINTABLE_CACHE.delete(oldestKey);
    }
}

export function loadScaledImagePaintableAsync(path, width, height, onLoaded) {
    const cacheKey = `${path}\u0000${width}\u0000${height}`;
    const cached = SCALED_IMAGE_PAINTABLE_CACHE.get(cacheKey);

    if (cached) {
        cacheScaledImagePaintable(cacheKey, cached);
        onLoaded(cached);
        return;
    }

    const pendingCallbacks = PENDING_SCALED_IMAGE_LOADS.get(cacheKey);

    if (pendingCallbacks) {
        pendingCallbacks.push(onLoaded);
        return;
    }

    PENDING_SCALED_IMAGE_LOADS.set(cacheKey, [onLoaded]);
    const complete = (paintable) => {
        const callbacks = PENDING_SCALED_IMAGE_LOADS.get(cacheKey) ?? [];
        PENDING_SCALED_IMAGE_LOADS.delete(cacheKey);

        if (paintable)
            cacheScaledImagePaintable(cacheKey, paintable);

        callbacks.forEach((callback) => callback(paintable));
    };
    const file = Gio.File.new_for_path(path);

    file.read_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
        let stream;

        try {
            stream = source.read_finish(result);
        } catch (error) {
            logError(error, `Failed to open image preview: ${path}`);
            complete(null);
            return;
        }

        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            stream,
            width,
            height,
            true,
            null,
            (_source, loadResult) => {
                try {
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(loadResult);
                    complete(Gdk.Texture.new_for_pixbuf(pixbuf));
                } catch (error) {
                    logError(error, `Failed to decode image preview: ${path}`);
                    complete(null);
                } finally {
                    try {
                        stream.close(null);
                    } catch (_error) {
                        // The loader may already have closed the stream after an error.
                    }
                }
            },
        );
    });
}

export function displayBodyWithoutImageAttachmentLines(body, message) {
    const text = String(body ?? '');
    const imageSummaryLines = new Set((message?.attachments ?? [])
        .filter(isImageAttachment)
        .map(imageAttachmentSummaryLine));

    if (imageSummaryLines.size === 0)
        return text;

    return text
        .split('\n')
        .filter((line) => !imageSummaryLines.has(line.trim()))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
