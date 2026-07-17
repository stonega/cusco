import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import Pango from 'gi://Pango?version=1.0';

import { artifactForCodeBlock } from './artifacts.js';
import {
    inlineMarkdownToPangoMarkup,
    markdownToPangoMarkup,
    parseMarkdownBlocks,
} from './markdown.js';
import {
    getCodeThemeStyleScheme,
    getCodeThemeVariant,
} from './codeThemes.js';

const LANGUAGE_ALIASES = {
    bash: 'sh',
    shell: 'sh',
    html: 'html',
    htm: 'html',
    svg: 'xml',
    xml: 'xml',
    javascript: 'js',
    typescript: 'js',
    py: 'python3',
    python: 'python3',
    rb: 'ruby',
    rs: 'rust',
    yml: 'yaml',
};
const DEFAULT_CODE_MIN_WIDTH = 360;
const CONTENT_UPDATE_INTERVAL_MS = 33;
const SYNTAX_HIGHLIGHT_INTERVAL_MS = 16;
const ARTIFACT_PREVIEW_WIDTH = 360;
const ARTIFACT_PREVIEW_HEIGHT = 240;
const ARTIFACT_TEXTURE_INTERVAL_MS = 16;
const MAX_CACHED_ARTIFACT_PREVIEWS = 24;
const UTF8_ENCODER = new TextEncoder();
const PENDING_SYNTAX_HIGHLIGHTS = [];
const ARTIFACT_PREVIEW_CACHE = new Map();
const PENDING_ARTIFACT_PREVIEW_LOADS = new Map();
const PENDING_ARTIFACT_TEXTURES = [];
let syntaxHighlightSourceId = 0;
let artifactTextureSourceId = 0;

function queueArtifactTexture(pixbuf, onCreated) {
    PENDING_ARTIFACT_TEXTURES.push({ pixbuf, onCreated });

    if (artifactTextureSourceId)
        return;

    artifactTextureSourceId = GLib.timeout_add(
        GLib.PRIORITY_LOW,
        ARTIFACT_TEXTURE_INTERVAL_MS,
        () => {
            const pending = PENDING_ARTIFACT_TEXTURES.shift();

            if (pending)
                pending.onCreated(Gdk.Texture.new_for_pixbuf(pending.pixbuf));

            if (PENDING_ARTIFACT_TEXTURES.length > 0)
                return GLib.SOURCE_CONTINUE;

            artifactTextureSourceId = 0;
            return GLib.SOURCE_REMOVE;
        },
    );
}

function cacheArtifactPreview(path, paintable) {
    ARTIFACT_PREVIEW_CACHE.delete(path);
    ARTIFACT_PREVIEW_CACHE.set(path, paintable);

    while (ARTIFACT_PREVIEW_CACHE.size > MAX_CACHED_ARTIFACT_PREVIEWS) {
        const oldestPath = ARTIFACT_PREVIEW_CACHE.keys().next().value;
        ARTIFACT_PREVIEW_CACHE.delete(oldestPath);
    }
}

