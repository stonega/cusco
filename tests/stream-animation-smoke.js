import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { markdownToPangoRenderModel } from '../src/chat/markdown.js';
import {
    AnimatedMessageActions,
    AnimatedMarkdownLabel,
    animationByteRangeGroup,
    animationByteRanges,
    animationVisibleByteRanges,
    streamEntranceFrame,
} from '../src/chat/streamAnimation.js';
import { createMessageContent } from '../src/chat/messageView.js';
import {
    AgentActivityPresenter,
    createReasoningPreviewLabel,
    reasoningPreviewText,
} from '../src/chat/agentActivityPresenter.js';
import { createMessageWrapper } from '../src/chat/messagePresenter.js';
import {
    estimatedReasoningLineCount,
    reasoningTransitionPlan,
} from '../src/chat/reasoningPreview.js';

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
const groupedRanges = animationByteRangeGroup('Hello', 'Hello one two three');

assert(
    groupedRanges.length === 1
        && groupedRanges[0].start === encoder.encode('Hello').length
        && groupedRanges[0].end === encoder.encode('Hello one two three').length,
    'A multi-word reveal was not merged into one animation group range',
);
const groupedMarkdownRanges = animationByteRangeGroup(
    '',
    model.plainText,
    model.excludedAnimationRanges,
);

assert(
    groupedMarkdownRanges.length === 2
        && !groupedMarkdownRanges.some(
            (range) => range.start < codeEnd && codeStart < range.end,
        ),
    'Grouped animation ranges did not preserve the inline-code exclusion',
);
const boundedText = 'Start one two three four five six seven eight nine ten';
const boundedUnits = animationByteRanges('Start', boundedText).slice(-4);
const boundedGroup = animationByteRangeGroup('Start', boundedText, [], 4);

assert(
    boundedGroup[0].start === boundedUnits[0].start
        && boundedGroup.at(-1).end === boundedUnits.at(-1).end,
    'Grouped catch-up animation did not retain only the final bounded units',
);

const baseRanges = animationVisibleByteRanges([{ start: 6, end: 11 }], 11);
assert(
    JSON.stringify(baseRanges) === JSON.stringify([{ start: 0, end: 6 }]),
    'Animated glyphs were not removed from the base text layer',
);
const halfwayBlurFrame = streamEntranceFrame('blurIn', 0.5);
const halfwaySlideFrame = streamEntranceFrame('slideUp', 0.5);

