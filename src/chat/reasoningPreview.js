import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import {
    markdownToPangoRenderModel,
    stabilizeStreamingMarkdown,
} from './markdown.js';

const REASONING_PREVIEW_LINES = 3;
const REASONING_PREVIEW_MAX_WIDTH_CHARS = 72;
const REASONING_LINE_TRANSITION_MS = 180;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export function reasoningPreviewText(value) {
    return String(value ?? '')
        .replace(/[^\S\n]+/gu, ' ')
        .replace(/ *\n */gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

function estimatedReasoningLines(value, maxWidthChars = REASONING_PREVIEW_MAX_WIDTH_CHARS) {
    const text = reasoningPreviewText(value);
    const width = Math.max(1, Math.floor(Number(maxWidthChars) || REASONING_PREVIEW_MAX_WIDTH_CHARS));

    if (!text)
        return [];

    return text.split('\n').flatMap((line) => {
        const characters = Array.from(line);

        if (characters.length === 0)
            return [''];

        const lines = [];

        for (let offset = 0; offset < characters.length; offset += width)
            lines.push(characters.slice(offset, offset + width).join(''));

        return lines;
    });
}

export function estimatedReasoningLineCount(value, maxWidthChars = REASONING_PREVIEW_MAX_WIDTH_CHARS) {
    return estimatedReasoningLines(value, maxWidthChars).length;
}

function measuredReasoningLines(widget, plainText) {
    const width = widget.get_width();

    if (width <= 1)
        return estimatedReasoningLines(plainText);

    const layout = widget.create_pango_layout(plainText || ' ');

    layout.set_width(width * Pango.SCALE);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    const bytes = UTF8_ENCODER.encode(plainText);
    const lines = [];
    const iterator = layout.get_iter();

    do {
        const line = iterator.get_line_readonly();
        const start = line.get_start_index();
        const end = start + line.get_length();
        const text = UTF8_DECODER.decode(bytes.slice(start, end)).replace(/\n$/u, '');

        lines.push(text);
    } while (iterator.next_line());

    return lines.length > 0 ? lines : [''];
}

function createReasoningLine(text = '') {
    const label = new Gtk.Label({
        ellipsize: Pango.EllipsizeMode.END,
        hexpand: true,
        label: text || ' ',
        single_line_mode: true,
        xalign: 0,
    });

    label.add_css_class('caption');
    label.add_css_class('dim-label');
    label.add_css_class('cusco-reasoning-preview-line');
    return label;
}

export function createReasoningPreviewLabel(options = {}) {
    let streamAnimationPreference = options.streamAnimationStyle;
    let motionEnabled = options.motionEnabled;
    const container = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
    });
    const rows = [];
    let currentPreview = '';
    let latestLines = [];
    let displayedLineCount = 0;
    let initialized = false;
    let transitionSourceId = 0;
    let transitionRunning = false;
    let transitionCount = 0;
    const finishResolvers = [];

    const resolvedAnimationStyle = () => {
        try {
            return typeof streamAnimationPreference === 'function'
                ? streamAnimationPreference()
                : streamAnimationPreference;
        } catch (_error) {
            return 'none';
        }
    };
    const motionAllowed = () => {
        try {
            return typeof motionEnabled === 'function'
                ? motionEnabled() !== false
                : motionEnabled !== false;
        } catch (_error) {
            return false;
        }
    };
    const animationsEnabled = () => {
        const animationStyle = resolvedAnimationStyle();

        if (!container.get_mapped()
            || !animationStyle
            || animationStyle === 'none'
            || !motionAllowed()) {
            return false;
        }

        try {
            return Adw.get_enable_animations(container);
        } catch (_error) {
            return true;
        }
    };
    const resolveFinished = () => {
        if (transitionRunning || displayedLineCount < latestLines.length)
            return;

        for (const resolve of finishResolvers.splice(0))
            resolve();
    };
    const cancelTransitionSource = () => {
        if (!transitionSourceId)
            return;

        GLib.Source.remove(transitionSourceId);
        transitionSourceId = 0;
    };
    const removeRows = () => {
        cancelTransitionSource();
        transitionRunning = false;

        for (const row of rows.splice(0)) {
            if (row.revealer.get_parent() === container)
                container.remove(row.revealer);
        }
    };
    const createRow = (lineIndex, revealed = true) => {
        const label = createReasoningLine(latestLines[lineIndex]);
        const revealer = new Gtk.Revealer({
            child: label,
            reveal_child: revealed,
            transition_duration: REASONING_LINE_TRANSITION_MS,
            transition_type: animationsEnabled()
                ? Gtk.RevealerTransitionType.SLIDE_UP
                : Gtk.RevealerTransitionType.NONE,
        });
        const row = { label, lineIndex, revealer };

        container.append(revealer);
        rows.push(row);
        return row;
    };
    const syncRows = () => {
        for (const row of rows)
            row.label.set_label(latestLines[row.lineIndex] || ' ');
    };
    const rebuildRows = (lineCount = latestLines.length) => {
        removeRows();
        displayedLineCount = lineCount;
        const firstLineIndex = Math.max(0, lineCount - REASONING_PREVIEW_LINES);

        for (let lineIndex = firstLineIndex; lineIndex < lineCount; lineIndex++)
            createRow(lineIndex);

        resolveFinished();
    };
    let advanceOneLine = null;
    const finishLineAdvance = (outgoingRow) => {
        cancelTransitionSource();

        if (outgoingRow?.revealer.get_parent() === container) {
            container.remove(outgoingRow.revealer);
            const outgoingIndex = rows.indexOf(outgoingRow);

            if (outgoingIndex >= 0)
                rows.splice(outgoingIndex, 1);
        }

        transitionRunning = false;
        syncRows();
        if (displayedLineCount < latestLines.length)
            advanceOneLine();
        else
            resolveFinished();
    };

    advanceOneLine = () => {
        if (transitionRunning || displayedLineCount >= latestLines.length)
            return;

        const enabled = animationsEnabled();

        if (!enabled) {
            rebuildRows();
            return;
        }

        syncRows();
        const outgoingRow = rows.length >= REASONING_PREVIEW_LINES ? rows[0] : null;
        const incomingRow = createRow(displayedLineCount, false);

        transitionRunning = true;
        transitionCount++;
        displayedLineCount++;
        if (outgoingRow)
            outgoingRow.revealer.set_reveal_child(false);
        incomingRow.revealer.set_reveal_child(true);
        transitionSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            REASONING_LINE_TRANSITION_MS + 20,
            () => {
                transitionSourceId = 0;
                finishLineAdvance(outgoingRow);
                return GLib.SOURCE_REMOVE;
            },
        );
    };

    container.add_css_class('cusco-reasoning-preview');
    container.set_overflow(Gtk.Overflow.HIDDEN);
    container.set_visible(false);
    container.connect('notify::mapped', () => {
        if (container.get_mapped())
            return;

        if (transitionRunning)
            rebuildRows();
        resolveFinished();
    });
    container.updateReasoningPreview = (text) => {
        const preview = reasoningPreviewText(text);
        const model = markdownToPangoRenderModel(stabilizeStreamingMarkdown(preview));
        const nextLines = preview ? measuredReasoningLines(container, model.plainText) : [];
        const extendsCurrentPreview = preview.startsWith(currentPreview);

        currentPreview = preview;
        latestLines = nextLines;
        container.set_visible(Boolean(preview));

        if (!initialized || !extendsCurrentPreview || nextLines.length < displayedLineCount) {
            initialized = true;
            rebuildRows();
            return preview;
        }

        syncRows();
        if (displayedLineCount < latestLines.length)
            advanceOneLine();
        else
            resolveFinished();

        return preview;
    };
    container.setStreamPreferences = (streamOptions = {}) => {
        if (Object.hasOwn(streamOptions, 'streamAnimationStyle'))
            streamAnimationPreference = streamOptions.streamAnimationStyle;

        if (Object.hasOwn(streamOptions, 'motionEnabled'))
            motionEnabled = streamOptions.motionEnabled;

        if (!animationsEnabled() && transitionRunning)
            rebuildRows();
    };
    container.finishReasoningPreview = () => {
        if (!transitionRunning && displayedLineCount >= latestLines.length)
            return Promise.resolve();

        return new Promise((resolve) => {
            finishResolvers.push(resolve);
        });
    };
    container.getReasoningPreviewLines = () => rows.map((row) => (
        latestLines[row.lineIndex] ?? ''
    ));
    container.getReasoningLineTransitionCount = () => transitionCount;
    container.getReasoningLineTransitionType = () => (
        animationsEnabled()
            ? Gtk.RevealerTransitionType.SLIDE_UP
            : Gtk.RevealerTransitionType.NONE
    );
    return container;
}