function loadArtifactPreviewAsync(path, onLoaded) {
    const cached = ARTIFACT_PREVIEW_CACHE.get(path);

    if (cached) {
        cacheArtifactPreview(path, cached);
        onLoaded(cached);
        return;
    }

    const pendingCallbacks = PENDING_ARTIFACT_PREVIEW_LOADS.get(path);

    if (pendingCallbacks) {
        pendingCallbacks.push(onLoaded);
        return;
    }

    PENDING_ARTIFACT_PREVIEW_LOADS.set(path, [onLoaded]);
    const complete = (paintable) => {
        const callbacks = PENDING_ARTIFACT_PREVIEW_LOADS.get(path) ?? [];
        PENDING_ARTIFACT_PREVIEW_LOADS.delete(path);

        if (paintable)
            cacheArtifactPreview(path, paintable);

        callbacks.forEach((callback) => callback(paintable));
    };
    const file = Gio.File.new_for_path(path);

    file.read_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
        let stream;

        try {
            stream = source.read_finish(result);
        } catch (error) {
            logError(error, `Failed to open artifact preview: ${path}`);
            complete(null);
            return;
        }

        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            stream,
            ARTIFACT_PREVIEW_WIDTH,
            ARTIFACT_PREVIEW_HEIGHT,
            true,
            null,
            (_source, loadResult) => {
                try {
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(loadResult);
                    queueArtifactTexture(pixbuf, complete);
                } catch (error) {
                    logError(error, `Failed to decode artifact preview: ${path}`);
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

function scheduleSyntaxHighlight(buffer, owner, languageId, codeTheme) {
    PENDING_SYNTAX_HIGHLIGHTS.push({
        buffer,
        owner,
        languageId,
        codeTheme,
    });

    if (syntaxHighlightSourceId)
        return;

    syntaxHighlightSourceId = GLib.timeout_add(
        GLib.PRIORITY_LOW,
        SYNTAX_HIGHLIGHT_INTERVAL_MS,
        () => {
            const pending = PENDING_SYNTAX_HIGHLIGHTS.shift();

            if (pending?.owner.get_root()) {
                const language = getLanguage(pending.languageId);
                const styleScheme = getCodeThemeStyleScheme(pending.codeTheme);

                if (language)
                    pending.buffer.set_language(language);

                if (styleScheme)
                    pending.buffer.set_style_scheme(styleScheme);

                pending.buffer.set_highlight_syntax(Boolean(language));
            }

            if (PENDING_SYNTAX_HIGHLIGHTS.length > 0)
                return GLib.SOURCE_CONTINUE;

            syntaxHighlightSourceId = 0;
            return GLib.SOURCE_REMOVE;
        },
    );
}

function tableAlignmentXalign(alignment) {
    if (alignment === 'right')
        return 1;

    if (alignment === 'center')
        return 0.5;

    return 0;
}

function clearBox(box) {
    let child = box.get_first_child();

    while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
}

function pangoColorComponents(value) {
    const color = new Gdk.RGBA();

    if (!color.parse(String(value ?? '')))
        return null;

    return [color.red, color.green, color.blue]
        .map((component) => Math.round(component * 65535));
}

function insertReferenceAttribute(attributes, attribute, startIndex, endIndex) {
    if (!attribute)
        return;

    attribute.start_index = startIndex;
    attribute.end_index = endIndex;
    attributes.insert(attribute);
}

export function applyReferenceTextStyles(label, references = [], styles = {}) {
    const text = String(label?.get_text?.() ?? '');
    const attributes = new Pango.AttrList();
    const seenReferences = new Set();
    let hasAttributes = false;

    for (const reference of Array.isArray(references) ? references : []) {
        const kind = String(reference?.kind ?? '');
        const token = String(reference?.insertText ?? '');
        const style = styles?.[kind];
        const referenceKey = `${kind}\u0000${token}`;

        if (!token || !style || seenReferences.has(referenceKey))
            continue;

        seenReferences.add(referenceKey);
        const foreground = pangoColorComponents(style.foreground);
        const background = pangoColorComponents(style.background);
        let index = text.indexOf(token);

        while (index >= 0) {
            const startIndex = UTF8_ENCODER.encode(text.slice(0, index)).length;
            const endIndex = startIndex + UTF8_ENCODER.encode(token).length;

            if (foreground) {
                insertReferenceAttribute(
                    attributes,
                    Pango.attr_foreground_new(...foreground),
                    startIndex,
                    endIndex,
                );
            }

            if (background) {
                insertReferenceAttribute(
                    attributes,
                    Pango.attr_background_new(...background),
                    startIndex,
                    endIndex,
                );
            }

            insertReferenceAttribute(
                attributes,
                Pango.attr_weight_new(Pango.Weight.BOLD),
                startIndex,
                endIndex,
            );
            hasAttributes = true;
            index = text.indexOf(token, index + token.length);
        }
    }

    label?.set_attributes?.(hasAttributes ? attributes : null);
}

function getLanguage(languageId) {
    if (!languageId)
        return null;

    const normalizedLanguageId = LANGUAGE_ALIASES[languageId.toLowerCase()] ?? languageId.toLowerCase();
    return GtkSource.LanguageManager.get_default().get_language(normalizedLanguageId);
}

function createMarkdownLabel(content, options = {}) {
    const label = new Gtk.Label({
        wrap: true,
        selectable: true,
        xalign: 0,
        max_width_chars: options.role === 'user' ? 36 : 82,
    });
    label.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    label.set_use_markup(true);
    label.set_markup(markdownToPangoMarkup(content) || ' ');
    label.add_css_class('cusco-message-markdown');
    applyReferenceTextStyles(label, options.references, options.referenceStyles);

    return label;
}

function createTableCell(content, options = {}) {
    const columnCount = Math.max(1, options.columnCount ?? 1);
    const maxWidthChars = options.role === 'user'
        ? Math.max(14, Math.floor(36 / columnCount))
        : Math.max(16, Math.min(36, Math.floor(82 / columnCount) + 8));
    const label = new Gtk.Label({
        wrap: true,
        selectable: true,
        xalign: tableAlignmentXalign(options.alignment),
        max_width_chars: maxWidthChars,
        hexpand: true,
    });
    const markup = inlineMarkdownToPangoMarkup(content) || ' ';

    label.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    label.set_use_markup(true);
    label.set_markup(options.header ? `<b>${markup}</b>` : markup);
    label.add_css_class('cusco-table-cell');

    if (options.header)
        label.add_css_class('cusco-table-header-cell');

    applyReferenceTextStyles(label, options.references, options.referenceStyles);

    return label;
}

function createMarkdownTable(block, options = {}) {
    const columnCount = block.headers.length;
    const grid = new Gtk.Grid({
        column_spacing: 0,
        row_spacing: 0,
        hexpand: true,
    });
    grid.add_css_class('cusco-markdown-table');

    block.headers.forEach((header, column) => {
        grid.attach(createTableCell(header, {
            alignment: block.alignments[column],
            columnCount,
            header: true,
            role: options.role,
            references: options.references,
            referenceStyles: options.referenceStyles,
        }), column, 0, 1, 1);
    });

    block.rows.forEach((row, rowIndex) => {
        row.forEach((cell, column) => {
            grid.attach(createTableCell(cell, {
                alignment: block.alignments[column],
                columnCount,
                role: options.role,
                references: options.references,
                referenceStyles: options.referenceStyles,
            }), column, rowIndex + 1, 1, 1);
        });
    });

    return grid;
}

function createMarkdownDivider() {
    const separator = new Gtk.Separator({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
    });
    separator.add_css_class('cusco-markdown-divider');
    return separator;
}

export function copyTextToClipboard(text) {
    const display = Gdk.Display.get_default();
    const clipboard = display?.get_clipboard();

    clipboard?.set(text);
}

function artifactFileExists(artifact) {
    const path = String(artifact?.path ?? '').trim();
    return Boolean(path) && GLib.file_test(path, GLib.FileTest.EXISTS);
}

function artifactSourceText(artifact, fallback = '') {
    if ((artifact?.kind !== 'svg' && artifact?.kind !== 'html') || !artifactFileExists(artifact))
        return String(fallback ?? '');

    try {
        const [, contents] = GLib.file_get_contents(artifact.path);
        return new TextDecoder().decode(contents);
    } catch (error) {
        logError(error, `Failed to read artifact source: ${artifact.path}`);
        return String(fallback ?? '');
    }
}

function artifactSaveName(artifact) {
    const title = String(artifact?.title ?? artifact?.kind ?? 'artifact')
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-|-$/g, '')
        || 'artifact';

    switch (artifact?.kind) {
    case 'svg':
        return `${title}.svg`;
    case 'html':
        return `${title}.html`;
    case 'image': {
        const extension = String(artifact.mimeType ?? '').toLowerCase() === 'image/svg+xml'
            ? 'svg'
            : String(artifact.mimeType ?? '').toLowerCase() === 'image/jpeg'
                ? 'jpg'
                : String(artifact.mimeType ?? '').toLowerCase() === 'image/webp'
                    ? 'webp'
                    : 'png';
        return `${title}.${extension}`;
    }
    default:
        return `${title}.txt`;
    }
}

function createArtifactActionButton(iconName, tooltipText, onClicked) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
    });

    button.add_css_class('flat');
    button.connect('clicked', onClicked);
    return button;
}

