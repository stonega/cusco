import {
    applyReferenceTextStyles,
} from '../src/chat/messageView.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const text = 'Use 🙂 @~/文件.pdf with $review and #git';
const fileToken = '@~/文件.pdf';
const expectedStart = new TextEncoder().encode(text.slice(0, text.indexOf(fileToken))).length;
const expectedEnd = expectedStart + new TextEncoder().encode(fileToken).length;
let attributes = null;
const fakeLabel = {
    get_text: () => text,
    set_attributes: (value) => {
        attributes = value;
    },
};

applyReferenceTextStyles(fakeLabel, [
    { kind: 'file', insertText: fileToken },
    { kind: 'skill', insertText: '$review' },
    { kind: 'command', insertText: '#git' },
], {
    file: { foreground: '#18794e', background: '#dcf4e3' },
    skill: { foreground: '#1c71d8', background: '#d8ecff' },
    command: { foreground: '#8f5e00', background: '#f8e5c2' },
});

assert(attributes, 'Reference text styles did not create Pango attributes');

const iterator = attributes.get_iterator();
let styledFileToken = false;

do {
    const [start, end] = iterator.range();

    if (start === expectedStart && end === expectedEnd && iterator.get_attrs().length >= 3)
        styledFileToken = true;
} while (iterator.next());

assert(styledFileToken, 'Unicode file reference did not receive the expected byte range');

print('Cusco message view smoke passed');
