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
export const DEFAULT_STREAM_TARGET_LAG_MS = 120;
export const DEFAULT_STREAM_RECOVERY_MS = 180;
export const DEFAULT_STREAM_FINISH_DRAIN_MS = 180;
export const DEFAULT_STREAM_MAX_LIVE_LAG_MS = 480;
export const DEFAULT_STREAM_MAX_BATCH_UNITS = 24;
const DEFAULT_STREAM_ARRIVAL_HEADROOM = 1.15;
const STREAM_ARRIVAL_RATE_WINDOW_MS = 250;
const STREAM_RATE_RISE_ALPHA = 0.65;
const STREAM_RATE_FALL_ALPHA = 0.15;
const MIN_TARGET_BACKLOG_UNITS = 2;
const MAX_TARGET_BACKLOG_UNITS = 12;
const STREAM_PRESSURE_RANGE_UNITS = 40;
const MAX_ANIMATED_BATCH_UNITS = 8;
const MIN_ANIMATED_BATCH_UNITS = 4;
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

function defaultNow() {
    return GLib.get_monotonic_time() / 1000;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(value, fallback) {
    const numericValue = Number(value);

    return Number.isFinite(numericValue) ? numericValue : fallback;
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

function safeUnitCount(units, finishing, allowPartial) {
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
        this._now = options.now ?? defaultNow;
        this._targetLagMs = Math.max(
            this._intervalMs,
            finiteNumber(options.targetLagMs, DEFAULT_STREAM_TARGET_LAG_MS),
        );
        this._recoveryMs = Math.max(
            this._intervalMs,
            finiteNumber(options.recoveryMs, DEFAULT_STREAM_RECOVERY_MS),
        );
        this._finishDrainMs = Math.max(
            this._intervalMs,
            finiteNumber(options.finishDrainMs, DEFAULT_STREAM_FINISH_DRAIN_MS),
        );
        this._maxLiveLagMs = Math.max(
            this._intervalMs,
            finiteNumber(options.maxLiveLagMs, DEFAULT_STREAM_MAX_LIVE_LAG_MS),
        );
        this._maxBatchUnits = Math.max(
            1,
            Math.floor(finiteNumber(options.maxBatchUnits, DEFAULT_STREAM_MAX_BATCH_UNITS)),
        );
        this._arrivalHeadroom = Math.max(
            1,
            finiteNumber(options.arrivalHeadroom, DEFAULT_STREAM_ARRIVAL_HEADROOM),
        );
        this._naturalRevealRate = 1000 / this._intervalMs;
        const initialText = String(options.initialText ?? '');
        this._target = initialText.trim() ? initialText : '';
        this._visible = this._target;
        this._tickSourceId = 0;
        this._idleSourceId = 0;
        this._finishing = false;
        this._allowPartial = false;
        this._disposed = false;
        this._finishResolvers = [];
        this._arrivalRate = 0;
        this._revealRate = this._naturalRevealRate;
        this._revealCredit = 0;
        this._lastTickAt = null;
        this._rateSampleAt = null;
        this._sampleBacklog = null;
        this._finishDeadlineAt = 0;
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
        const wasSettled = this._visible === this._target;

        if (normalized === this._target)
            return this._visible;

        if (!normalized.startsWith(this._visible)) {
            const previous = this._visible;
            const sharedLength = this._sharedPrefixLength(previous, normalized);

            this._cancelSources();
            this._resetAdaptiveState({ clearArrivalRate: true });
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
                animationPressure: 0,
                maximumAnimatedUnits: 0,
                revealUnitCount: firstUnit ? 1 : 0,
            });
        } else {
            this._target = normalized;
        }

        this._finishing = false;
        this._finishDeadlineAt = 0;
        this._allowPartial = false;
        this._cancelIdle();

        const now = this._currentTime();

        if (wasSettled) {
            this._lastTickAt = now;
            this._revealRate = this._naturalRevealRate;
            this._revealCredit = 0;
        }

        if (!this._visible && this._target)
            this._reveal({ allowPartial: true, maximumUnits: 1, now });

        if (this._visible !== this._target) {
            this._scheduleTick();
            this._idleSourceId = this._schedule(this._idleFlushMs, () => {
                this._idleSourceId = 0;
                this._allowPartial = true;
                this._reveal({
                    allowPartial: true,
                    maximumUnits: 1,
                    now: this._currentTime(),
                });
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

        if (!this._finishing) {
            const now = this._currentTime();

            this._finishing = true;
            this._finishDeadlineAt = now + this._finishDrainMs;

            if (this._lastTickAt === null)
                this._lastTickAt = now;
        }

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
                animate: false,
                animationPressure: 1,
                maximumAnimatedUnits: 0,
                revealUnitCount: streamRevealUnits(
                    this._visible.startsWith(previous)
                        ? this._visible.slice(previous.length)
                        : this._visible,
                ).length,
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
            const now = this._currentTime();
            const elapsedMs = this._lastTickAt === null
                ? this._intervalMs
                : Math.max(this._intervalMs, now - this._lastTickAt);

            this._lastTickAt = now;
            this._reveal({
                adaptive: true,
                allowPartial: this._finishing || this._allowPartial,
                elapsedMs,
                now,
            });

            if (this._visible !== this._target)
                this._scheduleTick();
            else
                this._resolveFinished();
        });
    }

    _reveal(options = {}) {
        if (this._disposed || this._visible === this._target)
            return false;

        const now = options.now ?? this._currentTime();
        const remainder = this._target.slice(this._visible.length);
        const units = streamRevealUnits(remainder);
        const availableCount = safeUnitCount(units, this._finishing, options.allowPartial === true);

        if (options.adaptive)
            this._sampleArrivalRate(availableCount, now);

        if (availableCount === 0) {
            this._recordBacklog(0, now);
            return false;
        }

        const revealPlan = options.adaptive
            ? this._adaptiveRevealPlan(availableCount, options.elapsedMs, now)
            : {
                animationPressure: 0,
                maximumAnimatedUnits: 1,
                revealCount: options.maximumUnits ?? 1,
            };
        let revealCount = options.maximumUnits ?? revealPlan.revealCount;

        revealCount = Math.min(availableCount, revealCount);
        const addedText = units.slice(0, revealCount).join('');
        const previous = this._visible;
        this._visible += addedText;
        this._onUpdate(this._visible, {
            addedText,
            previousText: previous,
            replace: false,
            animationPressure: revealPlan.animationPressure,
            maximumAnimatedUnits: Math.min(
                revealCount,
                revealPlan.maximumAnimatedUnits,
            ),
            revealUnitCount: revealCount,
        });
        this._recordBacklog(availableCount - revealCount, now);
        return true;
    }

    _adaptiveRevealPlan(availableCount, elapsedMs, now) {
        const targetBacklog = clamp(
            this._arrivalRate * this._targetLagMs / 1000,
            MIN_TARGET_BACKLOG_UNITS,
            MAX_TARGET_BACKLOG_UNITS,
        );
        const steadyRate = Math.max(
            this._naturalRevealRate,
            this._arrivalRate * this._arrivalHeadroom,
        );
        const recoveryRate = Math.max(0, availableCount - targetBacklog)
            * 1000 / this._recoveryMs;
        let desiredRate = steadyRate + recoveryRate;
        const horizonMs = this._finishing
            ? Math.max(this._intervalMs, this._finishDeadlineAt - now)
            : this._maxLiveLagMs;
        const deadlineRate = this._finishing
            ? availableCount * 1000 / horizonMs
            : 0;

        desiredRate = Math.max(desiredRate, deadlineRate);
        const smoothingAlpha = desiredRate > this._revealRate
            ? STREAM_RATE_RISE_ALPHA
            : STREAM_RATE_FALL_ALPHA;

        this._revealRate += smoothingAlpha * (desiredRate - this._revealRate);

        if (this._finishing)
            this._revealRate = Math.max(this._revealRate, deadlineRate);

        this._revealCredit += this._revealRate
            * Math.max(this._intervalMs, elapsedMs ?? this._intervalMs)
            / 1000;

        const remainingTicks = Math.max(1, Math.ceil(horizonMs / this._intervalMs));
        const pacedCapacity = this._maxBatchUnits * remainingTicks;
        const fastForwardCount = Math.max(0, availableCount - pacedCapacity);
        const pacedAvailableCount = availableCount - fastForwardCount;
        const pacedCount = Math.min(
            pacedAvailableCount,
            this._maxBatchUnits,
            Math.max(1, Math.floor(this._revealCredit + Number.EPSILON)),
        );

        this._revealCredit = Math.max(0, this._revealCredit - pacedCount);
        const revealCount = fastForwardCount + pacedCount;
        const backlogPressure = clamp(
            Math.max(0, availableCount - targetBacklog) / STREAM_PRESSURE_RANGE_UNITS,
            0,
            1,
        );
        const batchPressure = this._maxBatchUnits === 1
            ? 0
            : clamp((pacedCount - 1) / (this._maxBatchUnits - 1), 0, 1);
        const animationPressure = this._finishing || fastForwardCount > 0
            ? 1
            : Math.max(backlogPressure, batchPressure);
        const maximumAnimatedUnits = Math.max(
            MIN_ANIMATED_BATCH_UNITS,
            Math.round(
                MAX_ANIMATED_BATCH_UNITS
                - (MAX_ANIMATED_BATCH_UNITS - MIN_ANIMATED_BATCH_UNITS)
                    * animationPressure,
            ),
        );

        return {
            animationPressure,
            maximumAnimatedUnits,
            revealCount,
        };
    }

    _sampleArrivalRate(backlog, now) {
        if (this._rateSampleAt === null || this._sampleBacklog === null)
            return;

        const elapsedMs = Math.max(this._intervalMs, now - this._rateSampleAt);
        const arrivedUnits = Math.max(0, backlog - this._sampleBacklog);
        const instantaneousRate = arrivedUnits * 1000 / elapsedMs;
        const alpha = 1 - Math.exp(-elapsedMs / STREAM_ARRIVAL_RATE_WINDOW_MS);

        this._arrivalRate += alpha * (instantaneousRate - this._arrivalRate);
    }

    _recordBacklog(backlog, now) {
        this._sampleBacklog = Math.max(0, backlog);
        this._rateSampleAt = now;
    }

    _currentTime() {
        const now = Number(this._now());

        return Number.isFinite(now) ? now : defaultNow();
    }

    _resetAdaptiveState(options = {}) {
        this._revealRate = this._naturalRevealRate;
        this._revealCredit = 0;
        this._lastTickAt = null;
        this._rateSampleAt = null;
        this._sampleBacklog = null;
        this._finishDeadlineAt = 0;

        if (options.clearArrivalRate)
            this._arrivalRate = 0;
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
        this._finishDeadlineAt = 0;
        this._allowPartial = false;
        this._revealCredit = 0;
        this._recordBacklog(0, this._currentTime());
        const resolvers = this._finishResolvers.splice(0);

        for (const resolve of resolvers)
            resolve(this._visible);
    }
}