function saveArtifactAs(artifact, parent, fallbackSource = '') {
    const dialog = new Gtk.FileDialog({
        title: `Save ${artifact.title}`,
        initial_name: artifactSaveName(artifact),
    });

    dialog.save(parent ?? null, null, (_dialog, result) => {
        try {
            const file = dialog.save_finish(result);
            const targetPath = file.get_path();

            if (!targetPath)
                throw new Error('Only local artifact save paths are supported right now');

            if (artifactFileExists(artifact)) {
                Gio.File.new_for_path(artifact.path).copy(
                    Gio.File.new_for_path(targetPath),
                    Gio.FileCopyFlags.OVERWRITE,
                    null,
                    null,
                );
                return;
            }

            const source = artifactSourceText(artifact, fallbackSource);

            if (!source)
                throw new Error('Artifact source is not available.');

            GLib.file_set_contents(targetPath, source);
        } catch (error) {
            logError(error, 'Failed to save artifact');
        }
    });
}

function openArtifactExternally(artifact, parent) {
    if (!artifactFileExists(artifact))
        return;

    try {
        Gtk.show_uri(parent ?? null, Gio.File.new_for_path(artifact.path).get_uri(), 0);
    } catch (error) {
        logError(error, `Failed to open artifact: ${artifact.path}`);
    }
}

