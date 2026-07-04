import GLib from 'gi://GLib?version=2.0';

function escapeMarkup(value) {
    return GLib.markup_escape_text(String(value ?? ''), -1);
}

function trimBlankLines(lines) {
    let start = 0;
    let end = lines.length;

    while (start < end && lines[start].trim() === '')
        start++;

    while (end > start && lines[end - 1].trim() === '')
        end--;

    return lines.slice(start, end);
}

function consumeWrapped(text, index, delimiter, openTag, closeTag) {
    const closeIndex = text.indexOf(delimiter, index + delimiter.length);

    if (closeIndex < 0)
        return null;

    const inner = text.slice(index + delimiter.length, closeIndex);

    if (!inner)
        return null;

    return {
        markup: `${openTag}${inlineMarkdownToPangoMarkup(inner)}${closeTag}`,
        nextIndex: closeIndex + delimiter.length,
    };
}

function consumeLink(text, index) {
    const labelEnd = text.indexOf(']', index + 1);

    if (labelEnd < 0 || text[labelEnd + 1] !== '(')
        return null;

    const urlEnd = text.indexOf(')', labelEnd + 2);

    if (urlEnd < 0)
        return null;

    const label = text.slice(index + 1, labelEnd);
    const url = text.slice(labelEnd + 2, urlEnd);

    if (!label || !url)
        return null;

    return {
        markup: `<a href="${escapeMarkup(url)}">${inlineMarkdownToPangoMarkup(label)}</a>`,
        nextIndex: urlEnd + 1,
    };
}

export function parseMarkdownBlocks(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let paragraphLines = [];
    let codeLines = [];
    let codeLanguage = '';
    let inCodeBlock = false;

    const flushParagraph = () => {
        const trimmedLines = trimBlankLines(paragraphLines);

        if (trimmedLines.length > 0)
            blocks.push({ type: 'markdown', content: trimmedLines.join('\n') });

        paragraphLines = [];
    };

    for (const line of lines) {
        const openingFence = line.match(/^```([\w#+.-]*)\s*$/);

        if (openingFence && !inCodeBlock) {
            flushParagraph();
            inCodeBlock = true;
            codeLanguage = openingFence[1] ?? '';
            codeLines = [];
            continue;
        }

        if (inCodeBlock && line.trim() === '```') {
            blocks.push({
                type: 'code',
                language: codeLanguage,
                content: codeLines.join('\n'),
            });
            inCodeBlock = false;
            codeLanguage = '';
            codeLines = [];
            continue;
        }

        if (inCodeBlock)
            codeLines.push(line);
        else
            paragraphLines.push(line);
    }

    if (inCodeBlock) {
        blocks.push({
            type: 'code',
            language: codeLanguage,
            content: codeLines.join('\n'),
        });
    } else {
        flushParagraph();
    }

    if (blocks.length === 0)
        blocks.push({ type: 'markdown', content: '' });

    return blocks;
}

export function inlineMarkdownToPangoMarkup(text) {
    let markup = '';
    let index = 0;

    while (index < text.length) {
        const char = String.fromCodePoint(text.codePointAt(index));

        if (text.startsWith('**', index)) {
            const consumed = consumeWrapped(text, index, '**', '<b>', '</b>');

            if (consumed) {
                markup += consumed.markup;
                index = consumed.nextIndex;
                continue;
            }
        }

        if (char === '`') {
            const consumed = consumeWrapped(text, index, '`', '<tt>', '</tt>');

            if (consumed) {
                markup += consumed.markup;
                index = consumed.nextIndex;
                continue;
            }
        }

        if (char === '*') {
            const consumed = consumeWrapped(text, index, '*', '<i>', '</i>');

            if (consumed) {
                markup += consumed.markup;
                index = consumed.nextIndex;
                continue;
            }
        }

        if (char === '[') {
            const consumed = consumeLink(text, index);

            if (consumed) {
                markup += consumed.markup;
                index = consumed.nextIndex;
                continue;
            }
        }

        markup += escapeMarkup(char);
        index += char.length;
    }

    return markup;
}

function headingSize(level) {
    if (level <= 1)
        return 'xx-large';

    if (level === 2)
        return 'x-large';

    if (level === 3)
        return 'large';

    return 'medium';
}

function headingText(text) {
    return text.trim().replace(/\s+#+\s*$/, '').trimEnd();
}

function lineToPangoMarkup(line) {
    if (line.trim() === '')
        return '';

    const heading = line.match(/^(#{1,6})\s+(.+)$/);

    if (heading) {
        return `<span weight="bold" size="${headingSize(heading[1].length)}">${inlineMarkdownToPangoMarkup(headingText(heading[2]))}</span>`;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);

    if (bullet)
        return `• ${inlineMarkdownToPangoMarkup(bullet[1])}`;

    const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);

    if (numbered)
        return `${escapeMarkup(numbered[1])}. ${inlineMarkdownToPangoMarkup(numbered[2])}`;

    const quote = line.match(/^\s*>\s+(.+)$/);

    if (quote)
        return `<i>› ${inlineMarkdownToPangoMarkup(quote[1])}</i>`;

    return inlineMarkdownToPangoMarkup(line);
}

export function markdownToPangoMarkup(markdown) {
    return String(markdown ?? '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(lineToPangoMarkup)
        .join('\n');
}
