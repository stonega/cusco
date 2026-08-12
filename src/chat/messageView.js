import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import Pango from 'gi://Pango?version=1.0';

import { createManagedArtifactCard } from '../artifacts/views/artifactCard.js';
import { artifactForCodeBlock } from './artifacts.js';
import {
    inlineMarkdownToPangoMarkup,
    markdownToPangoRenderModel,
    parseMarkdownBlocks,
    stabilizeStreamingMarkdown,
} from './markdown.js';
import {
    getCodeThemeStyleScheme,
    getCodeThemeVariant,
} from './codeThemes.js';
import { AnimatedMarkdownLabel } from './streamAnimation.js';
import {
    normalizeStreamAnimationStyle,
    StreamingTextSmoother,
} from './streamingText.js';

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
const LONG_CONTENT_UPDATE_INTERVAL_MS = 100;
const VERY_LONG_CONTENT_UPDATE_INTERVAL_MS = 250;
const LONG_CONTENT_THRESHOLD = 25_000;
const VERY_LONG_CONTENT_THRESHOLD = 100_000;
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

function contentUpdateInterval(body) {
    if (body.length >= VERY_LONG_CONTENT_THRESHOLD)
        return VERY_LONG_CONTENT_UPDATE_INTERVAL_MS;

    if (body.length >= LONG_CONTENT_THRESHOLD)
        return LONG_CONTENT_UPDATE_INTERVAL_MS;

    return CONTENT_UPDATE_INTERVAL_MS;
}

export function setLoadedPicturePaintable(picture, paintable) {
    // Cache hits can complete while a newly constructed picture is still parentless.
    // Gtk.Picture accepts a paintable before it is added to the widget tree.
    if (paintable)
        picture.set_paintable(paintable);
}

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

function scheduleSyntaxHighlight(buffer, owner, languageId) {
    PENDING_SYNTAX_HIGHLIGHTS.push({
        buffer,
        owner,
        languageId,
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

                if (language)
                    pending.buffer.set_language(language);

                pending.buffer.set_highlight_syntax(Boolean(language));
            }

            if (PENDING_SYNTAX_HIGHLIGHTS.length > 0)
                return GLib.SOURCE_CONTINUE;

            syntaxHighlightSourceId = 0;
            return GLib.SOURCE_REMOVE;
        },
    );
}

export function initializeCodeBufferTheme(buffer, codeTheme) {
    const styleScheme = getCodeThemeStyleScheme(codeTheme);

    if (styleScheme)
        buffer.set_style_scheme(styleScheme);

    return styleScheme;
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
    const label = new AnimatedMarkdownLabel({
        wrap: true,
        selectable: options.selectable !== false,
        xalign: 0,
        max_width_chars: options.role === 'user' ? 36 : 82,
    });
    let initialized = false;
    label.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    label.set_use_markup(true);
    label.add_css_class('cusco-message-markdown');
    label.updateMarkdown = (nextContent, nextOptions = options) => {
        label.configureStreamAnimation({
            style: nextOptions.streamAnimationStyle ?? 'none',
            motionEnabled: nextOptions.motionEnabled,
        });
        label.set_selectable(nextOptions.selectable !== false);
        label.setRenderModel(markdownToPangoRenderModel(nextContent), {
            animate: initialized && nextOptions.streaming === true,
            replace: nextOptions.streamReplace === true,
        });
        applyReferenceTextStyles(label, nextOptions.references, nextOptions.referenceStyles);
        initialized = true;
    };
    label.finishAnimation = () => label.waitForAnimations();
    label.updateMarkdown(content, options);

    return label;
}

