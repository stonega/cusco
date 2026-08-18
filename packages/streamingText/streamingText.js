import GLib from 'gi://GLib?version=2.0';

export const STREAM_ANIMATION_STYLES = Object.freeze([
    'blurIn',
    'fadeIn',
    'slideUp',
    'none',
]);
export const DEFAULT_STREAM_ANIMATION_STYLE = 'blurIn';

export const DEFAULT_STREAM_INTERVAL_MS = 24;
export const DEFAULT_STREAM_IDLE_FLUSH_MS = 72;
const CJK_OR_THAI_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const WHITESPACE_RE = /^\s+$/u;
const HAS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
const WORD_SEGMENTER = HAS_SEGMENTER
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;
const GRAPHEME_SEGMENTER = HAS_SEGMENTER
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function defaultSchedule(milliseconds, callback) {
    return GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        Math.max(1, Math.ceil(milliseconds)),
        () => {
            callback();
            return GLib.SOURCE_REMOVE;
        },
    );
}

function defaultCancel(sourceId) {
    if (sourceId)
        GLib.source_remove(sourceId);
}

export function normalizeStreamAnimationStyle(value) {
    return STREAM_ANIMATION_STYLES.includes(value)
        ? value
        : DEFAULT_STREAM_ANIMATION_STYLE;
}

function splitScriptSensitiveSegment(segment, graphemeSegmenter) {
    if (!CJK_OR_THAI_RE.test(segment))
        return [segment];

    if (!graphemeSegmenter)
        return Array.from(segment);

    return Array.from(graphemeSegmenter.segment(segment), (entry) => entry.segment);
}

function fallbackWordSegments(text) {
    return text.match(
        /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|[^\p{L}\p{N}\p{M}\s]+|\s+/gu,
    ) ?? [];
}

function mergeMarkdownSyntaxUnits(units) {
    const merged = [];

    for (let index = 0; index < units.length; index++) {
        const unit = units[index];
        const next = units[index + 1] ?? '';

        if (unit === '*' && next.startsWith('*')) {
            merged.push(`${unit}${next}`);
            index++;
        } else if (unit === ']' && next === '(') {
            merged.push('](');
            index++;
        } else {
            merged.push(unit);
        }
    }

    return merged;
}

export function streamRevealUnits(value, options = {}) {
    const text = String(value ?? '');

    if (!text)
        return [];

    const wordSegmenter = options.wordSegmenter === undefined
        ? WORD_SEGMENTER
        : options.wordSegmenter;
    const graphemeSegmenter = options.graphemeSegmenter === undefined
        ? GRAPHEME_SEGMENTER
        : options.graphemeSegmenter;

    const rawUnits = [];

    const coarseSegments = wordSegmenter
        ? Array.from(wordSegmenter.segment(text), (entry) => entry.segment)
        : fallbackWordSegments(text);

    for (const coarseSegment of coarseSegments) {
        for (const segment of fallbackWordSegments(coarseSegment))
            rawUnits.push(...splitScriptSensitiveSegment(segment, graphemeSegmenter));
    }

    const units = [];
    let leadingWhitespace = '';

    for (const unit of rawUnits) {
        if (WHITESPACE_RE.test(unit)) {
            if (units.length > 0)
                units[units.length - 1] += unit;
            else
                leadingWhitespace += unit;
        } else {
            units.push(`${leadingWhitespace}${unit}`);
            leadingWhitespace = '';
        }
    }

    if (leadingWhitespace)
        units.push(leadingWhitespace);

    return mergeMarkdownSyntaxUnits(units);
}

function safeUnitCount(text, finishing, allowPartial) {
    const units = streamRevealUnits(text);

    if (finishing || allowPartial || units.length === 0)
        return units.length;

    const lastUnit = units.at(-1) ?? '';
    return /\s$/u.test(lastUnit) ? units.length : Math.max(0, units.length - 1);
}