assert(
    Math.abs(halfwayBlurFrame.opacity - 0.875) < 0.0001
        && Math.abs(halfwayBlurFrame.blurRadius - 0.5) < 0.0001
        && halfwayBlurFrame.translationY === 0,
    'Blur-in action motion diverged from the streamed glyph curve',
);
assert(
    Math.abs(halfwaySlideFrame.opacity - 0.875) < 0.0001
        && Math.abs(halfwaySlideFrame.translationY - 0.5) < 0.0001
        && halfwaySlideFrame.blurRadius === 0,
    'Slide-up action motion diverged from the streamed glyph curve',
);
assert(
    streamEntranceFrame('none', 0).opacity === 1,
    'Disabled stream motion did not remain immediately visible',
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
const naturalReasoningTransition = reasoningTransitionPlan(1);
const burstReasoningTransition = reasoningTransitionPlan(20);
const finishingReasoningTransition = reasoningTransitionPlan(5, { finishing: true });

assert(
    naturalReasoningTransition.skippedLineCount === 0
        && naturalReasoningTransition.transitionDurationMs === 180,
    'A single reasoning line did not retain its natural transition',
);
assert(
    burstReasoningTransition.skippedLineCount === 19
        && burstReasoningTransition.transitionDurationMs === 100,
    'A reasoning burst did not compact to one shortened tail transition',
);
assert(
    finishingReasoningTransition.skippedLineCount === 4
        && finishingReasoningTransition.transitionDurationMs === 100,
    'Finishing reasoning did not use its bounded catch-up transition',
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

    const completionContent = createMessageContent('', {
        role: 'assistant',
        streaming: true,
        selectable: false,
        streamAnimationStyle: 'fadeIn',
        streamRevealIntervalMs: 12,
        streamIdleFlushMs: 24,
        motionEnabled: () => true,
    });
    const completionWindow = new Gtk.Window({ child: completionContent });

    completionWindow.present();
    await delay(30);
    completionContent.updateContent('The final streamed words');
    const completionPhases = [];
    const completionPromise = completionContent.finishStreaming({
        selectable: true,
        onContentRevealed() {
            completionPhases.push('content-revealed');
        },
    });

    await completionPromise;
    completionPhases.push('presentation-settled');
    assert(
        completionPhases.join(',') === 'content-revealed,presentation-settled',
        'Content reveal completion did not precede the visual animation tail',
    );
    completionWindow.set_child(null);
    completionWindow.destroy();

    const animatedActions = new AnimatedMessageActions({
        orientation: Gtk.Orientation.HORIZONTAL,
    });
    animatedActions.append(new Gtk.Button({ icon_name: 'edit-copy-symbolic' }));
    const animatedActionsWindow = new Gtk.Window({ child: animatedActions });

    animatedActionsWindow.present();
    await delay(30);
    animatedActions.configureStreamAnimation({
        style: 'blurIn',
        durationMs: 200,
        motionEnabled: () => true,
    });
    assert(
        animatedActions.startEntranceAnimation(),
        'Mapped streamed message actions did not start their entrance animation',
    );
    await animatedActions.waitForEntranceAnimation();
    assert(
        !animatedActions._entranceActive,
        'Streamed message action animation did not settle',
    );
    animatedActions.configureStreamAnimation({
        style: 'slideUp',
        motionEnabled: () => false,
    });
    assert(
        !animatedActions.startEntranceAnimation(),
        'Reduced motion still animated the message actions',
    );
    animatedActionsWindow.set_child(null);
    animatedActionsWindow.destroy();
    await delay(10);

    for (const style of ['fadeIn', 'blurIn', 'slideUp']) {
        const label = new AnimatedMarkdownLabel({ wrap: true, xalign: 0 });
        const window = new Gtk.Window({ child: label });

        window.present();
        await delay(30);
        assert(label.get_mapped(), `${style} test label was not mapped`);
        label.configureStreamAnimation({ style, motionEnabled: () => true });
        label.setRenderModel(markdownToPangoRenderModel('Hello'), { animate: false });
        label.setRenderModel(markdownToPangoRenderModel('Hello one two three'), { animate: true });
        assert(
            label._activeGroups.length === 1
                && label._activeGroups[0].ranges.length === 1,
            `${style} did not collect a multi-word reveal into one animation group`,
        );
        const firstGroup = label._activeGroups[0];
        const firstGroupRanges = JSON.stringify(firstGroup.ranges);

        label.setRenderModel(
            markdownToPangoRenderModel('Hello one two three four five'),
            { animate: true },
        );
        assert(
            label._activeGroups.length === 2
                && label._activeGroups[0].startTime === firstGroup.startTime
                && JSON.stringify(label._activeGroups[0].ranges) === firstGroupRanges,
            `${style} did not keep later reveal updates in independent animation groups`,
        );
        const snapshot = new Gtk.Snapshot();
        label.vfunc_snapshot(snapshot);
        await label.waitForAnimations();
        assert(
            label._activeGroups.length === 0,
            `${style} retained a completed animation group`,
        );
        window.destroy();
    }

    const pressuredLabel = new AnimatedMarkdownLabel({ wrap: true, xalign: 0 });
    const pressuredWindow = new Gtk.Window({ child: pressuredLabel });

    pressuredWindow.present();
    await delay(30);
    pressuredLabel.configureStreamAnimation({
        style: 'fadeIn',
        durationMs: 200,
        pressure: 1,
        maximumAnimatedUnits: 4,
        motionEnabled: () => true,
    });
    assert(
        pressuredLabel._animationDurationMs === 120,
        'Backlog pressure did not shorten the streaming animation',
    );
    pressuredLabel.setRenderModel(markdownToPangoRenderModel('Start'), { animate: false });
    const pressuredText = 'Start one two three four five six seven eight nine ten';
    const expectedPressureRanges = animationByteRanges('Start', pressuredText).slice(-4);

    pressuredLabel.setRenderModel(markdownToPangoRenderModel(pressuredText), { animate: true });
    const pressuredGroup = pressuredLabel._activeGroups[0];
    assert(
        pressuredLabel._activeGroups.length === 1
            && pressuredGroup.ranges[0].start === expectedPressureRanges[0].start
            && pressuredGroup.ranges.at(-1).end === expectedPressureRanges.at(-1).end,
        'Catch-up animation did not group the final bounded reveal units',
    );
    await pressuredLabel.waitForAnimations();
    pressuredWindow.destroy();

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
        hiddenLabel._activeGroups.length === 0,
        'An unmapped cached conversation retained an animation group',
    );
    hiddenWindow.destroy();

    let trackReasoningGeometry = false;
    const reasoningFrameHeights = [];
    const reasoningMeasureWidth = 720;
    let reasoningPreview = null;

    reasoningPreview = createReasoningPreviewLabel({
        streamAnimationStyle: 'fadeIn',
        streamRevealIntervalMs: 1,
        streamIdleFlushMs: 1,
        motionEnabled: () => true,
        onStreamFrame: () => {
            if (!trackReasoningGeometry)
                return;

            const [minimum, natural] = reasoningPreview.measure(
                Gtk.Orientation.VERTICAL,
                reasoningMeasureWidth,
            );

            reasoningFrameHeights.push({
                allocated: reasoningPreview.get_height(),
                minimum,
                natural,
            });
        },
    });
    const reasoningWindow = new Gtk.Window({
        child: reasoningPreview,
        default_width: 720,
    });

    reasoningWindow.present();
    await delay(30);
    reasoningPreview.updateReasoningPreview('First thought');
    await reasoningPreview.finishReasoningPreview();
    await delay(30);
    const initialTransitionCount = reasoningPreview.getReasoningLineTransitionCount();
    const initialReasoningRows = [];
    let initialReasoningRow = reasoningPreview.get_first_child();

    while (initialReasoningRow) {
        initialReasoningRows.push(initialReasoningRow);
        initialReasoningRow = initialReasoningRow.get_next_sibling();
    }

    assert(
        initialReasoningRows.length === 3,
        'Live reasoning did not reserve its fixed three-row footprint',
    );
    const [initialReasoningMinimum, initialReasoningNatural] = reasoningPreview.measure(
        Gtk.Orientation.VERTICAL,
        reasoningMeasureWidth,
    );
    const initialReasoningHeight = reasoningPreview.get_height();

    trackReasoningGeometry = true;
    reasoningPreview.updateReasoningPreview('First thought\nSecond thought still streaming');
    const reasoningTransitionEnabled = reasoningPreview.getReasoningLineTransitionType()
        === Gtk.RevealerTransitionType.CROSSFADE;

    await reasoningPreview.finishReasoningPreview();
    if (reasoningTransitionEnabled) {
        assert(
            reasoningPreview.getReasoningLineTransitionCount() === initialTransitionCount + 1,
            'Completed reasoning line did not start its fixed-slot fade',
        );
    }
    reasoningPreview.updateReasoningPreview([
        'First thought',
        'Second thought still streaming',
        'Third thought',
    ].join('\n'));
    await reasoningPreview.finishReasoningPreview();
    trackReasoningGeometry = false;
    assert(
        reasoningFrameHeights.length > 0
            && reasoningFrameHeights.every(({ allocated, minimum, natural }) => (
                allocated === initialReasoningHeight
                    && minimum === initialReasoningMinimum
                    && natural === initialReasoningNatural
            )),
        `Reasoning initial fill changed its fixed layout footprint: ${JSON.stringify(reasoningFrameHeights)}`,
    );

    const reasoningRowsBeforeRollover = [];
    let reasoningRow = reasoningPreview.get_first_child();

    while (reasoningRow) {
        reasoningRowsBeforeRollover.push(reasoningRow);
        reasoningRow = reasoningRow.get_next_sibling();
    }

    const [baselineReasoningMinimum, baselineReasoningNatural] = reasoningPreview.measure(
        Gtk.Orientation.VERTICAL,
        reasoningMeasureWidth,
    );
    const baselineReasoningHeight = reasoningPreview.get_height();
    const rolloverTransitionStart = reasoningPreview.getReasoningLineTransitionCount();

    reasoningFrameHeights.length = 0;
    trackReasoningGeometry = true;
    reasoningPreview.updateReasoningPreview([
        'First thought',
        'Second thought still streaming',
        'Third thought',
        'Fourth thought arriving from below',
    ].join('\n'));
    await reasoningPreview.finishReasoningPreview();
    trackReasoningGeometry = false;

    const reasoningRowsAfterRollover = [];

    reasoningRow = reasoningPreview.get_first_child();
    while (reasoningRow) {
        reasoningRowsAfterRollover.push(reasoningRow);
        reasoningRow = reasoningRow.get_next_sibling();
    }

    assert(
        reasoningRowsAfterRollover.length === 3
            && reasoningRowsAfterRollover.every(
                (row, index) => row === reasoningRowsBeforeRollover[index],
            ),
        'A full reasoning ticker replaced its stable row widgets during rollover',
    );
    assert(
        reasoningPreview.getReasoningLineTransitionCount() === rolloverTransitionStart,
        'A full reasoning ticker animated a layout-affecting rollover',
    );
    assert(
        reasoningFrameHeights.length > 0
            && reasoningFrameHeights.every(({ allocated, minimum, natural }) => (
                allocated === baselineReasoningHeight
                    && minimum === baselineReasoningMinimum
                    && natural === baselineReasoningNatural
            )),
        `Reasoning rollover changed its layout footprint: ${JSON.stringify(reasoningFrameHeights)}`,
    );

    const burstTransitionStart = reasoningPreview.getReasoningLineTransitionCount();
    reasoningPreview.updateReasoningPreview([
        'First thought',
        'Second thought still streaming',
        'Third thought',
        'Fourth thought arriving from below',
        'Fifth thought',
        'Sixth thought',
        'Seventh thought',
    ].join('\n'));
    await reasoningPreview.finishReasoningPreview();
    const visibleReasoningLines = reasoningPreview.getReasoningPreviewLines();

    assert(
        visibleReasoningLines.length === 3
            && visibleReasoningLines.join('\n') === 'Fifth thought\nSixth thought\nSeventh thought',
        `Live reasoning ticker retained unexpected lines: ${JSON.stringify(visibleReasoningLines)}`,
    );
    assert(
        reasoningPreview.getReasoningLineTransitionCount() - burstTransitionStart <= 2,
        'Live reasoning queued every intermediate line transition during catch-up',
    );
    assert(
        reasoningPreview.getReasoningPreviewText().endsWith('Seventh thought'),
        'Reasoning text smoother did not reach its canonical target',
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
        !reasoningHeader.get_visible(),
        'Live reasoning displayed the completed reasoning header while streaming',
    );
    assert(
        reasoningRevealer.get_reveal_child(),
        'Live reasoning did not keep its body expanded while streaming',
    );
    assert(
        reasoningRevealer.get_transition_type() === Gtk.RevealerTransitionType.NONE,
        'Live reasoning retained a layout-affecting body transition',
    );
    reasoningExpander.clearPreview();
    assert(
        reasoningHeader.get_visible(),
        'Completed reasoning did not restore its expandable header',
    );
    assert(
        !reasoningRevealer.get_reveal_child(),
        'Completed reasoning kept the temporary loading preview expanded',
    );
    assert(
        reasoningRevealer.get_transition_type() === Gtk.RevealerTransitionType.SLIDE_DOWN,
        'Completed reasoning did not restore its normal expander transition',
    );
    expanderWindow.destroy();
}

print('Cusco stream animation smoke passed');
