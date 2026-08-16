export const COMPOSER_REFERENCE_STYLES = {
    light: {
        skill: { background: '#c5e1f8', foreground: '#1c71d8' },
        file: { background: '#c8ead1', foreground: '#18794e' },
        command: { background: '#f0d5a0', foreground: '#8f5e00' },
        artifact: { background: '#ddd2f5', foreground: '#613583' },
    },
    dark: {
        skill: { background: '#234a68', foreground: '#99c1f1' },
        file: { background: '#204b37', foreground: '#8ff0a4' },
        command: { background: '#533f1b', foreground: '#f8e45c' },
        artifact: { background: '#3d2f57', foreground: '#dc8add' },
    },
};

export function composerReferenceKindForTrigger(trigger) {
    return {
        '$': 'skill',
        '@': 'file',
        '#': 'command',
    }[trigger] ?? '';
}

function textBufferOffsetForStringIndex(text, index) {
    return [...String(text ?? '').slice(0, index)].length;
}

export function composerReferenceRanges(text, references) {
    const ranges = [];

    for (const reference of references) {
        const token = String(reference?.insertText ?? '');

        if (!token)
            continue;

        let index = text.indexOf(token);

        while (index >= 0) {
            ranges.push({
                reference,
                startOffset: textBufferOffsetForStringIndex(text, index),
                endOffset: textBufferOffsetForStringIndex(text, index + token.length),
            });
            index = text.indexOf(token, index + token.length);
        }
    }

    return ranges;
}

export function normalizeComposerReferences(references) {
    return Array.isArray(references)
        ? references.map((reference) => ({
            kind: String(reference?.kind ?? ''),
            value: String(reference?.value ?? ''),
            title: String(reference?.title ?? ''),
            insertText: String(reference?.insertText ?? ''),
        })).filter((reference) => reference.kind && reference.value && reference.insertText)
        : [];
}