export class StreamingTextSmoother {
    constructor(options = {}) {
        this._onUpdate = options.onUpdate ?? (() => {});
        this._intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_STREAM_INTERVAL_MS);
        this._idleFlushMs = Math.max(
            this._intervalMs,
            options.idleFlushMs ?? DEFAULT_STREAM_IDLE_FLUSH_MS,
        );
        this._schedule = options.schedule ?? defaultSchedule;
        this._cancel = options.cancel ?? defaultCancel;
        const initialText = String(options.initialText ?? '');
        this._target = initialText.trim() ? initialText : '';
        this._visible = this._target;
        this._tickSourceId = 0;
        this._idleSourceId = 0;
        this._finishing = false;
        this._allowPartial = false;
        this._disposed = false;
        this._finishResolvers = [];
    }

    get targetText() {
        return this._target;
    }

    get visibleText() {
        return this._visible;
    }

    get pending() {
        return this._target.slice(this._visible.length);
    }

    push(nextText) {
        if (this._disposed)
            return this._visible;

        const normalized = String(nextText ?? '');

        if (normalized === this._target)
            return this._visible;

        if (!normalized.startsWith(this._visible)) {
            const previous = this._visible;
            const sharedLength = this._sharedPrefixLength(previous, normalized);

            this._cancelSources();
            this._target = normalized;
            this._visible = normalized.slice(0, sharedLength);
            const firstUnit = streamRevealUnits(normalized.slice(sharedLength))[0] ?? '';

            this._visible += firstUnit;
            this._onUpdate(this._visible, {
                addedText: this._visible.startsWith(previous)
                    ? this._visible.slice(previous.length)
                    : this._visible,
                previousText: previous,
                replace: true,
            });
        } else {
            this._target = normalized;
        }

        this._finishing = false;
        this._allowPartial = false;
        this._cancelIdle();

        if (!this._visible && this._target)
            this._reveal({ allowPartial: true, maximumUnits: 1 });

        if (this._visible !== this._target) {
            this._scheduleTick();
            this._idleSourceId = this._schedule(this._idleFlushMs, () => {
                this._idleSourceId = 0;
                this._allowPartial = true;
                this._reveal({ allowPartial: true, maximumUnits: 1 });
                this._scheduleTick();
            });
        } else {
            this._resolveFinished();
        }

        return this._visible;
    }

    _sharedPrefixLength(first, second) {
        const limit = Math.min(first.length, second.length);
        let length = 0;

        while (length < limit && first[length] === second[length])
            length++;

        return length;
    }

    finish() {
        if (this._disposed || this._visible === this._target)
            return Promise.resolve(this._visible);

        this._finishing = true;
        this._cancelIdle();
        this._scheduleTick();

        return new Promise((resolve) => {
            this._finishResolvers.push(resolve);
        });
    }

    flush(options = {}) {
        if (this._disposed)
            return this._visible;

        this._cancelSources();
        const previous = this._visible;
        this._visible = this._target;

        if (previous !== this._visible) {
            this._onUpdate(this._visible, {
                addedText: this._visible.startsWith(previous)
                    ? this._visible.slice(previous.length)
                    : this._visible,
                previousText: previous,
                replace: options.replace === true || !this._visible.startsWith(previous),
            });
        }

        this._resolveFinished();
        return this._visible;
    }

    dispose(options = {}) {
        if (this._disposed)
            return;

        if (options.flush)
            this.flush();
        else {
            this._cancelSources();
            this._disposed = true;
            this._resolveFinished();
            return;
        }

        this._disposed = true;
    }

    _scheduleTick() {
        if (this._disposed || this._tickSourceId || this._visible === this._target)
            return;

        this._tickSourceId = this._schedule(this._intervalMs, () => {
            this._tickSourceId = 0;
            this._reveal({ allowPartial: this._finishing || this._allowPartial });

            if (this._visible !== this._target)
                this._scheduleTick();
            else
                this._resolveFinished();
        });
    }

    _reveal(options = {}) {
        if (this._disposed || this._visible === this._target)
            return false;

        const remainder = this._target.slice(this._visible.length);
        const units = streamRevealUnits(remainder);
        const availableCount = safeUnitCount(remainder, this._finishing, options.allowPartial === true);

        if (availableCount === 0)
            return false;

        let revealCount = options.maximumUnits ?? 1;

        revealCount = Math.min(availableCount, revealCount);
        const addedText = units.slice(0, revealCount).join('');
        const previous = this._visible;
        this._visible += addedText;
        this._onUpdate(this._visible, {
            addedText,
            previousText: previous,
            replace: false,
        });
        return true;
    }

    _cancelIdle() {
        if (!this._idleSourceId)
            return;

        this._cancel(this._idleSourceId);
        this._idleSourceId = 0;
    }

    _cancelSources() {
        this._cancelIdle();

        if (this._tickSourceId) {
            this._cancel(this._tickSourceId);
            this._tickSourceId = 0;
        }
    }

    _resolveFinished() {
        if (this._visible !== this._target && !this._disposed)
            return;

        this._finishing = false;
        this._allowPartial = false;
        const resolvers = this._finishResolvers.splice(0);

        for (const resolve of resolvers)
            resolve(this._visible);
    }
}
