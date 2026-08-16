import GLib from 'gi://GLib?version=2.0';

const SCROLL_TO_BOTTOM_ANIMATION_MS = 180;
const SCROLL_TO_BOTTOM_ANIMATION_INTERVAL_MS = 16;

export class TranscriptScrollController {
    constructor({
        appSettings,
        getScroller,
        getScrollButton,
        isBatchRendering,
    }) {
        this._appSettings = appSettings;
        this._getScroller = getScroller;
        this._getScrollButton = getScrollButton;
        this._isBatchRendering = isBatchRendering;
        this.followLatest = false;
        this._scrollSourceId = 0;
        this._scrollPasses = 0;
        this._animationSourceId = 0;
    }

    setFollowLatest(enabled) {
        this.followLatest = Boolean(enabled);
        this.scrollToBottom({ passes: enabled ? 3 : 2 });
    }

    stopAnimation() {
        if (!this._animationSourceId)
            return;

        GLib.source_remove(this._animationSourceId);
        this._animationSourceId = 0;
    }

    getBottomValue() {
        const scroller = this._getScroller();
        if (!scroller)
            return 0;

        const adjustment = scroller.get_vadjustment();
        return Math.max(0, adjustment.get_upper() - adjustment.get_page_size());
    }

    animateToBottom() {
        const scroller = this._getScroller();
        if (!scroller || this._appSettings.reducedMotionEnabled) {
            this.scrollToBottom({ passes: 2 });
            return;
        }

        this.stopAnimation();

        const adjustment = scroller.get_vadjustment();
        const startValue = adjustment.get_value();
        const startTime = GLib.get_monotonic_time();

        if (Math.abs(this.getBottomValue() - startValue) < 1) {
            adjustment.set_value(this.getBottomValue());
            this.syncButton();
            return;
        }

        this._animationSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SCROLL_TO_BOTTOM_ANIMATION_INTERVAL_MS,
            () => {
                const elapsedMs = (GLib.get_monotonic_time() - startTime) / 1000;
                const progress = Math.min(1, elapsedMs / SCROLL_TO_BOTTOM_ANIMATION_MS);
                const easedProgress = 1 - Math.pow(1 - progress, 3);
                const endValue = this.getBottomValue();

                adjustment.set_value(startValue + ((endValue - startValue) * easedProgress));
                this.syncButton();

                if (progress < 1)
                    return GLib.SOURCE_CONTINUE;

                adjustment.set_value(this.getBottomValue());
                this._animationSourceId = 0;
                this.syncButton();
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    queueBottomPass() {
        if (this._scrollSourceId)
            return;

        this._scrollSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollSourceId = 0;
            const scroller = this._getScroller();

            if (!scroller) {
                this._scrollPasses = 0;
                return GLib.SOURCE_REMOVE;
            }

            const adjustment = scroller.get_vadjustment();
            adjustment.set_value(this.getBottomValue());
            this._scrollPasses = Math.max(0, this._scrollPasses - 1);
            this.syncButton();

            if (this._scrollPasses > 0)
                this.queueBottomPass();

            return GLib.SOURCE_REMOVE;
        });
    }

    scrollToBottom(options = {}) {
        if (!this._getScroller())
            return;

        if (this._isBatchRendering()) {
            const passes = Math.max(1, Math.round(options.passes ?? 1));
            this._scrollPasses = Math.max(this._scrollPasses, passes);
            return;
        }

        if (options.animate && !this.followLatest) {
            this.animateToBottom();
            return;
        }

        this.stopAnimation();
        const passes = Math.max(1, Math.round(options.passes ?? (this.followLatest ? 3 : 1)));
        this._scrollPasses = Math.max(this._scrollPasses, passes);
        this.queueBottomPass();
    }

    syncButton() {
        const button = this._getScrollButton();
        const scroller = this._getScroller();

        if (!button || !scroller)
            return;

        const adjustment = scroller.get_vadjustment();
        const pageSize = adjustment.get_page_size();
        const maxValue = Math.max(0, adjustment.get_upper() - pageSize);
        const distanceToBottom = Math.max(0, maxValue - adjustment.get_value());
        const shouldShow = !this.followLatest && pageSize > 0 && distanceToBottom > pageSize;

        button.set_visible(shouldShow);
    }

    dispose() {
        this.stopAnimation();
        if (this._scrollSourceId) {
            GLib.source_remove(this._scrollSourceId);
            this._scrollSourceId = 0;
        }
    }
}