function createArtifactHeader(artifact, source, options = {}) {
    const header = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 8,
        margin_end: 8,
    });
    header.add_css_class('cusco-artifact-header');

    const titleBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 1,
        hexpand: true,
    });
    const titleLabel = new Gtk.Label({
        label: artifact.title,
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
    });
    const metaLabel = new Gtk.Label({
        label: artifact.kind === 'html'
            ? 'HTML'
            : artifact.kind === 'svg'
                ? 'SVG'
                : artifact.mimeType,
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
    });
    metaLabel.add_css_class('caption');
    metaLabel.add_css_class('dim-label');
    titleBox.append(titleLabel);
    titleBox.append(metaLabel);
    header.append(titleBox);

    const copyText = artifact.kind === 'image'
        ? String(artifact.path ?? '')
        : artifactSourceText(artifact, source);
    const copyButton = createArtifactActionButton(
        'edit-copy-symbolic',
        artifact.kind === 'image' ? 'Copy image path' : 'Copy source',
        () => {
            copyTextToClipboard(copyText);
            options.onCopyArtifact?.(artifact);
        },
    );
    copyButton.set_sensitive(Boolean(copyText));
    header.append(copyButton);

    const saveButton = createArtifactActionButton(
        'document-save-symbolic',
        'Save artifact',
        () => saveArtifactAs(artifact, options.parentWindow, source),
    );
    saveButton.set_sensitive(artifactFileExists(artifact) || Boolean(source));
    header.append(saveButton);

    const openButton = createArtifactActionButton(
        'document-open-symbolic',
        'Open artifact',
        () => openArtifactExternally(artifact, options.parentWindow),
    );
    openButton.set_sensitive(artifactFileExists(artifact));
    header.append(openButton);

    return header;
}

function createArtifactImagePreview(artifact) {
    if (!artifactFileExists(artifact)) {
        const missing = new Gtk.Label({
            label: 'Artifact file is missing.',
            xalign: 0,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 10,
            margin_end: 10,
        });
        missing.add_css_class('dim-label');
        return missing;
    }

    const picture = new Gtk.Picture({
        can_shrink: true,
        keep_aspect_ratio: true,
        hexpand: false,
        vexpand: false,
    });

    picture.set_content_fit(Gtk.ContentFit.CONTAIN);
    picture.set_size_request(360, 240);
    picture.add_css_class('cusco-artifact-picture');
    loadArtifactPreviewAsync(artifact.path, (paintable) => {
        if (paintable && picture.get_parent())
            picture.set_paintable(paintable);
    });
    return picture;
}

function createArtifactSourcePreview(source, language, options = {}) {
    const block = {
        type: 'code',
        language,
        content: String(source ?? ''),
    };
    const preview = createCodeBlock(block, {
        ...options,
        codeMinWidth: options.codeMinWidth ?? DEFAULT_CODE_MIN_WIDTH,
    });

    preview.add_css_class('cusco-artifact-source-preview');
    return preview;
}

