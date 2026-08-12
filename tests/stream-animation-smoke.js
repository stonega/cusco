import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { markdownToPangoRenderModel } from '../src/chat/markdown.js';
import {
    AnimatedMarkdownLabel,
    animationByteRanges,
    animationVisibleByteRanges,
} from '../src/chat/streamAnimation.js';

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

const model = markdownToPangoRenderModel('Hello `code` world');
const ranges = animationByteRanges('', model.plainText, model.excludedAnimationRanges);
const encoder = new TextEncoder();
const codeStart = encoder.encode('Hello ').length;
const codeEnd = codeStart + encoder.encode('code').length;

assert(ranges.length > 0, 'Animation did not identify new rendered text');
assert(
    !ranges.some((range) => range.start < codeEnd && codeStart < range.end),
    'Inline code was included in animated text ranges',
);

const baseRanges = animationVisibleByteRanges([{ start: 6, end: 11 }], 11);
assert(
    JSON.stringify(baseRanges) === JSON.stringify([{ start: 0, end: 6 }]),
    'Animated glyphs were not removed from the base text layer',
);

if (Gtk.init_check()) {
    for (const style of ['fadeIn', 'blurIn', 'slideUp']) {
        const label = new AnimatedMarkdownLabel({ wrap: true, xalign: 0 });
        const window = new Gtk.Window({ child: label });

        window.present();
        await delay(30);
        assert(label.get_mapped(), `${style} test label was not mapped`);
        label.configureStreamAnimation({ style, motionEnabled: () => true });
        label.setRenderModel(markdownToPangoRenderModel('Hello'), { animate: false });
        label.setRenderModel(markdownToPangoRenderModel('Hello world'), { animate: true });
        assert(label._activeRanges.length > 0, `${style} did not create an active range`);
        const snapshot = new Gtk.Snapshot();
        label.vfunc_snapshot(snapshot);
        await label.waitForAnimations();
        window.destroy();
    }

    const reducedMotionLabel = new AnimatedMarkdownLabel();
    reducedMotionLabel.configureStreamAnimation({
        style: 'blurIn',
        motionEnabled: () => false,
    });
    reducedMotionLabel.setRenderModel(markdownToPangoRenderModel('Static text'), { animate: true });
    await reducedMotionLabel.waitForAnimations();

    const hiddenLabel = new AnimatedMarkdownLabel({ wrap: true, xalign: 0 });
    const visibleLabel = new Gtk.Label({ label: 'Visible child' });
    const stack = new Gtk.Stack();
    const hiddenWindow = new Gtk.Window({ child: stack });

    stack.add_named(hiddenLabel, 'hidden');
    stack.add_named(visibleLabel, 'visible');
    stack.set_visible_child_name('visible');
    hiddenWindow.present();
    await delay(30);
    hiddenLabel.configureStreamAnimation({ style: 'blurIn', motionEnabled: () => true });
    hiddenLabel.setRenderModel(markdownToPangoRenderModel('Hello'), { animate: false });
    hiddenLabel.setRenderModel(markdownToPangoRenderModel('Hello world'), { animate: true });
    await hiddenLabel.waitForAnimations();
    assert(
        hiddenLabel._activeRanges.length === 0,
        'An unmapped cached conversation retained an animation range',
    );
    hiddenWindow.destroy();
}

print('Cusco stream animation smoke passed');
