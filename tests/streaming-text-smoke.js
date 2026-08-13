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
    const pending = new Map();

    return {
        cancel(id) {
            pending.delete(id);
        },
        drain(limit = 1000) {
            let count = 0;

            while (pending.size > 0 && count < limit) {
                const [id, callback] = pending.entries().next().value;
                pending.delete(id);
                callback();
                count++;
            }

            if (pending.size > 0)
                throw new Error('Streaming scheduler did not settle');
        },
        get size() {
            return pending.size;
        },
        schedule(_milliseconds, callback) {
            const id = nextId++;
            pending.set(id, callback);
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
    updates.every((entry) => streamRevealUnits(entry.state.addedText).length <= 1),
    'Normal streaming batched multiple reveal pieces into one update',
);

const placeholderScheduler = createScheduler();
const placeholder = new StreamingTextSmoother({
    initialText: ' ',
    schedule: placeholderScheduler.schedule,
    cancel: placeholderScheduler.cancel,
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
    onUpdate: (_text, state) => {
        replacementState = state;
    },
});
replacement.push('Draft response');
replacement.push('Authoritative answer');
assert(replacement.visibleText === 'Authoritative answer', 'Authoritative replacement was delayed');
assert(replacementState?.replace === true, 'Authoritative replacement was not identified');

const finishScheduler = createScheduler();
const finishUpdates = [];
const finishing = new StreamingTextSmoother({
    schedule: finishScheduler.schedule,
    cancel: finishScheduler.cancel,
    onUpdate: (_text, state) => finishUpdates.push(state),
});
finishing.push('One two three four five six seven eight nine ten');
const finishPromise = finishing.finish();
finishScheduler.drain();
await finishPromise;
assert(finishing.visibleText === finishing.targetText, 'Finishing did not drain the complete response');
assert(
    finishUpdates.every((state) => streamRevealUnits(state.addedText).length <= 1),
    'Finishing batched multiple reveal pieces into one update',
);

const disposeScheduler = createScheduler();
const disposable = new StreamingTextSmoother({
    schedule: disposeScheduler.schedule,
    cancel: disposeScheduler.cancel,
});
disposable.push('Pending content remains queued');
disposable.dispose();
assert(disposeScheduler.size === 0, 'Disposing left scheduled reveal sources behind');

const disposingFinishScheduler = createScheduler();
const disposingFinish = new StreamingTextSmoother({
    schedule: disposingFinishScheduler.schedule,
    cancel: disposingFinishScheduler.cancel,
});
disposingFinish.push('This response is still draining');
const disposedFinishPromise = disposingFinish.finish();
disposingFinish.dispose();
await disposedFinishPromise;
assert(disposingFinishScheduler.size === 0, 'Disposing did not settle an active finish');

print('Cusco streaming text smoke passed');
