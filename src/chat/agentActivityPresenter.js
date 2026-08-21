import Cairo from 'cairo';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import {
    drawKnotIconPath,
    KNOT_ICON_ANIMATION_SECONDS,
    KNOT_ICON_STROKE_WIDTH,
    KNOT_ICON_VIEWBOX_HEIGHT,
    KNOT_ICON_VIEWBOX_WIDTH,
    mirrorProgress,
} from './agentActivity.js';
import { imageArtifactForToolCall } from './artifacts.js';
import {
    buildShimmerMarkup,
    formatRunningTime,
} from './presentation.js';
import {
    copyTextToClipboard,
    createArtifactCard,
    createMessageContent,
} from './messageView.js';
import {
    createReasoningPreviewLabel,
    reasoningPreviewText,
} from './reasoningPreview.js';
import {
    latestOutputLines,
    normalizeToolCallDisplay,
} from '../tools/display.js';

const SHIMMER_INTERVAL_MS = 90;

function getMessageReasoningContent(message) {
    if (typeof message?.reasoning === 'string')
        return message.reasoning.trim();

    return String(message?.reasoning?.content ?? '').trim();
}

export { createReasoningPreviewLabel, reasoningPreviewText };

export function createTextShimmerController(label, options = {}) {
    const reducedMotionEnabled = typeof options.reducedMotionEnabled === 'function'
        ? options.reducedMotionEnabled
        : () => Boolean(options.reducedMotionEnabled);
    let text = '';
    let phase = 0;
    let sourceId = 0;

    const stopSource = () => {
        if (!sourceId)
            return;

        GLib.Source.remove(sourceId);
        sourceId = 0;
    };
    const render = () => {
        label.set_markup(buildShimmerMarkup(text, phase));
        phase += 1;
    };

    return {
        set: (nextText, active = false) => {
            stopSource();
            text = String(nextText ?? '');
            phase = 0;

            if (!active || !text || reducedMotionEnabled()) {
                label.set_label(text);
                return;
            }

            render();
            sourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                SHIMMER_INTERVAL_MS,
                () => {
                    render();
                    return GLib.SOURCE_CONTINUE;
                },
            );
        },
        stop: () => {
            stopSource();
            label.set_label(text);
        },
    };
}

