import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Graphene from 'gi://Graphene?version=1.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import {
    normalizeStreamAnimationStyle,
    streamRevealUnits,
} from './streamingText.js';

const UTF8_ENCODER = new TextEncoder();
export const DEFAULT_STREAM_ANIMATION_DURATION_MS = 200;
export const DEFAULT_STREAM_ANIMATION_STAGGER_MS = 28;
const MAX_ANIMATION_STAGGER_MS = 168;
const MAX_ACTIVE_ANIMATION_RANGES = 32;
const BLUR_RADIUS_PX = 4;
const SLIDE_OFFSET_PX = 4;

function utf8Length(value) {
    return UTF8_ENCODER.encode(String(value ?? '')).length;
}

function rangesOverlap(first, second) {
    return first.start < second.end && second.start < first.end;
}

function isExcluded(range, excludedRanges) {
    return excludedRanges.some((excluded) => rangesOverlap(range, excluded));
}

function easeOutCubic(value) {
    const progress = Math.max(0, Math.min(1, value));
    return 1 - Math.pow(1 - progress, 3);
}

function mergeByteRanges(ranges, textLength) {
    const normalized = ranges
        .map((range) => ({
            start: Math.max(0, Math.min(textLength, range.start)),
            end: Math.max(0, Math.min(textLength, range.end)),
        }))
        .filter((range) => range.start < range.end)
        .sort((first, second) => first.start - second.start);
    const merged = [];

    for (const range of normalized) {
        const previous = merged.at(-1);

        if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }

    return merged;
}

export function animationVisibleByteRanges(hiddenRanges, textLength) {
    const visible = [];
    let start = 0;

    for (const hidden of mergeByteRanges(hiddenRanges, textLength)) {
        if (start < hidden.start)
            visible.push({ start, end: hidden.start });

        start = hidden.end;
    }

    if (start < textLength)
        visible.push({ start, end: textLength });

    return visible;
}

function layoutLineMetrics(layout) {
    const lines = [];
    const iterator = layout.get_iter();

    do {
        const line = iterator.get_line_readonly();
        const lineStart = line.get_start_index();
        const [, lineLogical] = iterator.get_line_extents();
        const [lineY, lineBottom] = iterator.get_line_yrange();

        lines.push({
            line,
            start: lineStart,
            end: lineStart + line.get_length(),
            x: lineLogical.x,
            y: lineY,
            bottom: lineBottom,
        });
    } while (iterator.next_line());

    return lines;
}

function layoutRangeClips(lines, ranges) {
    const clips = [];

    for (const lineMetrics of lines) {
        const { line } = lineMetrics;

        for (const range of ranges) {
            const start = Math.max(lineMetrics.start, range.start);
            const end = Math.min(lineMetrics.end, range.end);

            if (start >= end)
                continue;

            // Pango's GJS binding truncates get_x_ranges() to one integer, so
            // use caret positions. Streaming ranges are small logical runs;
            // taking the min/max also handles right-to-left runs.
            const startX = line.index_to_x(start, false);
            const endX = line.index_to_x(end, false);

            if (startX === endX)
                continue;

            const clip = new Graphene.Rect();
            clip.init(
                (lineMetrics.x + Math.min(startX, endX)) / Pango.SCALE,
                lineMetrics.y / Pango.SCALE,
                Math.abs(endX - startX) / Pango.SCALE,
                Math.max(1, (lineMetrics.bottom - lineMetrics.y) / Pango.SCALE),
            );
            clips.push(clip);
        }
    }

    return clips;
}

function appendClippedLayout(snapshot, layout, color, ranges, lines) {
    for (const clip of layoutRangeClips(lines, ranges)) {
        snapshot.push_clip(clip);
        snapshot.append_layout(layout, color);
        snapshot.pop();
    }
}

function compactAnimationRanges(ranges, maximumRanges) {
    if (ranges.length <= maximumRanges)
        return ranges;

    const leadingCount = Math.max(0, maximumRanges - 1);
    const compacted = ranges.slice(0, leadingCount);
    const firstTail = ranges[leadingCount];

    if (!firstTail)
        return compacted;

    const tail = { ...firstTail };

    for (let index = leadingCount + 1; index < ranges.length; index++) {
        if (ranges[index].start !== tail.end)
            break;

        tail.end = ranges[index].end;
    }

    compacted.push(tail);
    return compacted;
}

export function animationByteRanges(previousText, nextText, excludedRanges = []) {
    const previous = String(previousText ?? '');
    const next = String(nextText ?? '');

    if (!next.startsWith(previous))
        return [];

    const suffix = next.slice(previous.length);
    const ranges = [];
    let byteOffset = utf8Length(previous);

    for (const unit of streamRevealUnits(suffix)) {
        const start = byteOffset;
        const end = start + utf8Length(unit);
        const range = { start, end };
        byteOffset = end;

        if (unit.trim() && !isExcluded(range, excludedRanges))
            ranges.push(range);
    }

    return ranges;
}

