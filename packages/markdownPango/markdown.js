import GLib from 'gi://GLib?version=2.0';

const UTF8_ENCODER = new TextEncoder();

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

function normalizeLinkTarget(target) {
    const value = String(target ?? '');

    if (!value.startsWith('/') || value.startsWith('//'))
        return value;

    try {
        return GLib.filename_to_uri(value, null);
    } catch {
        return value;
    }
}

function matchOpeningFence(line) {
    return String(line ?? '').match(/^```([\w#+.-]*)\s*$/);
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
        const openingFence = matchOpeningFence(line);

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

function streamingMarkdownState(markdown) {
    const source = String(markdown ?? '');
    let inCodeBlock = false;
    let inInlineCode = false;
    let boldOpen = false;
    let emphasisOpen = false;
    let lastOpenBracket = -1;
    let lastCloseBracket = -1;
    let lastLinkStart = -1;
    let lastLinkEnd = -1;
    let linkTargetHasContent = false;

    for (let lineStart = 0; lineStart <= source.length;) {
        const newlineIndex = source.indexOf('\n', lineStart);
        const lineEnd = newlineIndex < 0 ? source.length : newlineIndex;
        const line = source.slice(lineStart, lineEnd);

        if (!inCodeBlock && matchOpeningFence(line)) {
            inCodeBlock = true;
        } else if (inCodeBlock && line.trim() === '```') {
            inCodeBlock = false;
        } else if (!inCodeBlock) {
            let backslashRun = 0;

            for (let index = lineStart; index < lineEnd; index++) {
                const character = source[index];

                if (character === '\\') {
                    backslashRun++;
                    continue;
                }

                const escaped = backslashRun % 2 === 1;
                backslashRun = 0;

                if (character === '`' && !escaped) {
                    inInlineCode = !inInlineCode;
                    continue;
                }

                if (inInlineCode || escaped)
                    continue;

                if (character === '[')
                    lastOpenBracket = index;

                if (character === ']') {
                    lastCloseBracket = index;

                    if (source[index + 1] === '(' && lastOpenBracket >= 0) {
                        lastLinkStart = index;
                        linkTargetHasContent = false;
                    }
                } else if (character === ')') {
                    lastLinkEnd = index;
                } else if (lastLinkStart > lastLinkEnd
                    && index > lastLinkStart + 1
                    && !/\s/.test(character)) {
                    linkTargetHasContent = true;
                }

                if (character !== '*')
                    continue;

                if (source[index + 1] === '*') {
                    boldOpen = !boldOpen;
                    index++;
                    continue;
                }

                const previous = source[index - 1] ?? '';
                const next = source[index + 1] ?? '';

                if ((next && !/\s/.test(next)) || (previous && !/\s/.test(previous)))
                    emphasisOpen = !emphasisOpen;
            }
        }

        if (newlineIndex < 0)
            break;

        lineStart = newlineIndex + 1;
    }

    return {
        boldOpen,
        emphasisOpen,
        inCodeBlock,
        inInlineCode,
        incompleteBracket: lastOpenBracket > lastCloseBracket,
        incompleteLinkTarget: lastLinkStart > lastLinkEnd && !linkTargetHasContent,
        lastOpenBracket,
        linkOpen: lastLinkStart > lastLinkEnd && linkTargetHasContent,
    };
}