function createTableCell(content, options = {}) {
    const columnCount = Math.max(1, options.columnCount ?? 1);
    const maxWidthChars = options.role === 'user'
        ? Math.max(14, Math.floor(36 / columnCount))
        : Math.max(16, Math.min(36, Math.floor(82 / columnCount) + 8));
    const label = new Gtk.Label({
        wrap: true,
        selectable: options.selectable !== false,
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

function artifactImageDescriptor(artifact) {
    return {
        path: String(artifact?.path ?? ''),
        title: String(artifact?.title ?? artifact?.name ?? 'Image'),
        mimeType: String(artifact?.mimeType ?? ''),
        sourceKind: 'artifact',
    };
}

function openArtifact(artifact, parent, options = {}) {
    if (!artifactFileExists(artifact))
        return;

    if ((artifact?.kind === 'image' || artifact?.kind === 'svg') && options.onOpenImage) {
        options.onOpenImage(artifactImageDescriptor(artifact));
        return;
    }

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
        () => openArtifact(artifact, options.parentWindow, options),
    );
    openButton.set_sensitive(artifactFileExists(artifact));
    header.append(openButton);

    return header;
}

function createArtifactImagePreview(artifact, options = {}) {
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
    loadArtifactPreviewAsync(
        artifact.path,
        (paintable) => setLoadedPicturePaintable(picture, paintable),
    );

    const openButton = new Gtk.Button({
        child: picture,
        tooltip_text: 'Open image',
        halign: Gtk.Align.START,
    });
    openButton.add_css_class('flat');
    openButton.add_css_class('cusco-artifact-picture-button');
    openButton.connect('clicked', () => {
        openArtifact(artifact, options.parentWindow, options);
    });
    return openButton;
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
    if (artifact?.artifactId) {
        return createManagedArtifactCard(artifact, {
            ...options,
            artifactManager: options.artifactManager,
            artifactRegistry: options.artifactRegistry,
        });
    }

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
        card.append(createArtifactImagePreview(artifact, options));
    } else if (artifact.kind === 'svg') {
        card.append(artifactFileExists(artifact) || !source
            ? createArtifactImagePreview(artifact, options)
            : createArtifactSourcePreview(source, 'xml', options));
    } else {
        card.append(createArtifactSourcePreview(artifactSourceText(artifact, source), 'html', options));
    }

    return card;
}

function createCodeBlock(block, options) {
    let currentBlock = { ...block };
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
        copyTextToClipboard(currentBlock.content);
        options.onCopyCode?.();
    });

    header.append(languageLabel);
    header.append(copyButton);
    outer.append(header);

    const buffer = new GtkSource.Buffer();

    buffer.set_highlight_syntax(false);
    initializeCodeBufferTheme(buffer, options.codeTheme);
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

    scheduleSyntaxHighlight(buffer, outer, block.language);

    outer.updateCodeBlock = (nextBlock) => {
        const nextLanguage = String(nextBlock?.language ?? '');
        const nextContent = String(nextBlock?.content ?? '');
        const languageChanged = nextLanguage !== currentBlock.language;

        currentBlock = {
            type: 'code',
            language: nextLanguage,
            content: nextContent,
        };
        languageLabel.set_label(nextLanguage || 'code');
        buffer.set_text(nextContent, -1);
        scroller.set_min_content_height(Math.min(
            220,
            Math.max(72, Math.max(1, nextContent.split('\n').length) * 22),
        ));

        if (languageChanged) {
            buffer.set_highlight_syntax(false);
            scheduleSyntaxHighlight(buffer, outer, nextLanguage);
        }
    };

    return outer;
}

function artifactKey(artifact) {
    return artifact?.artifactId
        ? `${artifact.artifactId}/${artifact.revisionId}`
        : artifact?.id ?? artifact?.path ?? artifact;
}

function messageBlockSignature(block) {
    switch (block?.type) {
    case 'code':
        return `code\u0000${block.language ?? ''}\u0000${block.content ?? ''}`;
    case 'divider':
        return 'divider';
    case 'table':
        return `table\u0000${JSON.stringify([
            block.headers ?? [],
            block.alignments ?? [],
            block.rows ?? [],
        ])}`;
    default:
        return `markdown\u0000${block?.content ?? ''}`;
    }
}

export function streamingBlockReusePlan(previousBlocks, nextBlocks) {
    const previous = Array.isArray(previousBlocks) ? previousBlocks : [];
    const next = Array.isArray(nextBlocks) ? nextBlocks : [];
    let stablePrefix = 0;

    while (stablePrefix < previous.length
        && stablePrefix < next.length
        && messageBlockSignature(previous[stablePrefix]) === messageBlockSignature(next[stablePrefix])) {
        stablePrefix++;
    }

    const previousTail = previous[stablePrefix];
    const nextTail = next[stablePrefix];
    const canUpdateTail = stablePrefix === previous.length - 1
        && stablePrefix === next.length - 1
        && previousTail?.type === nextTail?.type
        && (nextTail?.type === 'markdown' || nextTail?.type === 'code');

    return { stablePrefix, canUpdateTail };
}

function createMessageBlockDescriptor(block, index, options) {
    if (block.type === 'code') {
        const artifact = artifactForCodeBlock(options.artifacts, index, block);

        return {
            artifactKey: artifact ? artifactKey(artifact) : null,
            block,
            widget: artifact
                ? createArtifactCard(artifact, {
                    ...options,
                    source: block.content,
                    sourceLanguage: block.language,
                })
                : createCodeBlock(block, options),
        };
    }

    return {
        artifactKey: null,
        block,
        widget: block.type === 'divider'
            ? createMarkdownDivider()
            : block.type === 'table'
                ? createMarkdownTable(block, options)
                : createMarkdownLabel(block.content, options),
    };
}