export function createAgentWorkingRow(options = {}) {
    const startedAt = options.startedAt ?? GLib.get_monotonic_time();
    const normalizedStartedAt = Number.isFinite(startedAt)
        ? startedAt
        : GLib.get_monotonic_time();
    const completedLabel = String(options.completedLabel ?? '').trim();
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        halign: Gtk.Align.START,
        valign: Gtk.Align.CENTER,
    });
    const workingLabel = new Gtk.Label({
        label: 'Working…',
        xalign: 0,
        valign: Gtk.Align.CENTER,
    });
    const elapsedLabel = new Gtk.Label({
        xalign: 0,
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Elapsed agent run time',
    });
    const shimmer = createTextShimmerController(workingLabel, {
        reducedMotionEnabled: options.reducedMotionEnabled,
    });
    let elapsedSourceId = 0;
    let completed = false;

    const updateElapsed = () => {
        const elapsedSeconds = (GLib.get_monotonic_time() - normalizedStartedAt) / 1000000;
        elapsedLabel.set_label(formatRunningTime(elapsedSeconds));
    };
    const stopElapsed = () => {
        if (!elapsedSourceId)
            return;

        GLib.Source.remove(elapsedSourceId);
        elapsedSourceId = 0;
    };
    const complete = (nextLabel) => {
        const normalizedLabel = String(nextLabel ?? '').trim();

        if (!normalizedLabel)
            return false;

        stopElapsed();

        if (!completed)
            shimmer.stop();

        completed = true;
        workingLabel.set_label(normalizedLabel);
        workingLabel.remove_css_class('cusco-agent-working-label');
        workingLabel.add_css_class('dim-label');
        workingLabel.set_tooltip_text('Agent run duration');
        elapsedLabel.set_visible(false);
        return true;
    };

    row.add_css_class('cusco-agent-working');
    workingLabel.add_css_class('caption');
    workingLabel.add_css_class('cusco-agent-working-label');
    elapsedLabel.add_css_class('caption');
    elapsedLabel.add_css_class('dim-label');
    row.append(workingLabel);
    row.append(elapsedLabel);

    if (completedLabel) {
        complete(completedLabel);
    } else {
        shimmer.set('Working…', true);
        updateElapsed();
        elapsedSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1000,
            () => {
                updateElapsed();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    row.stop = () => {
        stopElapsed();

        if (!completed)
            shimmer.stop();
    };
    row.complete = complete;

    return row;
}

export class AgentActivityPresenter {
    constructor({
        appSettings,
        getParentWindow,
        clearBox,
        messageContentOptions,
    }) {
        this._appSettings = appSettings;
        this._getParentWindow = getParentWindow;
        this._clearBox = clearBox;
        this._messageContentOptions = messageContentOptions;
    }

    _createKnotIcon(options = {}) {
        const {
            width = 30,
            height = 14,
            animate = true,
        } = options;
        const shouldAnimate = animate && !this._appSettings.reducedMotionEnabled;
        const startTime = GLib.get_monotonic_time();
        const icon = new Gtk.DrawingArea({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });

        icon.set_size_request(width, height);
        icon.add_css_class('cusco-knot-icon');
        icon.set_draw_func((widget, cr, drawWidth, drawHeight) => {
            const color = widget.get_color();
            const padding = 1;
            const scale = Math.min(
                (drawWidth - padding * 2) / KNOT_ICON_VIEWBOX_WIDTH,
                (drawHeight - padding * 2) / KNOT_ICON_VIEWBOX_HEIGHT,
            );

            if (!Number.isFinite(scale) || scale <= 0)
                return;

            const elapsedSeconds = (GLib.get_monotonic_time() - startTime) / 1000000;
            const progress = shouldAnimate
                ? mirrorProgress(elapsedSeconds / KNOT_ICON_ANIMATION_SECONDS)
                : 1;

            cr.save();
            cr.translate(
                (drawWidth - KNOT_ICON_VIEWBOX_WIDTH * scale) / 2,
                (drawHeight - KNOT_ICON_VIEWBOX_HEIGHT * scale) / 2,
            );
            cr.scale(scale, scale);
            cr.setSourceRGBA(color.red, color.green, color.blue, color.alpha);
            cr.setLineWidth(KNOT_ICON_STROKE_WIDTH);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            drawKnotIconPath(cr, progress);
            cr.restore();
        });

        if (shouldAnimate) {
            icon.add_tick_callback((widget) => {
                widget.queue_draw();
                return GLib.SOURCE_CONTINUE;
            });
        }

        return icon;
    }

    _createTextShimmerController(label) {
        return createTextShimmerController(label, {
            reducedMotionEnabled: () => this._appSettings.reducedMotionEnabled,
        });
    }

    _createAgentWorkingRow(startedAt = GLib.get_monotonic_time()) {
        return createAgentWorkingRow({
            startedAt,
            reducedMotionEnabled: () => this._appSettings.reducedMotionEnabled,
        });
    }

    _createAgentCompletedRow(label) {
        return createAgentWorkingRow({
            completedLabel: label,
            reducedMotionEnabled: () => this._appSettings.reducedMotionEnabled,
        });
    }

    _createKnotStatusRow(text = '', options = {}) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: options.compact ? 6 : 8,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER,
        });
        const label = new Gtk.Label({
            label: String(text ?? ''),
            xalign: 0,
            valign: Gtk.Align.CENTER,
            visible: Boolean(text),
        });

        row.add_css_class('cusco-knot-status');
        row.append(this._createKnotIcon({
            width: options.compact ? 22 : 32,
            height: options.compact ? 10 : 15,
            animate: options.animate !== false,
        }));
        row.append(label);
        row.updateStatusText = (nextText) => {
            const normalizedText = String(nextText ?? '');

            label.set_label(normalizedText);
            label.set_visible(Boolean(normalizedText));
        };

        return row;
    }

    _createThinkingLabelWidget(isActive) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        const label = new Gtk.Label({
            label: isActive ? 'Thinking' : 'Reasoning',
            xalign: 0,
            valign: Gtk.Align.CENTER,
        });

        if (isActive)
            row.append(this._createKnotIcon({ width: 22, height: 10 }));

        row.append(label);
        return row;
    }

    _createReasoningExpander(contentOrFactory, options = {}) {
        const contentFactory = typeof contentOrFactory === 'function'
            ? contentOrFactory
            : null;
        let content = contentFactory ? null : contentOrFactory;
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
        });
        const showLoadingPreview = options.showPreview ?? options.isActive;
        const revealer = new Gtk.Revealer({
            reveal_child: false,
            transition_type: showLoadingPreview
                ? Gtk.RevealerTransitionType.NONE
                : Gtk.RevealerTransitionType.SLIDE_DOWN,
        });
        const headerButton = new Gtk.Button({
            halign: Gtk.Align.START,
        });
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
        });
        const previewLabel = showLoadingPreview
            ? createReasoningPreviewLabel(this._messageContentOptions())
            : null;
        const chevron = new Gtk.Image({
            icon_name: 'pan-end-symbolic',
            pixel_size: 14,
            valign: Gtk.Align.CENTER,
        });

        container.add_css_class('cusco-reasoning');
        revealer.add_css_class('cusco-reasoning-body');
        headerButton.add_css_class('flat');
        headerButton.add_css_class('cusco-reasoning-header');
        chevron.add_css_class('cusco-reasoning-toggle-icon');

        header.append(this._createThinkingLabelWidget(options.isActive));
        header.append(chevron);
        headerButton.set_child(header);
        revealer.set_child(body);
        let loadingPreviewActive = Boolean(previewLabel);
        let previewCollapsedByUser = false;

        const ensureContent = () => {
            if (loadingPreviewActive)
                return null;

            if (!content && contentFactory) {
                content = contentFactory();
                body.append(content);
            }

            return content;
        };

        if (content)
            body.append(content);

        if (previewLabel)
            body.append(previewLabel);

        headerButton.set_visible(!loadingPreviewActive);

        const updateExpandedState = (expanded) => {
            headerButton.set_tooltip_text(expanded ? 'Collapse reasoning' : 'Expand reasoning');

            if (expanded)
                chevron.add_css_class('cusco-reasoning-toggle-icon-expanded');
            else
                chevron.remove_css_class('cusco-reasoning-toggle-icon-expanded');
        };

        headerButton.connect('clicked', () => {
            const expanded = !revealer.get_reveal_child();

            if (expanded)
                ensureContent();

            if (loadingPreviewActive)
                previewCollapsedByUser = !expanded;

            revealer.set_reveal_child(expanded);
            updateExpandedState(expanded);
        });
        updateExpandedState(false);

        container.append(headerButton);
        container.append(revealer);
        container.ensureContent = ensureContent;
        container.updatePreview = (text) => {
            if (!previewLabel)
                return;

            const preview = reasoningPreviewText(text);
            const hasPreview = Boolean(preview);

            headerButton.set_visible(!loadingPreviewActive);
            previewLabel.set_visible(hasPreview);
            if (hasPreview && !previewCollapsedByUser) {
                if (loadingPreviewActive) {
                    revealer.set_transition_type(
                        Gtk.RevealerTransitionType.NONE,
                    );
                }
                revealer.set_reveal_child(true);
                updateExpandedState(true);
            }

            previewLabel.updateReasoningPreview(preview);
        };
        container.clearPreview = () => {
            loadingPreviewActive = false;
            previewCollapsedByUser = false;
            headerButton.set_visible(true);
            previewLabel?.finishReasoningPreview({ flush: true })?.catch((error) => {
                logError(error, 'Failed to flush reasoning preview');
            });
            previewLabel?.set_visible(false);
            revealer.set_transition_type(Gtk.RevealerTransitionType.NONE);
            revealer.set_reveal_child(false);
            revealer.set_transition_type(Gtk.RevealerTransitionType.SLIDE_DOWN);
            updateExpandedState(false);
        };
        container.setStreamPreferences = (streamOptions) => {
            previewLabel?.setStreamPreferences(streamOptions);
        };
        container.finishPreviewAnimation = (finishOptions) => (
            previewLabel?.finishReasoningPreview(finishOptions) ?? Promise.resolve()
        );
        return container;
    }

    _createAgentReasoningSegment(message, options = {}) {
        let currentMessage = message;
        let content = null;
        let loading = options.loading === true;
        const createContent = () => {
            content = createMessageContent(
                getMessageReasoningContent(currentMessage) || ' ',
                this._messageContentOptions({
                    role: 'assistant',
                    hexpand: true,
                    codeMinWidth: 380,
                }),
            );
            return content;
        };
        const expander = this._createReasoningExpander(createContent, {
            showPreview: loading,
        });

        expander.updateReasoningMessage = (nextMessage) => {
            currentMessage = nextMessage;
            if (loading)
                expander.updatePreview(getMessageReasoningContent(nextMessage));

            content?.updateContent(getMessageReasoningContent(nextMessage) || ' ', { defer: true });
        };
        expander.startReasoningLoading = () => {
            if (loading)
                expander.updatePreview(getMessageReasoningContent(currentMessage));
        };
        expander.finishReasoningLoading = () => {
            loading = false;
            expander.clearPreview();
        };

        return expander;
    }

    _createBashOutputPreview(initialOutput = '') {
        const buffer = new Gtk.TextBuffer();
        const view = new Gtk.TextView({
            buffer,
            editable: false,
            cursor_visible: false,
            monospace: true,
            hexpand: true,
        });
        view.set_wrap_mode(Gtk.WrapMode.NONE);
        view.add_css_class('cusco-tool-output-preview-text');

        const scroller = new Gtk.ScrolledWindow({
            child: view,
            hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: 58,
            max_content_height: 58,
            propagate_natural_height: false,
        });
        let autoScroll = true;
        let updatingScroll = false;
        let scrollSourceId = 0;

        scroller.add_css_class('cusco-tool-output-preview');
        scroller.get_vadjustment().connect('value-changed', (adjustment) => {
            if (updatingScroll)
                return;

            autoScroll = adjustment.get_value() >= adjustment.get_upper() - adjustment.get_page_size() - 2;
        });

        scroller.updateOutputPreview = (output) => {
            const text = latestOutputLines(output);
            const adjustment = scroller.get_vadjustment();
            const shouldScroll = autoScroll
                || adjustment.get_value() >= adjustment.get_upper() - adjustment.get_page_size() - 2;

            buffer.set_text(text, -1);

            if (!shouldScroll)
                return;

            if (scrollSourceId)
                return;

            scrollSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                scrollSourceId = 0;
                updatingScroll = true;
                adjustment.set_value(Math.max(adjustment.get_lower(), adjustment.get_upper() - adjustment.get_page_size()));
                updatingScroll = false;
                return GLib.SOURCE_REMOVE;
            });
        };
        scroller.updateOutputPreview(initialOutput);
        return scroller;
    }

    _createToolArtifactPreviews() {
        const frame = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            halign: Gtk.Align.START,
        });
        frame.add_css_class('cusco-tool-image-preview');
        frame.set_visible(false);

        frame.updateImage = (toolCall = {}) => {
            this._clearBox(frame);

            const artifacts = Array.isArray(toolCall.artifacts)
                ? [...toolCall.artifacts]
                : [];
            const imageArtifact = imageArtifactForToolCall(toolCall);

            if (imageArtifact && !artifacts.some((artifact) => (
                artifact?.artifactId === imageArtifact.artifactId
                || (artifact?.path && artifact.path === imageArtifact.path)
            ))) {
                artifacts.push(imageArtifact);
            }

            if (artifacts.length === 0) {
                frame.set_visible(false);
                return;
            }

            for (const artifact of artifacts) {
                frame.append(createArtifactCard(artifact, this._messageContentOptions({
                    parentWindow: this._getParentWindow(),
                    codeMinWidth: 360,
                })));
            }
            frame.set_visible(true);
        };

        return frame;
    }

    _createToolResultExpander(message, options = {}) {
        let currentMessage = message;
        let previousStatus = '';
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
        });
        const textBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        const titleRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            hexpand: true,
        });
        const actionLabel = new Gtk.Label({
            xalign: 0,
            valign: Gtk.Align.CENTER,
            ellipsize: Pango.EllipsizeMode.END,
        });
        const statusPill = new Gtk.Label({
            xalign: 0.5,
            valign: Gtk.Align.CENTER,
        });
        const statusShimmer = this._createTextShimmerController(statusPill);
        const targetLabel = new Gtk.Label({
            xalign: 0,
            valign: Gtk.Align.CENTER,
            ellipsize: Pango.EllipsizeMode.END,
            hexpand: true,
            lines: 1,
            max_width_chars: 76,
            single_line_mode: true,
        });
        const detailLabel = new Gtk.Label({
            xalign: 0,
            valign: Gtk.Align.CENTER,
            ellipsize: Pango.EllipsizeMode.END,
        });
        let bodyContent = null;
        const resultCard = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 0,
            hexpand: true,
        });
        const resultHeader = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 8,
            margin_end: 8,
        });
        const resultLabel = new Gtk.Label({
            label: 'Result',
            xalign: 0,
            hexpand: true,
        });
        const copyResultButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy result',
            valign: Gtk.Align.CENTER,
        });
        const revealer = new Gtk.Revealer({
            child: resultCard,
            reveal_child: false,
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
            hexpand: true,
        });
        const headerButton = new Gtk.Button({
            halign: Gtk.Align.START,
        });
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });
        const chevron = new Gtk.Image({
            icon_name: 'pan-end-symbolic',
            pixel_size: 14,
            valign: Gtk.Align.CENTER,
        });
        let outputPreview = null;
        const outputPreviewSlot = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
        });
        const artifactPreview = this._createToolArtifactPreviews();

        container.add_css_class('cusco-tool-result');
        actionLabel.add_css_class('cusco-tool-result-action');
        targetLabel.add_css_class('cusco-tool-result-target');
        detailLabel.add_css_class('caption');
        detailLabel.add_css_class('dim-label');
        statusPill.add_css_class('cusco-tool-result-status');
        chevron.add_css_class('cusco-tool-result-toggle-icon');
        resultCard.add_css_class('cusco-tool-result-card');
        resultHeader.add_css_class('cusco-tool-result-card-header');
        resultLabel.add_css_class('caption');
        resultLabel.add_css_class('dim-label');
        copyResultButton.add_css_class('flat');

        if (!options.embedded)
            container.set_size_request(460, -1);

        headerButton.add_css_class('flat');
        headerButton.add_css_class('cusco-tool-result-header');

        copyResultButton.connect('clicked', () => {
            copyTextToClipboard(currentMessage.content);
        });
        resultHeader.append(resultLabel);
        resultHeader.append(copyResultButton);
        resultCard.append(resultHeader);

        const ensureBodyContent = () => {
            if (bodyContent)
                return bodyContent;

            bodyContent = createMessageContent(currentMessage.content || ' ', this._messageContentOptions({
                role: 'system',
                hexpand: true,
                codeMinWidth: 380,
            }));
            bodyContent.add_css_class('cusco-tool-result-card-content');
            resultCard.append(bodyContent);
            return bodyContent;
        };
        const ensureOutputPreview = () => {
            if (outputPreview)
                return outputPreview;

            outputPreview = this._createBashOutputPreview('');
            outputPreview.set_visible(false);
            outputPreviewSlot.append(outputPreview);
            return outputPreview;
        };

        titleRow.append(actionLabel);
        titleRow.append(statusPill);
        textBox.append(titleRow);
        textBox.append(targetLabel);
        textBox.append(detailLabel);
        header.append(textBox);
        header.append(chevron);
        headerButton.set_child(header);
        headerButton.connect('clicked', () => {
            const expanded = !revealer.get_reveal_child();

            if (expanded)
                ensureBodyContent();

            revealer.set_reveal_child(expanded);
            headerButton.set_tooltip_text(
                `${expanded ? 'Collapse' : 'Expand'} ${currentMessage.toolCall?.label ?? 'tool'} result`,
            );

            if (expanded)
                chevron.add_css_class('cusco-tool-result-toggle-icon-expanded');
            else
                chevron.remove_css_class('cusco-tool-result-toggle-icon-expanded');
        });

        const setStatusClass = (status) => {
            if (previousStatus)
                statusPill.remove_css_class(`cusco-tool-result-status-${previousStatus}`);

            previousStatus = status;
            statusPill.add_css_class(`cusco-tool-result-status-${status}`);
        };
        const updateFromMessage = () => {
            const display = normalizeToolCallDisplay(currentMessage.toolCall);
            const target = display.target || display.label;
            const detail = display.detail;

            setStatusClass(display.status);
            actionLabel.set_label(display.action);
            statusShimmer.set(display.statusLabel, display.status === 'running');
            targetLabel.set_label(target);
            targetLabel.set_visible(Boolean(target));
            detailLabel.set_label(detail);
            detailLabel.set_visible(Boolean(detail));
            bodyContent?.updateContent(currentMessage.content || ' ');
            copyResultButton.set_sensitive(Boolean(String(currentMessage.content ?? '').trim()));
            const showOutputPreview = display.isBash
                && display.status === 'running'
                && Boolean(display.outputPreview);

            if (showOutputPreview) {
                const preview = ensureOutputPreview();
                preview.updateOutputPreview(display.outputPreview);
                preview.set_visible(true);
            } else {
                outputPreview?.set_visible(false);
            }

            const toolCall = currentMessage.toolCall;
            const hasArtifactPreview = Boolean(String(toolCall?.imagePath ?? '').trim())
                || (toolCall?.artifacts ?? []).length > 0;

            if (hasArtifactPreview)
                artifactPreview.updateImage(toolCall);
            else
                artifactPreview.set_visible(false);

            headerButton.set_tooltip_text(
                `${revealer.get_reveal_child() ? 'Collapse' : 'Expand'} ${display.label} result`,
            );
        };

        container.append(headerButton);
        container.append(outputPreviewSlot);
        container.append(revealer);
        container.append(artifactPreview);
        container.updateToolMessage = (nextMessage) => {
            currentMessage = nextMessage;
            updateFromMessage();
        };
        container.appendToolOutput = (output) => {
            if (currentMessage.toolCall)
                currentMessage.toolCall.outputPreview = output;

            if (!output) {
                outputPreview?.set_visible(false);
                return;
            }

            const preview = ensureOutputPreview();
            preview.updateOutputPreview(output);
            preview.set_visible(true);
        };

        updateFromMessage();
        return container;
    }

}
