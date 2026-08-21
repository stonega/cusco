import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

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

    _cancelBottomPasses() {
        if (this._scrollSourceId) {
            GLib.source_remove(this._scrollSourceId);
            this._scrollSourceId = 0;
        }

        this._scrollPasses = 0;
    }

    getBottomValue() {
        const scroller = this._getScroller();
        if (!scroller)
            return 0;

        const adjustment = scroller.get_vadjustment();
        return Math.max(0, adjustment.get_upper() - adjustment.get_page_size());
    }

    preflightBottom() {
        if (this._isBatchRendering())
            return false;

        const scroller = this._getScroller();
        const child = scroller?.get_child?.();

        if (!scroller || !child)
            return false;

        const adjustment = scroller.get_vadjustment();
        const pageSize = adjustment.get_page_size();
        const allocatedWidth = child.get_width?.() ?? 0;

        if (pageSize <= 0 || allocatedWidth <= 0 || typeof child.measure !== 'function')
            return false;

        const [minimumHeight, naturalHeight] = child.measure(
            Gtk.Orientation.VERTICAL,
            allocatedWidth,
        );
        const measuredUpper = Math.max(
            pageSize,
            Math.ceil(minimumHeight),
            Math.ceil(naturalHeight),
        );

        if (!Number.isFinite(measuredUpper) || measuredUpper <= adjustment.get_upper())
            return false;

        // Gtk updates a viewport adjustment's upper bound during allocation.
        // Streaming labels can already report their new height before that
        // allocation begins, so publish the measured bound now. Otherwise the
        // old scroll offset is painted for one frame and corrected afterward,
        // visibly moving the whole message and its Working footer.
        adjustment.set_upper(measuredUpper);
        adjustment.set_value(Math.max(0, measuredUpper - pageSize));
        return true;
    }

    pinToBottom() {
        if (this._isBatchRendering()) {
            this._scrollPasses = Math.max(this._scrollPasses, 1);
            return false;
        }

        const scroller = this._getScroller();

        if (!scroller)
            return false;

        this.stopAnimation();
        this._cancelBottomPasses();
        const adjustment = scroller.get_vadjustment();

        adjustment.set_value(Math.max(
            0,
            adjustment.get_upper() - adjustment.get_page_size(),
        ));
        this.syncButton();
        return true;
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

        if (this.followLatest)
            this.preflightBottom();

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
        this._cancelBottomPasses();
    }
}
