import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import {
    markdownToPangoRenderModel,
    stabilizeStreamingMarkdown,
} from './markdown.js';
import { StreamingTextSmoother } from './streamingText.js';

const REASONING_PREVIEW_LINES = 3;
const REASONING_PREVIEW_MAX_WIDTH_CHARS = 72;
const REASONING_LINE_TRANSITION_MS = 180;
const REASONING_PRESSURED_LINE_TRANSITION_MS = 100;
const MAX_QUEUED_REASONING_LINE_TRANSITIONS = 2;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function interpolate(first, second, progress) {
    return first + (second - first) * progress;
}

export function reasoningTransitionPlan(pendingLineCount, options = {}) {
    const pendingLines = Math.max(0, Math.floor(Number(pendingLineCount) || 0));
    const pressureValue = Number(options.pressure);
    const streamPressure = Number.isFinite(pressureValue)
        ? clamp(pressureValue, 0, 1)
        : 0;
    const finishing = options.finishing === true;
    const shouldCompact = pendingLines > MAX_QUEUED_REASONING_LINE_TRANSITIONS
        || (finishing && pendingLines > 1);
    const skippedLineCount = shouldCompact ? pendingLines - 1 : 0;
    const queuePressure = pendingLines <= 1
        ? 0
        : clamp(
            (pendingLines - 1) / (MAX_QUEUED_REASONING_LINE_TRANSITIONS - 1),
            0,
            1,
        );
    const pressure = finishing || shouldCompact
        ? 1
        : Math.max(streamPressure, queuePressure);

    return {
        pressure,
        skippedLineCount,
        transitionDurationMs: Math.round(interpolate(
            REASONING_LINE_TRANSITION_MS,
            REASONING_PRESSURED_LINE_TRANSITION_MS,
            pressure,
        )),
    };
}

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
    let targetPreview = '';
    let currentPreview = '';
    let latestLines = [];
    let displayedLineCount = 0;
    let initialized = false;
    let smoother = null;
    let latestStreamPressure = 0;
    let finishRequested = false;
    let wasMapped = false;
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
    const streamPresentationAllowed = () => {
        const animationStyle = resolvedAnimationStyle();

        return Boolean(animationStyle)
            && animationStyle !== 'none'
            && motionAllowed()
            && (!wasMapped || container.get_mapped());
    };
    const animationsEnabled = () => {
        if (!container.get_mapped() || !streamPresentationAllowed()) {
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

        finishRequested = false;
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
    const createRow = (
        lineIndex,
        revealed = true,
        transitionDurationMs = REASONING_LINE_TRANSITION_MS,
    ) => {
        const label = createReasoningLine(latestLines[lineIndex]);
        const revealer = new Gtk.Revealer({
            child: label,
            reveal_child: revealed,
            transition_duration: transitionDurationMs,
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
        if (finishRequested && displayedLineCount < latestLines.length)
            rebuildRows();
        else if (displayedLineCount < latestLines.length)
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

        const pendingLineCount = latestLines.length - displayedLineCount;
        const transitionPlan = reasoningTransitionPlan(pendingLineCount, {
            finishing: finishRequested,
            pressure: latestStreamPressure,
        });

        if (transitionPlan.skippedLineCount > 0) {
            rebuildRows(displayedLineCount + transitionPlan.skippedLineCount);

            if (displayedLineCount >= latestLines.length)
                return;
        }

        syncRows();
        const outgoingRow = rows.length >= REASONING_PREVIEW_LINES ? rows[0] : null;
        const incomingRow = createRow(
            displayedLineCount,
            false,
            transitionPlan.transitionDurationMs,
        );

        transitionRunning = true;
        transitionCount++;
        displayedLineCount++;
        if (outgoingRow) {
            outgoingRow.revealer.set_transition_duration(transitionPlan.transitionDurationMs);
            outgoingRow.revealer.set_reveal_child(false);
        }
        incomingRow.revealer.set_reveal_child(true);
        transitionSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            transitionPlan.transitionDurationMs + 20,
            () => {
                transitionSourceId = 0;
                finishLineAdvance(outgoingRow);
                return GLib.SOURCE_REMOVE;
            },
        );
    };

    const applyPreview = (preview, state = {}) => {
        const model = markdownToPangoRenderModel(stabilizeStreamingMarkdown(preview));
        const nextLines = preview ? measuredReasoningLines(container, model.plainText) : [];
        const extendsCurrentPreview = preview.startsWith(currentPreview);

        currentPreview = preview;
        latestStreamPressure = state.animationPressure ?? 0;
        latestLines = nextLines;
        container.set_visible(Boolean(preview));

        if (state.animate === false
            || !initialized
            || !extendsCurrentPreview
            || nextLines.length < displayedLineCount) {
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
    const ensureSmoother = () => {
        if (smoother || !streamPresentationAllowed())
            return smoother;

        smoother = new StreamingTextSmoother({
            initialText: currentPreview,
            intervalMs: options.streamRevealIntervalMs,
            idleFlushMs: options.streamIdleFlushMs,
            onUpdate: (visibleText, state) => applyPreview(visibleText, state),
        });
        return smoother;
    };
    const disposeSmoother = () => {
        smoother?.dispose();
        smoother = null;
    };
    const revealCanonicalPreview = () => {
        disposeSmoother();
        applyPreview(targetPreview, {
            animate: false,
            animationPressure: 1,
        });
    };
    const finishLineTransitions = (finishOptions = {}) => {
        if (finishOptions.flush) {
            finishRequested = true;
            rebuildRows();
            return Promise.resolve();
        }

        if (!transitionRunning && displayedLineCount >= latestLines.length)
            return Promise.resolve();

        finishRequested = true;
        const promise = new Promise((resolve) => {
            finishResolvers.push(resolve);
        });

        if (!transitionRunning)
            advanceOneLine();

        return promise;
    };

    container.add_css_class('cusco-reasoning-preview');
    container.set_overflow(Gtk.Overflow.HIDDEN);
    container.set_visible(false);
    container.connect('notify::mapped', () => {
        if (container.get_mapped()) {
            wasMapped = true;
            return;
        }

        if (wasMapped)
            revealCanonicalPreview();
        resolveFinished();
    });
    container.updateReasoningPreview = (text) => {
        targetPreview = reasoningPreviewText(text);
        finishRequested = false;
        container.set_visible(Boolean(targetPreview));

        if (!targetPreview || !streamPresentationAllowed()) {
            revealCanonicalPreview();
            return targetPreview;
        }

        ensureSmoother()?.push(targetPreview);
        return targetPreview;
    };
    container.setStreamPreferences = (streamOptions = {}) => {
        if (Object.hasOwn(streamOptions, 'streamAnimationStyle'))
            streamAnimationPreference = streamOptions.streamAnimationStyle;

        if (Object.hasOwn(streamOptions, 'motionEnabled'))
            motionEnabled = streamOptions.motionEnabled;

        if (!streamPresentationAllowed()) {
            revealCanonicalPreview();
        } else if (targetPreview !== currentPreview) {
            ensureSmoother()?.push(targetPreview);
        }
    };
    container.finishReasoningPreview = async (finishOptions = {}) => {
        if (finishOptions.flush) {
            smoother?.flush();
            disposeSmoother();

            if (currentPreview !== targetPreview)
                applyPreview(targetPreview, { animate: false, animationPressure: 1 });

            await finishLineTransitions({ flush: true });
            return;
        }

        await smoother?.finish();
        disposeSmoother();
        await finishLineTransitions();
    };
    container.getReasoningPreviewLines = () => rows.map((row) => (
        latestLines[row.lineIndex] ?? ''
    ));
    container.getReasoningLineTransitionCount = () => transitionCount;
    container.getReasoningPreviewText = () => currentPreview;
    container.getReasoningLineTransitionType = () => (
        animationsEnabled()
            ? Gtk.RevealerTransitionType.SLIDE_UP
            : Gtk.RevealerTransitionType.NONE
    );
    return container;
}
