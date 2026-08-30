import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { TranscriptScrollController } from '../src/chat/scrollController.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function delay(milliseconds) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function boundsY(widget, ancestor) {
    const [computed, bounds] = widget.compute_bounds(ancestor);

    return computed ? Math.round(bounds.get_y()) : null;
}

const adjustment = {
    upper: 620,
    pageSize: 200,
    value: 100,
    get_upper() {
        return this.upper;
    },
    get_page_size() {
        return this.pageSize;
    },
    get_lower() {
        return 0;
    },
    get_step_increment() {
        return 40;
    },
    get_value() {
        return this.value;
    },
    set_value(value) {
        this.value = value;
    },
    set_upper(upper) {
        this.upper = upper;
    },
};
let measuredHeight = 700;
const measuredChild = {
    get_width: () => 900,
    measure: () => [measuredHeight, measuredHeight, -1, -1],
};
const scroller = {
    get_vadjustment: () => adjustment,
    get_child: () => measuredChild,
};
const scrollButton = {
    visible: null,
    set_visible(visible) {
        this.visible = visible;
    },
};
let batchRendering = false;
const controller = new TranscriptScrollController({
    appSettings: { reducedMotionEnabled: false },
    getScroller: () => scroller,
    getScrollButton: () => scrollButton,
    isBatchRendering: () => batchRendering,
});

controller.followLatest = true;
assert(controller.preflightBottom(), 'Stream growth did not preflight its scroll geometry');
assert(
    adjustment.upper === 700 && adjustment.value === 500,
    'Preflight bottom pinning did not use the synchronously measured content height',
);
controller.followLatest = false;
adjustment.upper = 620;
adjustment.value = 100;

controller.scrollToBottom();
assert(controller._scrollSourceId !== 0, 'Bottom scrolling did not queue its fallback pass');
assert(controller.pinToBottom(), 'Post-layout bottom pinning did not run');
assert(adjustment.value === 420, `Bottom pin used the wrong value: ${adjustment.value}`);
assert(
    controller._scrollSourceId === 0 && controller._scrollPasses === 0,
    'Post-layout bottom pinning retained a stale fallback pass',
);

adjustment.upper = 700;
assert(controller.pinToBottom(), 'Updated adjustment geometry was not pinned');
assert(adjustment.value === 500, 'Bottom pin did not use the updated adjustment upper bound');

batchRendering = true;
adjustment.upper = 800;
measuredHeight = 900;
assert(!controller.preflightBottom(), 'Batch rendering unexpectedly preflight scroll geometry');
assert(!controller.pinToBottom(), 'Batch rendering unexpectedly moved the viewport');
assert(
    adjustment.value === 500 && controller._scrollPasses === 1,
    'Batch rendering did not retain one deferred bottom pass',
);

batchRendering = false;
assert(controller.pinToBottom(), 'Bottom pin did not resume after batch rendering');
assert(adjustment.value === 600, 'Resumed bottom pin used stale adjustment geometry');
assert(scrollButton.visible === false, 'Pinned transcript left the scroll-to-bottom button visible');

controller.followLatest = true;
assert(controller.handleUserScroll(-1), 'Upward user input did not pause transcript following');
adjustment.value = 520;
assert(!controller.handleAdjustmentValueChanged(), 'Transcript following resumed before reaching the bottom');
assert(
    !controller.followLatest && controller._pausedByUser && scrollButton.visible,
    'Paused transcript following did not preserve the viewport or reveal its return control',
);
adjustment.value = 600;
assert(controller.handleAdjustmentValueChanged(), 'Returning to the bottom did not resume following');
assert(controller.followLatest && !controller._pausedByUser, 'Resumed following retained its pause state');

adjustment.value = 500;
assert(controller.handleUserScroll(-1), 'A second upward scroll did not pause following');
controller.setFollowLatest(false);
assert(
    adjustment.value === 500 && controller._scrollSourceId === 0,
    'Response completion pulled a user-paused transcript back to the bottom',
);

adjustment.upper = 1000;
adjustment.pageSize = 200;
adjustment.value = 100;
assert(controller.scrollBy(2), 'Wheel input was not routed to the transcript');
assert(adjustment.value === 180, `Wheel input used the wrong scroll distance: ${adjustment.value}`);
assert(controller.scrollBy(12.5, Gdk.ScrollUnit.SURFACE), 'Touchpad input was not routed');
assert(adjustment.value === 192.5, `Touchpad input lost its smooth delta: ${adjustment.value}`);
controller.followLatest = true;
assert(controller.scrollBy(-1), 'Upward selector scrolling was not routed');
assert(!controller.followLatest && controller._pausedByUser, 'Routed upward scrolling did not pause following');
controller.scrollBy(-100);
assert(adjustment.value === 0, 'Routed scrolling moved above the transcript');
controller.scrollBy(100);
assert(adjustment.value === 800, 'Routed scrolling moved below the transcript');

controller.dispose();

if (Gtk.init_check()) {
    const prefix = Array.from(
        { length: 20 },
        (_unused, index) => `Existing transcript line ${index + 1}`,
    ).join('\n');
    const suffix = [
        '这是最重要的一次形象革命，主要来自美国的墨西哥裔作家与学者。',
        ...Array.from(
            { length: 4 },
            (_unused, index) => `New streamed line ${index + 1}`,
        ),
    ].join('\n');
    const label = new Gtk.Label({
        label: prefix,
        wrap: true,
        xalign: 0,
    });
    const working = new Gtk.Label({ label: 'Working… 22s', xalign: 0 });
    const bubble = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    });
    const messages = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 8,
        margin_start: 26,
        margin_end: 26,
    });
    const spacer = new Gtk.Box();
    const stack = new Gtk.Stack({
        hhomogeneous: false,
        vhomogeneous: false,
    });

    spacer.set_size_request(-1, 260);
    bubble.append(label);
    bubble.append(working);
    messages.append(bubble);
    messages.append(spacer);
    stack.add_child(messages);

    const gtkScroller = new Gtk.ScrolledWindow({
        child: stack,
        hexpand: true,
        vexpand: true,
    });
    const window = new Gtk.Window({
        child: gtkScroller,
        default_width: 1022,
        default_height: 362,
    });
    const gtkController = new TranscriptScrollController({
        appSettings: { reducedMotionEnabled: false },
        getScroller: () => gtkScroller,
        getScrollButton: () => null,
        isBatchRendering: () => false,
    });
    const gtkAdjustment = gtkScroller.get_vadjustment();
    let anchoredY = null;
    const changedPositions = [];

    gtkAdjustment.connect('changed', () => {
        if (gtkController.followLatest)
            gtkController.pinToBottom();

        if (anchoredY !== null)
            changedPositions.push(boundsY(working, gtkScroller));
    });
    window.present();
    await delay(50);
    gtkController.setFollowLatest(true);
    await delay(50);
    anchoredY = boundsY(working, gtkScroller);
    label.set_label(`${prefix}\n${suffix}`);
    gtkController.scrollToBottom();
    await delay(50);

    assert(changedPositions.length > 0, 'GTK stream growth did not update scroll geometry');
    assert(
        changedPositions.every((position) => Math.abs(position - anchoredY) <= 1),
        `GTK painted a late bottom correction: ${anchoredY} -> ${changedPositions.join(', ')}`,
    );
    assert(
        Math.abs(boundsY(working, gtkScroller) - anchoredY) <= 1,
        'The streamed Working footer did not retain its viewport position',
    );

    gtkController.dispose();
    window.set_child(null);
    window.destroy();
    await delay(20);
}

print('Cusco scroll controller smoke passed');
