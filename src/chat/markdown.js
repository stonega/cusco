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

function hasUnescapedTrailingPipe(text) {
    if (!text.endsWith('|'))
        return false;

    let backslashCount = 0;

    for (let index = text.length - 2; index >= 0 && text[index] === '\\'; index--)
        backslashCount++;

    return backslashCount % 2 === 0;
}

function splitTableRow(line) {
    let text = String(line ?? '').trim();

    if (!text.includes('|'))
        return null;

    if (text.startsWith('|'))
        text = text.slice(1);

    if (hasUnescapedTrailingPipe(text))
        text = text.slice(0, -1);

    const cells = [];
    let cell = '';

    for (let index = 0; index < text.length; index++) {
        const char = text[index];

        if (char === '\\' && text[index + 1] === '|') {
            cell += '|';
            index++;
            continue;
        }

        if (char === '|') {
            cells.push(cell.trim());
            cell = '';
            continue;
        }

        cell += char;
    }

    cells.push(cell.trim());

    if (cells.length < 2)
        return null;

    return cells;
}

function parseTableAlignment(cell) {
    const marker = cell.replace(/\s+/g, '');

    if (!/^:?-{3,}:?$/.test(marker))
        return null;

    if (marker.startsWith(':') && marker.endsWith(':'))
        return 'center';

    if (marker.endsWith(':'))
        return 'right';

    return 'left';
}

function parseTableSeparator(line) {
    const cells = splitTableRow(line);

    if (!cells)
        return null;

    const alignments = cells.map(parseTableAlignment);

    if (alignments.some((alignment) => alignment === null))
        return null;

    return alignments;
}

function normalizeTableCells(cells, columnCount) {
    const normalized = [];

    for (let index = 0; index < columnCount; index++)
        normalized.push(cells[index] ?? '');

    return normalized;
}

function parseMarkdownTable(lines, startIndex) {
    const headers = splitTableRow(lines[startIndex]);
    const alignments = parseTableSeparator(lines[startIndex + 1]);

    if (!headers || !alignments || headers.length !== alignments.length)
        return null;

    const rows = [];
    let index = startIndex + 2;

    while (index < lines.length) {
        const cells = splitTableRow(lines[index]);

        if (!cells)
            break;

        rows.push(normalizeTableCells(cells, headers.length));
        index++;
    }

    return {
        block: {
            type: 'table',
            headers: normalizeTableCells(headers, headers.length),
            alignments,
            rows,
        },
        nextIndex: index,
    };
}

function isMarkdownDivider(line) {
    return /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/.test(String(line ?? ''));
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

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
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
        else {
            const table = parseMarkdownTable(lines, index);

            if (table) {
                flushParagraph();
                blocks.push(table.block);
                index = table.nextIndex - 1;
                continue;
            }

            if (isMarkdownDivider(line)) {
                flushParagraph();
                blocks.push({ type: 'divider' });
                continue;
            }

            paragraphLines.push(line);
        }
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

function headingLineHeight(level) {
    if (level <= 1)
        return '1.05';

    if (level === 2)
        return '1.08';

    if (level === 3)
        return '1.12';

    return null;
}

function headingText(text) {
    return text.trim().replace(/\s+#+\s*$/, '').trimEnd();
}

function lineToPangoMarkup(line) {
    if (line.trim() === '')
        return '';

    const heading = line.match(/^(#{1,6})\s+(.+)$/);

    if (heading) {
        const level = heading[1].length;
        const lineHeight = headingLineHeight(level);
        const lineHeightAttribute = lineHeight ? ` line_height="${lineHeight}"` : '';

        return `<span weight="bold" size="${headingSize(level)}"${lineHeightAttribute}>${inlineMarkdownToPangoMarkup(headingText(heading[2]))}</span>`;
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
