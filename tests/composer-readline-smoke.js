import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    buildComposerHistoryEntries,
    composerHistoryDirection,
    composerReadlineAction,
    planComposerReadlineEdit,
} from '../src/composer/readline.js';
import { CuscoWindow } from '../src/window.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function applyPlan(text, cursorOffset, action, {
    selectionBoundOffset = cursorOffset,
    yankText = '',
} = {}) {
    const plan = planComposerReadlineEdit(
        text,
        cursorOffset,
        selectionBoundOffset,
        action,
        yankText,
    );

    assert(plan, `Readline action ${action} did not produce an edit plan`);

    if (!plan.edit) {
        return {
            text,
            cursorOffset: plan.cursorOffset,
            killedText: plan.killedText,
        };
    }

    const characters = [...text];
    const replacement = [...plan.edit.replacement];
    const nextCharacters = [
        ...characters.slice(0, plan.edit.startOffset),
        ...replacement,
        ...characters.slice(plan.edit.endOffset),
    ];

    return {
        text: nextCharacters.join(''),
        cursorOffset: plan.cursorOffset,
        killedText: plan.killedText,
    };
}

const control = Gdk.ModifierType.CONTROL_MASK;
const alt = Gdk.ModifierType.ALT_MASK;

assert(
    composerReadlineAction(Gdk.KEY_a, control) === 'beginning-of-line'
    && composerReadlineAction(Gdk.KEY_F, alt) === 'forward-word'
    && composerReadlineAction(Gdk.KEY_BackSpace, alt) === 'backward-kill-word',
    'Readline modifier chords were not recognized',
);
assert(
    composerReadlineAction(Gdk.KEY_a, 0) === null
    && composerReadlineAction(Gdk.KEY_a, control | alt) === null
    && composerReadlineAction(Gdk.KEY_q, control) === null,
    'Readline handling captured an unrelated key chord',
);

assert(
    composerHistoryDirection(Gdk.KEY_Up, 0, 'one line', 4) === -1
    && composerHistoryDirection(Gdk.KEY_Down, 0, 'one line', 4) === 1
    && composerHistoryDirection(Gdk.KEY_Up, 0, 'first\nsecond', 8) === 0
    && composerHistoryDirection(Gdk.KEY_Down, 0, 'first\nsecond', 2) === 0
    && composerHistoryDirection(Gdk.KEY_Up, control, 'one line', 4) === 0
    && composerHistoryDirection(Gdk.KEY_Up, 0, 'one line', 4, 2) === 0,
    'History navigation did not respect multiline, modifier, or selection boundaries',
);

const historyEntries = buildComposerHistoryEntries([
    { role: 'assistant', content: 'Ignore this' },
    { role: 'user', content: 'First input' },
    {
        role: 'user',
        content: 'Formatted input\n\nAttachment summary',
        metadata: {
            composerText: 'Second input',
            composerReferences: [{ kind: 'file', value: '/tmp/file' }],
        },
    },
], [
    { content: 'Queued input', references: [{ kind: 'skill', value: 'review' }] },
]);
assert(
    historyEntries.map((entry) => entry.text).join('|')
        === 'First input|Second input|Queued input'
    && historyEntries[1].references[0].value === '/tmp/file'
    && historyEntries[2].references[0].value === 'review',
    'Composer history did not preserve raw prompts, queued inputs, or references',
);

const multiline = 'short\nβ🙂 gamma\nlast';
assert(
    applyPlan(multiline, 9, 'beginning-of-line').cursorOffset === 6
    && applyPlan(multiline, 9, 'end-of-line').cursorOffset === 14,
    'Beginning/end-of-line did not respect logical line boundaries',
);
assert(
    applyPlan(multiline, 9, 'previous-line').cursorOffset === 3
    && applyPlan(multiline, 9, 'next-line').cursorOffset === 18,
    'Previous/next-line did not preserve the logical character column',
);
assert(
    applyPlan('one, two', 8, 'backward-word').cursorOffset === 5
    && applyPlan('one, two', 3, 'forward-word').cursorOffset === 8,
    'Readline word movement did not follow Unicode word boundaries',
);

let result = applyPlan('A🙂B', 2, 'backward-delete-character');
assert(
    result.text === 'AB' && result.cursorOffset === 1,
    'Backward deletion split or skipped a Unicode character',
);
result = applyPlan('A🙂B', 1, 'delete-character');
assert(
    result.text === 'AB' && result.cursorOffset === 1,
    'Forward deletion split or skipped a Unicode character',
);

result = applyPlan('alpha\nbeta', 2, 'kill-line');
assert(
    result.text === 'al\nbeta' && result.killedText === 'pha',
    'Kill-line did not retain the deleted line suffix',
);
result = applyPlan('alpha\nbeta', 5, 'kill-line');
assert(
    result.text === 'alphabeta' && result.killedText === '\n',
    'Kill-line at end of line did not join the following line',
);
result = applyPlan('alpha\nbeta', 9, 'backward-kill-line');
assert(
    result.text === 'alpha\na' && result.killedText === 'bet',
    'Backward kill-line did not retain the deleted line prefix',
);

