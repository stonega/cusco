import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { markdownToPangoRenderModel } from '../src/chat/markdown.js';
import {
    AnimatedMarkdownLabel,
    animationByteRanges,
    animationVisibleByteRanges,
} from '../src/chat/streamAnimation.js';
import {
    AgentActivityPresenter,
    createReasoningPreviewLabel,
    reasoningPreviewText,
} from '../src/chat/agentActivityPresenter.js';
import { createMessageWrapper } from '../src/chat/messagePresenter.js';
import { estimatedReasoningLineCount } from '../src/chat/reasoningPreview.js';

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
assert(
    reasoningPreviewText('First line\n  second\tline') === 'First line\nsecond line',
    'Reasoning preview did not retain completed line boundaries',
);
assert(
    estimatedReasoningLineCount('First\nSecond\nThird', 72) === 3,
    'Reasoning preview did not count explicit streamed lines',
);
assert(
    estimatedReasoningLineCount('123456789', 4) === 3,
    'Reasoning preview did not count wrapped streamed lines',
);

if (Gtk.init_check()) {
    const messageList = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        width_request: 720,
    });
    const assistantMessageRow = createMessageWrapper('assistant');
    const userMessageRow = createMessageWrapper('user');

    assistantMessageRow.append(new Gtk.Label({ label: 'Short answer' }));
    userMessageRow.append(new Gtk.Label({ label: 'Short prompt' }));
    messageList.append(assistantMessageRow);
    messageList.append(userMessageRow);

    const messageLayoutWindow = new Gtk.Window({ child: messageList });

    messageLayoutWindow.present();
    await delay(30);

    assert(
        assistantMessageRow.get_hexpand()
            && assistantMessageRow.get_halign() === Gtk.Align.FILL,
        'Assistant message row did not reserve its available width immediately',
    );
    assert(
        assistantMessageRow.get_width() === messageList.get_width(),
        'Short assistant message did not receive the full conversation width',
    );
    assert(
        !userMessageRow.get_hexpand()
            && userMessageRow.get_halign() === Gtk.Align.END
            && userMessageRow.get_width() < assistantMessageRow.get_width(),
        'Short user message stopped using its compact content width',
    );
    messageLayoutWindow.destroy();

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

    const zeroStaggerLabel = new AnimatedMarkdownLabel();
    zeroStaggerLabel.configureStreamAnimation({
        style: 'fadeIn',
        staggerMs: 0,
        motionEnabled: () => true,
    });
    assert(
        zeroStaggerLabel._animationStaggerMs === 0,
        'Stream animation did not accept a zero-millisecond debug stagger',
    );

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

    const reasoningPreview = createReasoningPreviewLabel({
        streamAnimationStyle: 'fadeIn',
        motionEnabled: () => true,
    });
    const reasoningWindow = new Gtk.Window({ child: reasoningPreview });

    reasoningWindow.present();
    await delay(30);
    reasoningPreview.updateReasoningPreview('First thought');
    const initialTransitionCount = reasoningPreview.getReasoningLineTransitionCount();

    reasoningPreview.updateReasoningPreview('First thought\nSecond thought still streaming');
    if (reasoningPreview.getReasoningLineTransitionType()
        === Gtk.RevealerTransitionType.SLIDE_UP) {
        assert(
            reasoningPreview.getReasoningLineTransitionCount() === initialTransitionCount + 1,
            'Completed reasoning line did not start an upward transition',
        );
    }
    await reasoningPreview.finishReasoningPreview();
    reasoningPreview.updateReasoningPreview([
        'First thought',
        'Second thought still streaming',
        'Third thought',
        'Fourth thought arriving from below',
    ].join('\n'));
    await reasoningPreview.finishReasoningPreview();
    const visibleReasoningLines = reasoningPreview.getReasoningPreviewLines();

    assert(
        visibleReasoningLines.length === 3
            && visibleReasoningLines[0] === 'Third thought'
            && visibleReasoningLines.slice(1).join('') === 'Fourth thought arriving from below',
        `Live reasoning ticker retained unexpected lines: ${JSON.stringify(visibleReasoningLines)}`,
    );
    const firstReasoningRow = reasoningPreview.get_first_child();
    const firstReasoningLine = firstReasoningRow.get_child();

    assert(firstReasoningLine.get_single_line_mode(), 'Reasoning ticker row was not single-line');
    assert(
        firstReasoningLine.get_ellipsize() === Pango.EllipsizeMode.END,
        'Reasoning ticker row did not constrain overflow',
    );
    reasoningWindow.destroy();

    const activityPresenter = new AgentActivityPresenter({
        appSettings: { reducedMotionEnabled: true },
        getParentWindow: () => null,
        clearBox: () => {},
        messageContentOptions: () => ({
            streamAnimationStyle: 'fadeIn',
            motionEnabled: () => true,
        }),
    });
    const reasoningExpander = activityPresenter._createReasoningExpander(
        () => new Gtk.Label({ label: 'Finished reasoning' }),
        { isActive: true },
    );
    const expanderWindow = new Gtk.Window({ child: reasoningExpander });

    expanderWindow.present();
    await delay(30);
    reasoningExpander.updatePreview('A live reasoning update');
    const reasoningHeader = reasoningExpander.get_first_child();
    const reasoningRevealer = reasoningHeader.get_next_sibling();

    assert(
        reasoningRevealer.get_reveal_child(),
        'Live reasoning did not keep its body expanded while streaming',
    );
    reasoningExpander.clearPreview();
    assert(
        !reasoningRevealer.get_reveal_child(),
        'Completed reasoning kept the temporary loading preview expanded',
    );
    expanderWindow.destroy();
}

print('Cusco stream animation smoke passed');