function appendUnreferencedArtifacts(container, options, renderedArtifactKeys) {
    const descriptors = [];

    for (const artifact of Array.isArray(options.artifacts) ? options.artifacts : []) {
        const key = artifactKey(artifact);

        if (renderedArtifactKeys.has(key))
            continue;

        const widget = createArtifactCard(artifact, options);
        container.append(widget);
        descriptors.push({ key, widget });
    }

    return descriptors;
}

function renderMessageBlocks(container, blocks, options) {
    const descriptors = blocks.map((block, index) => {
        const descriptor = createMessageBlockDescriptor(block, index, options);
        container.append(descriptor.widget);
        return descriptor;
    });
    const renderedArtifactKeys = new Set(
        descriptors.map((descriptor) => descriptor.artifactKey).filter(Boolean),
    );

    return {
        blocks: descriptors,
        artifacts: appendUnreferencedArtifacts(container, options, renderedArtifactKeys),
    };
}

function removeDescriptorWidgets(container, descriptors) {
    for (const descriptor of descriptors) {
        if (descriptor.widget?.get_parent?.() === container)
            container.remove(descriptor.widget);
    }
}

function updateStreamingMessageContent(container, renderedBody, options, previousState) {
    const nextBlocks = parseMarkdownBlocks(renderedBody);
    const previousBlocks = previousState.blocks.map((descriptor) => descriptor.block);
    const plan = streamingBlockReusePlan(previousBlocks, nextBlocks);
    const nextDescriptors = previousState.blocks.slice(0, plan.stablePrefix);
    let appendFrom = plan.stablePrefix;

    if (plan.canUpdateTail) {
        const previousTail = previousState.blocks[plan.stablePrefix];
        const nextTail = nextBlocks[plan.stablePrefix];
        const nextArtifact = nextTail.type === 'code'
            ? artifactForCodeBlock(options.artifacts, plan.stablePrefix, nextTail)
            : null;

        if (!previousTail.artifactKey && !nextArtifact) {
            if (nextTail.type === 'markdown')
                previousTail.widget.updateMarkdown?.(nextTail.content, options);
            else
                previousTail.widget.updateCodeBlock?.(nextTail);

            nextDescriptors.push({ ...previousTail, block: nextTail });
            appendFrom++;
        }
    }

    removeDescriptorWidgets(container, previousState.blocks.slice(nextDescriptors.length));
    removeDescriptorWidgets(container, previousState.artifacts);

    for (let index = appendFrom; index < nextBlocks.length; index++) {
        const descriptor = createMessageBlockDescriptor(nextBlocks[index], index, options);
        container.append(descriptor.widget);
        nextDescriptors.push(descriptor);
    }

    const renderedArtifactKeys = new Set(
        nextDescriptors.map((descriptor) => descriptor.artifactKey).filter(Boolean),
    );

    return {
        blocks: nextDescriptors,
        artifacts: appendUnreferencedArtifacts(container, options, renderedArtifactKeys),
    };
}

export function renderMessageContent(container, body, options = {}) {
    clearBox(container);
    const renderedBody = options.streaming
        ? stabilizeStreamingMarkdown(body)
        : body;

    return renderMessageBlocks(container, parseMarkdownBlocks(renderedBody), options);
}