export function createArtifactCard(artifact, options = {}) {
    const source = String(options.source ?? '');
    const card = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        hexpand: true,
    });
    card.add_css_class('cusco-artifact-card');
    card.add_css_class(`cusco-artifact-${artifact.kind}`);

    card.append(createArtifactHeader(artifact, source, options));

    if (artifact.kind === 'image') {
        card.append(createArtifactImagePreview(artifact));
    } else if (artifact.kind === 'svg') {
        card.append(artifactFileExists(artifact) || !source
            ? createArtifactImagePreview(artifact)
            : createArtifactSourcePreview(source, 'xml', options));
    } else {
        card.append(createArtifactSourcePreview(artifactSourceText(artifact, source), 'html', options));
    }

    return card;
}

function createCodeBlock(block, options) {
    const outer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        hexpand: true,
    });
    outer.add_css_class('cusco-code-block');
    outer.add_css_class(`cusco-code-block-${getCodeThemeVariant(options.codeTheme)}`);

    const header = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 8,
        margin_end: 8,
    });
    header.add_css_class('cusco-code-header');

    const languageLabel = new Gtk.Label({
        label: block.language || 'code',
        xalign: 0,
        hexpand: true,
    });
    languageLabel.add_css_class('caption');
    languageLabel.add_css_class('dim-label');

    const copyButton = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        tooltip_text: 'Copy code',
        valign: Gtk.Align.CENTER,
    });
    copyButton.add_css_class('flat');
    copyButton.connect('clicked', () => {
        copyTextToClipboard(block.content);
        options.onCopyCode?.();
    });

    header.append(languageLabel);
    header.append(copyButton);
    outer.append(header);

    const buffer = new GtkSource.Buffer();

    buffer.set_highlight_syntax(false);
    buffer.set_text(block.content, -1);

    const view = new GtkSource.View({
        buffer,
        editable: false,
        cursor_visible: false,
        monospace: true,
        hexpand: true,
    });
    view.add_css_class('cusco-code-view');

    const lineCount = Math.max(1, block.content.split('\n').length);
    const scroller = new Gtk.ScrolledWindow({
        child: view,
        hexpand: true,
        hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        min_content_width: options.codeMinWidth ?? DEFAULT_CODE_MIN_WIDTH,
        min_content_height: Math.min(220, Math.max(72, lineCount * 22)),
        max_content_height: 280,
        propagate_natural_height: true,
    });
    outer.append(scroller);

    scheduleSyntaxHighlight(buffer, outer, block.language, options.codeTheme);

    return outer;
}

export function renderMessageContent(container, body, options = {}) {
    clearBox(container);

    for (const [index, block] of parseMarkdownBlocks(body).entries()) {
        if (block.type === 'code') {
            const artifact = artifactForCodeBlock(options.artifacts, index, block);

            container.append(artifact
                ? createArtifactCard(artifact, {
                    ...options,
                    source: block.content,
                    sourceLanguage: block.language,
                })
                : createCodeBlock(block, options));
        } else if (block.type === 'divider') {
            container.append(createMarkdownDivider());
        } else if (block.type === 'table') {
            container.append(createMarkdownTable(block, options));
        } else {
            container.append(createMarkdownLabel(block.content, options));
        }
    }
}

export function createMessageContent(body, options = {}) {
    const container = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        hexpand: Boolean(options.hexpand),
    });
    const renderingOptions = { ...options };
    let currentBody = String(body ?? '');
    let renderedBody = null;
    let renderSourceId = 0;
    const render = (force = false) => {
        if (!force && currentBody === renderedBody)
            return;

        renderMessageContent(container, currentBody, renderingOptions);
        renderedBody = currentBody;
    };
    const cancelQueuedRender = () => {
        if (!renderSourceId)
            return;

        GLib.source_remove(renderSourceId);
        renderSourceId = 0;
    };

    render();
    container.updateContent = (nextBody, updateOptions = {}) => {
        const normalizedBody = String(nextBody ?? '');

        if (normalizedBody === currentBody && !updateOptions.force)
            return;

        currentBody = normalizedBody;

        if (!updateOptions.defer) {
            cancelQueuedRender();
            render(Boolean(updateOptions.force));
            return;
        }

        if (renderSourceId)
            return;

        renderSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            CONTENT_UPDATE_INTERVAL_MS,
            () => {
                renderSourceId = 0;
                render();
                return GLib.SOURCE_REMOVE;
            },
        );
    };
    container.updateReferenceStyles = (referenceStyles) => {
        renderingOptions.referenceStyles = referenceStyles;
        cancelQueuedRender();
        render(true);
    };
    return container;
}
