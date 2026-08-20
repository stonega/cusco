import {
    normalizeStreamAnimationStyle,
    StreamingTextSmoother,
    streamRevealUnits,
} from '../src/chat/streamingText.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function createScheduler() {
    let nextId = 1;
    let currentTime = 0;
    const pending = new Map();

    const nextPending = () => Array.from(pending.entries()).sort(
        ([firstId, first], [secondId, second]) => (
            first.dueAt - second.dueAt || firstId - secondId
        ),
    )[0] ?? null;

    return {
        cancel(id) {
            pending.delete(id);
        },
        drain(limit = 1000) {
            let count = 0;

            while (pending.size > 0 && count < limit) {
                const [id, scheduled] = nextPending();
                pending.delete(id);
                currentTime = scheduled.dueAt;
                scheduled.callback();
                count++;
            }

            if (pending.size > 0)
                throw new Error('Streaming scheduler did not settle');

            return count;
        },
        now: () => currentTime,
        get size() {
            return pending.size;
        },
        get time() {
            return currentTime;
        },
        schedule(milliseconds, callback) {
            const id = nextId++;
            pending.set(id, {
                callback,
                dueAt: currentTime + Math.max(0, Number(milliseconds) || 0),
            });
            return id;
        },
    };
}

const multilingualUnits = streamRevealUnits('Hello world 中文🙂');
assert(multilingualUnits.join('') === 'Hello world 中文🙂', 'Reveal segmentation changed text');
assert(multilingualUnits.length >= 5, 'Reveal segmentation did not separate multilingual text');
assert(normalizeStreamAnimationStyle('slideUp') === 'slideUp', 'Valid animation style was rejected');
assert(normalizeStreamAnimationStyle('unknown') === 'blurIn', 'Unknown animation style did not fall back');

assert(
    JSON.stringify(streamRevealUnits('**bold** text'))
        === JSON.stringify(['**', 'bold', '** ', 'text']),
    'Markdown delimiters were split into visibly unstable reveal pieces',
);
assert(
    JSON.stringify(streamRevealUnits('**bold** text', {
        wordSegmenter: null,
        graphemeSegmenter: null,
    })) === JSON.stringify(['**', 'bold', '** ', 'text']),
    'Fallback reveal segmentation split Markdown delimiters',
);
const coarseWordSegmenter = {
    segment(value) {
        return [{ segment: value }];
    },
};
assert(
    JSON.stringify(streamRevealUnits('**bold** text', {
        wordSegmenter: coarseWordSegmenter,
    })) === JSON.stringify(['**', 'bold', '** ', 'text']),
    'Coarse runtime segmentation split Markdown delimiters',
);
assert(
    streamRevealUnits('[link](https://example.com)').includes(']('),
    'Markdown link transition was split between its label and target opener',
);
assert(
    streamRevealUnits('[link](https://example.com)', {
        wordSegmenter: coarseWordSegmenter,
    }).includes(']('),
    'Coarse runtime segmentation split a Markdown link transition',
);

const scheduler = createScheduler();
const updates = [];
const smoother = new StreamingTextSmoother({
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    now: scheduler.now,
    onUpdate: (text, state) => updates.push({ text, state }),
});

const smoothTarget = 'Hello world from Cusco with one visible piece on every normal tick';
smoother.push(smoothTarget);
assert(smoother.visibleText === 'Hello ', 'First reveal unit was not immediate');
assert(smoother.visibleText !== smoother.targetText, 'Burst response was not smoothed');
scheduler.drain();
assert(smoother.visibleText === smoothTarget, 'Idle reveal did not reach the target');
assert(updates.every((entry) => entry.text.endsWith(entry.state.addedText)), 'Reveal update metadata is inconsistent');
assert(
    updates.some((entry) => entry.state.revealUnitCount > 1),
    'A buffered response did not accelerate into phrase-sized reveal batches',
);
assert(
    updates.every((entry) => entry.state.revealUnitCount <= 24),
    'Normal catch-up exceeded the configured reveal batch limit',
);