export function createMessageContent(body, options = {}) {
    const container = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        hexpand: Boolean(options.hexpand),
    });
    const renderingOptions = { ...options };
    let currentBody = String(body ?? '');

    if (renderingOptions.streaming && !currentBody.trim())
        currentBody = '';

    let displayBody = currentBody;
    let renderedBody = null;
    let renderedState = null;
    let renderSourceId = 0;
    let smoother = null;
    let finishPromise = null;
    let wasRooted = false;
    let wasMapped = false;
    let streamAnimationPreference = renderingOptions.streamAnimationStyle;
    const motionEnabled = () => {
        try {
            return renderingOptions.motionEnabled?.() !== false;
        } catch (_error) {
            return false;
        }
    };
    const streamAnimationStyle = () => normalizeStreamAnimationStyle(
        typeof streamAnimationPreference === 'function'
            ? streamAnimationPreference()
            : streamAnimationPreference,
    );
    const streamPresentationEnabled = () => renderingOptions.streaming
        && streamAnimationStyle() !== 'none'
        && motionEnabled()
        && (!wasMapped || container.get_mapped());
    const render = (force = false) => {
        if (!force && displayBody === renderedBody)
            return;

        const canUpdateIncrementally = !force
            && renderingOptions.streaming
            && renderedState
            && displayBody.startsWith(renderedBody ?? '');
        const nextRenderedBody = renderingOptions.streaming
            ? stabilizeStreamingMarkdown(displayBody)
            : displayBody;
        renderingOptions.streamAnimationStyle = streamAnimationStyle();

        renderedState = canUpdateIncrementally
            ? updateStreamingMessageContent(
                container,
                nextRenderedBody,
                renderingOptions,
                renderedState,
            )
            : renderMessageContent(container, displayBody, renderingOptions);
        renderedBody = displayBody;
        renderingOptions.streamReplace = false;

        if (renderingOptions.streaming)
            renderingOptions.onStreamFrame?.();
    };
    const cancelQueuedRender = () => {
        if (!renderSourceId)
            return;

        GLib.source_remove(renderSourceId);
        renderSourceId = 0;
    };

    const requestRender = (defer = false, force = false) => {
        if (!defer) {
            cancelQueuedRender();
            render(force);
            return;
        }

        if (renderSourceId)
            return;

        renderSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            contentUpdateInterval(displayBody),
            () => {
                renderSourceId = 0;
                render(force);
                return GLib.SOURCE_REMOVE;
            },
        );
    };

    const ensureSmoother = () => {
        if (smoother || !streamPresentationEnabled())
            return smoother;

        smoother = new StreamingTextSmoother({
            initialText: displayBody,
            onUpdate: (visibleText, state) => {
                displayBody = visibleText;
                renderingOptions.streamReplace = state.replace;
                // The smoother is already the render throttle. Deferring this
                // again can merge multiple reveal units into one visible frame.
                requestRender(false);
            },
        });
        return smoother;
    };

    const disposeSmoother = (flush = false) => {
        smoother?.dispose({ flush });
        smoother = null;
    };

    const revealCanonicalContent = () => {
        disposeSmoother();
        displayBody = currentBody;
        cancelQueuedRender();
        render(true);
    };

    const activeAnimationPromises = () => (renderedState?.blocks ?? [])
        .map((descriptor) => descriptor.widget?.finishAnimation?.())
        .filter(Boolean);

    render();
    container.updateContent = (nextBody, updateOptions = {}) => {
        const normalizedBody = String(nextBody ?? '');

        if (normalizedBody === currentBody && !updateOptions.force)
            return;

        currentBody = normalizedBody;

        if (streamPresentationEnabled() && !updateOptions.force) {
            ensureSmoother()?.push(currentBody);
            return;
        }

        disposeSmoother();
        displayBody = currentBody;
        renderingOptions.streamReplace = updateOptions.replace === true;
        requestRender(Boolean(updateOptions.defer), Boolean(updateOptions.force));
    };
    container.updateReferenceStyles = (referenceStyles) => {
        renderingOptions.referenceStyles = referenceStyles;
        cancelQueuedRender();
        render(true);
    };
    container.setSelectable = (selectable) => {
        const normalizedSelectable = Boolean(selectable);

        if (renderingOptions.selectable === normalizedSelectable)
            return;

        renderingOptions.selectable = normalizedSelectable;
        cancelQueuedRender();
        render(true);
    };
    container.finishStreaming = (finishOptions = {}) => {
        if (finishPromise) {
            if (finishOptions.flush)
                smoother?.flush();

            return finishPromise;
        }

        const selectable = finishOptions.selectable === undefined
            ? renderingOptions.selectable
            : Boolean(finishOptions.selectable);

        if (!renderingOptions.streaming && renderingOptions.selectable === selectable)
            return Promise.resolve();

        finishPromise = (async () => {
            if (finishOptions.flush) {
                smoother?.flush();
            } else {
                await smoother?.finish();
            }

            displayBody = currentBody;
            cancelQueuedRender();
            render();
            await Promise.all(activeAnimationPromises());
            disposeSmoother();
            renderingOptions.streaming = false;
            renderingOptions.selectable = selectable;
            render(true);
        })();

        return finishPromise;
    };
    container.setStreamPreferences = (streamOptions = {}) => {
        if (Object.hasOwn(streamOptions, 'streamAnimationStyle'))
            streamAnimationPreference = streamOptions.streamAnimationStyle;

        if (Object.hasOwn(streamOptions, 'motionEnabled'))
            renderingOptions.motionEnabled = streamOptions.motionEnabled;

        if (!streamPresentationEnabled()) {
            revealCanonicalContent();
        } else {
            cancelQueuedRender();
            render(true);
        }
    };
    container.connect('notify::root', () => {
        if (container.get_root()) {
            wasRooted = true;
        } else if (wasRooted) {
            cancelQueuedRender();
            disposeSmoother();
        }
    });
    container.connect('notify::mapped', () => {
        if (container.get_mapped()) {
            wasMapped = true;
        } else if (wasMapped && renderingOptions.streaming) {
            // Cached Gtk.Stack children stay rooted while hidden, but they do
            // not receive frame-clock ticks. Never leave pacing or animations
            // waiting on an unmapped conversation view.
            revealCanonicalContent();
        }
    });
    return container;
}