export const AnimatedMarkdownLabel = GObject.registerClass(
class AnimatedMarkdownLabel extends Gtk.Label {
    _init(properties = {}) {
        super._init(properties);
        this._animationStyle = 'none';
        this._animationDurationMs = DEFAULT_STREAM_ANIMATION_DURATION_MS;
        this._animationStaggerMs = DEFAULT_STREAM_ANIMATION_STAGGER_MS;
        this._motionEnabled = () => true;
        this._plainText = '';
        this._activeRanges = [];
        this._tickCallbackId = 0;
        this._animationResolvers = [];
    }

    vfunc_unmap() {
        this.clearAnimations();
        super.vfunc_unmap();
    }

    configureStreamAnimation(options = {}) {
        this._animationStyle = normalizeStreamAnimationStyle(options.style ?? 'none');
        const durationMs = Number(options.durationMs);
        const staggerMs = Number(options.staggerMs);
        this._animationDurationMs = Math.max(
            1,
            Number.isFinite(durationMs) ? durationMs : DEFAULT_STREAM_ANIMATION_DURATION_MS,
        );
        this._animationStaggerMs = Math.max(
            0,
            Number.isFinite(staggerMs) ? staggerMs : DEFAULT_STREAM_ANIMATION_STAGGER_MS,
        );
        this._motionEnabled = options.motionEnabled ?? (() => true);

        if (!this._animationsEnabled())
            this.clearAnimations();
    }

    setRenderModel(model, options = {}) {
        const previousPlainText = this._plainText;
        const nextPlainText = String(model?.plainText ?? '');
        const canExtend = nextPlainText.startsWith(previousPlainText)
            || previousPlainText.trim() === '';
        const animationStartText = previousPlainText.trim() === '' ? '' : previousPlainText;

        this.set_markup(model?.markup || ' ');
        this._plainText = nextPlainText;

        if (!options.animate
            || options.replace
            || !canExtend
            || !this._animationsEnabled()) {
            this.clearAnimations();
            return;
        }

        let ranges = animationByteRanges(
            animationStartText,
            nextPlainText,
            model?.excludedAnimationRanges ?? [],
        );

        if (ranges.length === 0)
            return;

        const now = GLib.get_monotonic_time();
        const nextTextBytes = utf8Length(nextPlainText);
        this._activeRanges = this._activeRanges.filter((range) => range.end <= nextTextBytes);
        const availableSlots = Math.max(
            1,
            MAX_ACTIVE_ANIMATION_RANGES - this._activeRanges.length,
        );
        ranges = compactAnimationRanges(ranges, availableSlots);

        if (this._activeRanges.length + ranges.length > MAX_ACTIVE_ANIMATION_RANGES) {
            this._activeRanges.splice(
                0,
                this._activeRanges.length + ranges.length - MAX_ACTIVE_ANIMATION_RANGES,
            );
        }

        ranges.forEach((range, index) => {
            this._activeRanges.push({
                ...range,
                startTime: now + Math.min(
                    index * this._animationStaggerMs,
                    MAX_ANIMATION_STAGGER_MS,
                ) * 1000,
            });
        });
        this._ensureAnimationTick();
        this.queue_draw();
    }

    clearAnimations() {
        this._activeRanges = [];

        if (this._tickCallbackId) {
            this.remove_tick_callback(this._tickCallbackId);
            this._tickCallbackId = 0;
        }

        this.queue_draw();
        this._resolveAnimations();
    }

    waitForAnimations() {
        if (!this.get_mapped()) {
            this.clearAnimations();
            return Promise.resolve();
        }

        if (this._activeRanges.length === 0)
            return Promise.resolve();

        return new Promise((resolve) => {
            this._animationResolvers.push(resolve);
        });
    }

    _animationsEnabled() {
        if (!this.get_mapped()
            || this._animationStyle === 'none'
            || !this._motionEnabled()) {
            return false;
        }

        try {
            return Adw.get_enable_animations(this);
        } catch (_error) {
            return true;
        }
    }

    _ensureAnimationTick() {
        if (this._tickCallbackId || this._activeRanges.length === 0)
            return;

        this._tickCallbackId = this.add_tick_callback((_widget, frameClock) => {
            const now = frameClock.get_frame_time();
            const durationUs = this._animationDurationMs * 1000;
            this._activeRanges = this._activeRanges.filter((range) => (
                now < range.startTime + durationUs
            ));
            this.queue_draw();

            if (this._activeRanges.length > 0)
                return GLib.SOURCE_CONTINUE;

            this._tickCallbackId = 0;
            this._resolveAnimations();
            return GLib.SOURCE_REMOVE;
        });
    }

    _resolveAnimations() {
        const resolvers = this._animationResolvers.splice(0);

        for (const resolve of resolvers)
            resolve();
    }

    vfunc_snapshot(snapshot) {
        if (this._activeRanges.length === 0 || !this._animationsEnabled()) {
            if (this._activeRanges.length > 0)
                this.clearAnimations();

            super.vfunc_snapshot(snapshot);
            return;
        }

        const layout = this.get_layout();
        const [layoutX, layoutY] = this.get_layout_offsets();
        const color = this.get_color();
        const now = GLib.get_monotonic_time();
        const durationUs = this._animationDurationMs * 1000;
        const textLength = utf8Length(layout.get_text());
        const lines = layoutLineMetrics(layout);
        const layoutPoint = new Graphene.Point();
        layoutPoint.init(layoutX, layoutY);

        snapshot.save();
        snapshot.translate(layoutPoint);
        appendClippedLayout(
            snapshot,
            layout,
            color,
            animationVisibleByteRanges(this._activeRanges, textLength),
            lines,
        );
        snapshot.restore();

        for (const range of this._activeRanges) {
            const progress = easeOutCubic((now - range.startTime) / durationUs);
            const translation = new Graphene.Point();
            translation.init(
                layoutX,
                layoutY + (this._animationStyle === 'slideUp'
                    ? SLIDE_OFFSET_PX * (1 - progress)
                    : 0),
            );
            snapshot.save();
            snapshot.translate(translation);
            snapshot.push_opacity(progress);

            const blurRadius = this._animationStyle === 'blurIn'
                ? BLUR_RADIUS_PX * (1 - progress)
                : 0;

            if (blurRadius > 0.01)
                snapshot.push_blur(blurRadius);

            appendClippedLayout(snapshot, layout, color, [range], lines);

            if (blurRadius > 0.01)
                snapshot.pop();

            snapshot.pop();
            snapshot.restore();
        }
    }
});