result = applyPlan('run foo/bar  ', 13, 'unix-word-rubout');
assert(
    result.text === 'run ' && result.killedText === 'foo/bar  ',
    'Unix word rubout did not erase through the preceding whitespace boundary',
);
result = applyPlan('foo/bar', 7, 'backward-kill-word');
assert(
    result.text === 'foo/' && result.killedText === 'bar',
    'Backward kill-word did not use word-character boundaries',
);
result = applyPlan('foo /bar baz', 3, 'kill-word');
assert(
    result.text === 'foo baz' && result.killedText === ' /bar',
    'Kill-word did not include separators leading to the next word',
);

result = applyPlan('say now', 4, 'yank', {
    selectionBoundOffset: 7,
    yankText: 'hello 🙂',
});
assert(
    result.text === 'say hello 🙂' && result.cursorOffset === 11,
    'Yank did not replace the selection or preserve Unicode offsets',
);
result = applyPlan('a🙂b', 2, 'transpose-characters');
assert(
    result.text === 'ab🙂' && result.cursorOffset === 3,
    'Transpose-characters did not swap adjacent Unicode characters',
);
result = applyPlan('abc', 3, 'transpose-characters');
assert(
    result.text === 'acb' && result.cursorOffset === 3,
    'Transpose-characters at end of line did not swap the preceding pair',
);

const buffer = new Gtk.TextBuffer();
buffer.set_text('alpha beta', -1);
buffer.place_cursor(buffer.get_iter_at_offset(6));
const fakeWindow = {
    _composerBuffer: buffer,
    _composerReadlineKillText: '',
    _deleteComposerReferenceAtCursor: () => false,
    _getComposerText() {
        const [start, end] = buffer.get_bounds();
        return buffer.get_text(start, end, true);
    },
};

assert(
    CuscoWindow.prototype._handleComposerReadlineKey.call(
        fakeWindow,
        Gdk.KEY_k,
        control,
    ),
    'The composer did not handle a recognized Readline chord',
);
assert(
    fakeWindow._getComposerText() === 'alpha '
    && fakeWindow._composerReadlineKillText === 'beta',
    'The composer did not apply kill-line to its Gtk.TextBuffer',
);
CuscoWindow.prototype._handleComposerReadlineKey.call(
    fakeWindow,
    Gdk.KEY_y,
    control,
);
assert(
    fakeWindow._getComposerText() === 'alpha beta',
    'The composer did not yank killed text back into its Gtk.TextBuffer',
);

const historyBuffer = new Gtk.TextBuffer();
historyBuffer.set_text('draft', -1);
historyBuffer.place_cursor(historyBuffer.get_end_iter());
const historyConversation = {
    id: 'conversation-1',
    messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'second' },
    ],
};
const historyWindow = {
    _activeQuestionSessionsByConversation: new Map(),
    _composerBuffer: historyBuffer,
    _composerHistory: null,
    _composerReferences: [],
    _conversations: { activeConversation: historyConversation },
    _getPendingUserMessages: () => [{ content: 'queued', references: [] }],
    _getComposerText() {
        const [start, end] = historyBuffer.get_bounds();
        return historyBuffer.get_text(start, end, true);
    },
    _getComposerReferences() {
        return this._composerReferences.map((reference) => ({ ...reference }));
    },
    _setComposerText(text, { preserveHistory = false } = {}) {
        if (!preserveHistory)
            this._composerHistory = null;
        historyBuffer.set_text(text, -1);
        historyBuffer.place_cursor(historyBuffer.get_end_iter());
    },
    _activeQuestionSessionForConversation: CuscoWindow.prototype._activeQuestionSessionForConversation,
    _handleComposerHistoryKey: CuscoWindow.prototype._handleComposerHistoryKey,
    _navigateComposerHistory: CuscoWindow.prototype._navigateComposerHistory,
};

for (const expected of ['queued', 'second']) {
    assert(
        historyWindow._handleComposerHistoryKey(Gdk.KEY_Up, 0)
        && historyWindow._getComposerText() === expected,
        `Up did not recall composer history entry: ${expected}`,
    );
}
historyBuffer.set_text('edited second', -1);
historyBuffer.place_cursor(historyBuffer.get_end_iter());
assert(
    historyWindow._handleComposerHistoryKey(Gdk.KEY_Down, 0)
    && historyWindow._getComposerText() === 'queued',
    'Down did not advance through composer history',
);
assert(
    historyWindow._handleComposerHistoryKey(Gdk.KEY_Up, 0)
    && historyWindow._getComposerText() === 'edited second',
    'Composer history did not retain an edited recalled entry',
);
historyWindow._handleComposerHistoryKey(Gdk.KEY_Down, 0);
historyWindow._handleComposerHistoryKey(Gdk.KEY_Down, 0);
assert(
    historyWindow._getComposerText() === 'draft',
    'Moving past the newest composer history entry did not restore the draft',
);

print('Cusco composer Readline smoke passed');