const pacedScheduler = createScheduler();
const pacedUpdates = [];
const paced = new StreamingTextSmoother({
    schedule: pacedScheduler.schedule,
    cancel: pacedScheduler.cancel,
    now: pacedScheduler.now,
    onUpdate: (_text, state) => pacedUpdates.push(state),
});
let pacedTarget = '';

for (const word of ['A', 'small', 'queue', 'keeps', 'natural', 'pacing']) {
    pacedTarget += `${word} `;
    paced.push(pacedTarget);
    pacedScheduler.drain();
}

assert(paced.visibleText === pacedTarget, 'Naturally paced stream did not reach its target');
assert(
    pacedUpdates.every((state) => state.revealUnitCount === 1),
    'A small provider queue stopped revealing one unit at a time',
);

const placeholderScheduler = createScheduler();
const placeholder = new StreamingTextSmoother({
    initialText: ' ',
    schedule: placeholderScheduler.schedule,
    cancel: placeholderScheduler.cancel,
    now: placeholderScheduler.now,
});
placeholder.push('First streamed words');
assert(placeholder.visibleText !== 'First streamed words', 'Initial placeholder caused an immediate replacement');
placeholderScheduler.drain();
assert(placeholder.visibleText === 'First streamed words', 'Initial placeholder reveal did not finish');

const replacementScheduler = createScheduler();
let replacementState = null;
const replacement = new StreamingTextSmoother({
    schedule: replacementScheduler.schedule,
    cancel: replacementScheduler.cancel,
    now: replacementScheduler.now,
    onUpdate: (_text, state) => {
        replacementState = state;
    },
});
replacement.push('Draft response');
replacement.push('Authoritative answer');
assert(
    replacement.visibleText === 'Authoritative ',
    'Authoritative replacement did not reveal one corrected unit immediately',
);
assert(
    replacement.visibleText !== replacement.targetText,
    'Authoritative replacement flushed the complete response',
);
assert(replacementState?.replace === true, 'Authoritative replacement was not identified');
replacementScheduler.drain();
assert(
    replacement.visibleText === replacement.targetText,
    'Authoritative replacement did not finish revealing',
);

const queuedCorrectionScheduler = createScheduler();
const queuedCorrectionUpdates = [];
const queuedCorrection = new StreamingTextSmoother({
    schedule: queuedCorrectionScheduler.schedule,
    cancel: queuedCorrectionScheduler.cancel,
    now: queuedCorrectionScheduler.now,
    onUpdate: (text, state) => queuedCorrectionUpdates.push({ text, state }),
});
queuedCorrection.push('Shared introduction followed by a draft response tail');
const visibleCorrectionPrefix = queuedCorrection.visibleText;
queuedCorrection.push('Shared introduction followed by the authoritative response tail');
assert(
    queuedCorrection.visibleText === visibleCorrectionPrefix,
    'Correcting an unseen queued suffix changed already visible text',
);
assert(
    queuedCorrection.visibleText !== queuedCorrection.targetText,
    'Correcting an unseen queued suffix skipped the remaining reveal',
);
queuedCorrectionScheduler.drain();
assert(
    queuedCorrection.visibleText === queuedCorrection.targetText,
    'Corrected queued content did not finish revealing',
);
assert(
    queuedCorrectionUpdates.every((entry) => (
        entry.state.revealUnitCount <= 24
    )),
    'Corrected queued content exceeded the reveal batch limit',
);

const quotedCjkScheduler = createScheduler();
const quotedCjk = new StreamingTextSmoother({
    schedule: quotedCjkScheduler.schedule,
    cancel: quotedCjkScheduler.cancel,
    now: quotedCjkScheduler.now,
});
const quotedCjkPrefix = '2020《信条》（Tenet）：围绕';

quotedCjk.push(`${quotedCjkPrefix}“时间逆转”`);
quotedCjkScheduler.drain();
quotedCjk.push(`${quotedCjkPrefix}"时间逆转"的谍战科幻\n2023《奥本海默》`);
assert(
    quotedCjk.visibleText === `${quotedCjkPrefix}"`,
    'Revising a streamed Chinese quote revealed more than one corrected unit',
);
assert(
    quotedCjk.visibleText !== quotedCjk.targetText,
    'Revising a streamed Chinese quote flushed the remaining response',
);
quotedCjkScheduler.drain();
assert(
    quotedCjk.visibleText === quotedCjk.targetText,
    'Quoted Chinese content did not finish its paced reveal',
);