export function stabilizeStreamingMarkdown(markdown) {
    const source = String(markdown ?? '');
    const state = streamingMarkdownState(source);
    const hideIncompleteBlockPrefix = (candidate) => {
        const lineStart = candidate.lastIndexOf('\n') + 1;
        const line = candidate.slice(lineStart);
        const isBareBlockPrefix = /^ {0,3}(?:#{1,6}|>|[-+*]|\d+\.?)\s*$/u.test(line);
        const isBareTaskPrefix = /^ {0,3}[-+*]\s+\[[ xX]?\]?\s*$/u.test(line);

        return isBareBlockPrefix || isBareTaskPrefix
            ? candidate.slice(0, lineStart)
            : candidate;
    };

    // The block parser already renders an unfinished fence as a code block.
    if (state.inCodeBlock)
        return source;

    if (state.inInlineCode) {
        if (source.endsWith('`'))
            return source.slice(0, -1);

        return `${source}\``;
    }

    if (state.incompleteBracket || state.incompleteLinkTarget)
        return hideIncompleteBlockPrefix(source.slice(0, state.lastOpenBracket));

    if (state.linkOpen)
        return `${source})`;

    if (state.boldOpen) {
        if (source.endsWith('**'))
            return hideIncompleteBlockPrefix(source.slice(0, -2));

        if (source.endsWith('*') && !source.endsWith('**'))
            return `${source.slice(0, -1)}**`;

        return `${source}**`;
    }

    if (state.emphasisOpen) {
        if (source.endsWith('*'))
            return source.slice(0, -1);

        return `${source}*`;
    }

    if (source.endsWith('*'))
        return source.slice(0, -1);

    return hideIncompleteBlockPrefix(source);
}

export function inlineMarkdownToPangoMarkup(text) {
    return inlineMarkdownToPangoRenderModel(text).markup;
}

function utf8Length(value) {
    return UTF8_ENCODER.encode(String(value ?? '')).length;
}

function emptyRenderModel() {
    return {
        markup: '',
        plainText: '',
        excludedAnimationRanges: [],
    };
}

function appendRenderModel(target, source) {
    const offset = utf8Length(target.plainText);
    target.markup += source.markup;
    target.plainText += source.plainText;

    for (const range of source.excludedAnimationRanges ?? []) {
        target.excludedAnimationRanges.push({
            start: offset + range.start,
            end: offset + range.end,
        });
    }

    return target;
}

function literalRenderModel(value, markup = null) {
    const text = String(value ?? '');

    return {
        markup: markup ?? escapeMarkup(text),
        plainText: text,
        excludedAnimationRanges: [],
    };
}

function wrappedInlineRenderModel(text, index, delimiter, openTag, closeTag, options = {}) {
    const closeIndex = text.indexOf(delimiter, index + delimiter.length);

    if (closeIndex < 0)
        return null;

    const inner = text.slice(index + delimiter.length, closeIndex);

    if (!inner)
        return null;

    const innerModel = inlineMarkdownToPangoRenderModel(inner);
    const excludedAnimationRanges = [...innerModel.excludedAnimationRanges];

    if (options.excludeAnimation && innerModel.plainText) {
        excludedAnimationRanges.push({
            start: 0,
            end: utf8Length(innerModel.plainText),
        });
    }

    return {
        model: {
            markup: `${openTag}${innerModel.markup}${closeTag}`,
            plainText: innerModel.plainText,
            excludedAnimationRanges,
        },
        nextIndex: closeIndex + delimiter.length,
    };
}

function linkInlineRenderModel(text, index) {
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

    const labelModel = inlineMarkdownToPangoRenderModel(label);

    return {
        model: {
            ...labelModel,
            markup: `<a href="${escapeMarkup(normalizeLinkTarget(url))}">${labelModel.markup}</a>`,
        },
        nextIndex: urlEnd + 1,
    };
}

export function inlineMarkdownToPangoRenderModel(text) {
    const source = String(text ?? '');
    const model = emptyRenderModel();
    let index = 0;

    while (index < source.length) {
        const char = String.fromCodePoint(source.codePointAt(index));
        let consumed = null;

        if (source.startsWith('**', index)) {
            consumed = wrappedInlineRenderModel(source, index, '**', '<b>', '</b>');
        } else if (char === '`') {
            consumed = wrappedInlineRenderModel(source, index, '`', '<tt>', '</tt>', {
                excludeAnimation: true,
            });
        } else if (char === '*') {
            consumed = wrappedInlineRenderModel(source, index, '*', '<i>', '</i>');
        } else if (char === '[') {
            consumed = linkInlineRenderModel(source, index);
        }

        if (consumed) {
            appendRenderModel(model, consumed.model);
            index = consumed.nextIndex;
            continue;
        }

        appendRenderModel(model, literalRenderModel(char));
        index += char.length;
    }

    return model;
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

function wrapRenderModel(model, openTag, closeTag) {
    return {
        ...model,
        markup: `${openTag}${model.markup}${closeTag}`,
    };
}

function prefixedRenderModel(prefix, model) {
    const result = literalRenderModel(prefix);
    appendRenderModel(result, model);
    return result;
}

function lineToPangoRenderModel(line) {
    if (line.trim() === '')
        return emptyRenderModel();

    const heading = line.match(/^(#{1,6})\s+(.+)$/);

    if (heading) {
        const level = heading[1].length;
        const lineHeight = headingLineHeight(level);
        const lineHeightAttribute = lineHeight ? ` line_height="${lineHeight}"` : '';
        return wrapRenderModel(
            inlineMarkdownToPangoRenderModel(headingText(heading[2])),
            `<span weight="bold" size="${headingSize(level)}"${lineHeightAttribute}>`,
            '</span>',
        );
    }

    const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\](?:\s+(.*))?$/);

    if (task) {
        const marker = task[2].toLowerCase() === 'x' ? '☑' : '☐';
        return prefixedRenderModel(
            `${task[1]}${marker} `,
            inlineMarkdownToPangoRenderModel(task[3] ?? ''),
        );
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);

    if (bullet)
        return prefixedRenderModel('• ', inlineMarkdownToPangoRenderModel(bullet[1]));

    const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);

    if (numbered)
        return prefixedRenderModel(`${numbered[1]}. `, inlineMarkdownToPangoRenderModel(numbered[2]));

    const quote = line.match(/^\s*>\s+(.+)$/);

    if (quote)
        return wrapRenderModel(prefixedRenderModel('› ', inlineMarkdownToPangoRenderModel(quote[1])), '<i>', '</i>');

    return inlineMarkdownToPangoRenderModel(line);
}

export function markdownToPangoRenderModel(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
    const model = emptyRenderModel();

    lines.forEach((line, index) => {
        if (index > 0)
            appendRenderModel(model, literalRenderModel('\n', '\n'));

        appendRenderModel(model, lineToPangoRenderModel(line));
    });

    return model;
}

export function markdownToPangoMarkup(markdown) {
    return markdownToPangoRenderModel(markdown).markup;
}