const finishScheduler = createScheduler();
const finishUpdates = [];
const finishing = new StreamingTextSmoother({
    schedule: finishScheduler.schedule,
    cancel: finishScheduler.cancel,
    now: finishScheduler.now,
    onUpdate: (_text, state) => finishUpdates.push(state),
});
finishing.push('One two three four five six seven eight nine ten');
const finishPromise = finishing.finish();
const finishStartedAt = finishScheduler.time;
finishScheduler.drain();
await finishPromise;
assert(finishing.visibleText === finishing.targetText, 'Finishing did not drain the complete response');
assert(
    finishUpdates.some((state) => state.revealUnitCount > 1),
    'Finishing did not accelerate the remaining reveal queue',
);
assert(
    finishScheduler.time - finishStartedAt <= 180,
    'Finishing exceeded the adaptive drain deadline',
);
assert(
    finishUpdates.at(-1)?.animationPressure === 1,
    'Finishing did not shorten the decorative tail animation',
);

const burstScheduler = createScheduler();
const burstUpdates = [];
const burst = new StreamingTextSmoother({
    schedule: burstScheduler.schedule,
    cancel: burstScheduler.cancel,
    now: burstScheduler.now,
    finishDrainMs: 160,
    maxBatchUnits: 16,
    onUpdate: (_text, state) => burstUpdates.push(state),
});
const burstTarget = Array.from({ length: 500 }, (_value, index) => `word${index}`).join(' ');

burst.push(burstTarget);
const burstFinishStartedAt = burstScheduler.time;
const burstFinishPromise = burst.finish();

burstScheduler.drain();
await burstFinishPromise;
assert(burst.visibleText === burstTarget, 'Large completion burst did not reveal canonical text');
assert(
    burstScheduler.time - burstFinishStartedAt <= 160,
    'Large completion burst exceeded its hard drain budget',
);
assert(
    burstUpdates.some((state) => state.revealUnitCount > 16),
    'Large completion burst did not fast-forward its unanimated prefix',
);
assert(
    burstUpdates.filter((state) => state.revealUnitCount > 16).every((state) => (
        state.animationPressure === 1 && state.maximumAnimatedUnits <= 4
    )),
    'Fast-forwarded updates did not restrict animation to the final tail',
);

const flushScheduler = createScheduler();
let flushState = null;
const flushable = new StreamingTextSmoother({
    schedule: flushScheduler.schedule,
    cancel: flushScheduler.cancel,
    now: flushScheduler.now,
    onUpdate: (_text, state) => {
        flushState = state;
    },
});

flushable.push('Flush this buffered response without decorative delay');
flushable.flush();
assert(flushable.visibleText === flushable.targetText, 'Flush did not reveal canonical text');
assert(
    flushState?.animate === false && flushState.maximumAnimatedUnits === 0,
    'Flush did not suppress decorative streaming animation',
);

const disposeScheduler = createScheduler();
const disposable = new StreamingTextSmoother({
    schedule: disposeScheduler.schedule,
    cancel: disposeScheduler.cancel,
    now: disposeScheduler.now,
});
disposable.push('Pending content remains queued');
disposable.dispose();
assert(disposeScheduler.size === 0, 'Disposing left scheduled reveal sources behind');

const disposingFinishScheduler = createScheduler();
const disposingFinish = new StreamingTextSmoother({
    schedule: disposingFinishScheduler.schedule,
    cancel: disposingFinishScheduler.cancel,
    now: disposingFinishScheduler.now,
});
disposingFinish.push('This response is still draining');
const disposedFinishPromise = disposingFinish.finish();
disposingFinish.dispose();
await disposedFinishPromise;
assert(disposingFinishScheduler.size === 0, 'Disposing did not settle an active finish');

print('Cusco streaming text smoke passed');
