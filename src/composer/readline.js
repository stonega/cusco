import Gdk from 'gi://Gdk?version=4.0';

const CONTROL_ACTIONS = new Map([
    [Gdk.KEY_a, 'beginning-of-line'],
    [Gdk.KEY_b, 'backward-character'],
    [Gdk.KEY_d, 'delete-character'],
    [Gdk.KEY_e, 'end-of-line'],
    [Gdk.KEY_f, 'forward-character'],
    [Gdk.KEY_h, 'backward-delete-character'],
    [Gdk.KEY_k, 'kill-line'],
    [Gdk.KEY_n, 'next-line'],
    [Gdk.KEY_p, 'previous-line'],
    [Gdk.KEY_t, 'transpose-characters'],
    [Gdk.KEY_u, 'backward-kill-line'],
    [Gdk.KEY_w, 'unix-word-rubout'],
    [Gdk.KEY_y, 'yank'],
]);

const ALT_ACTIONS = new Map([
    [Gdk.KEY_b, 'backward-word'],
    [Gdk.KEY_d, 'kill-word'],
    [Gdk.KEY_f, 'forward-word'],
    [Gdk.KEY_BackSpace, 'backward-kill-word'],
]);

const HISTORY_NAVIGATION_MODIFIER_MASK = Gdk.ModifierType.SHIFT_MASK
    | Gdk.ModifierType.CONTROL_MASK
    | Gdk.ModifierType.ALT_MASK
    | (Gdk.ModifierType.META_MASK ?? 0)
    | (Gdk.ModifierType.SUPER_MASK ?? 0);

function clampOffset(offset, length) {
    return Math.max(0, Math.min(Number(offset) || 0, length));
}

function lineStart(characters, offset) {
    let position = clampOffset(offset, characters.length);

    while (position > 0 && characters[position - 1] !== '\n')
        position -= 1;

    return position;
}

function lineEnd(characters, offset) {
    let position = clampOffset(offset, characters.length);

    while (position < characters.length && characters[position] !== '\n')
        position += 1;

    return position;
}

function previousWordStart(characters, offset) {
    let position = clampOffset(offset, characters.length);

    while (position > 0 && !isWordCharacter(characters[position - 1]))
        position -= 1;
    while (position > 0 && isWordCharacter(characters[position - 1]))
        position -= 1;

    return position;
}

function nextWordEnd(characters, offset) {
    let position = clampOffset(offset, characters.length);

    while (position < characters.length && !isWordCharacter(characters[position]))
        position += 1;
    while (position < characters.length && isWordCharacter(characters[position]))
        position += 1;

    return position;
}

function isWordCharacter(character) {
    return /[\p{L}\p{N}_]/u.test(character ?? '');
}

function previousLinePosition(characters, cursor) {
    const currentStart = lineStart(characters, cursor);

    if (currentStart === 0)
        return 0;

    const column = cursor - currentStart;
    const previousEnd = currentStart - 1;
    const previousStart = lineStart(characters, previousEnd);
    return Math.min(previousStart + column, previousEnd);
}

function nextLinePosition(characters, cursor) {
    const currentStart = lineStart(characters, cursor);
    const currentEnd = lineEnd(characters, cursor);

    if (currentEnd === characters.length)
        return characters.length;

    const column = cursor - currentStart;
    const nextStart = currentEnd + 1;
    const nextEnd = lineEnd(characters, nextStart);
    return Math.min(nextStart + column, nextEnd);
}

function editResult(characters, start, end, replacement, cursorOffset, {
    killedText,
} = {}) {
    const result = {
        edit: {
            startOffset: start,
            endOffset: end,
            replacement,
        },
        cursorOffset,
    };

    if (killedText !== undefined)
        result.killedText = killedText;

    return result;
}

function deletionResult(characters, start, end, cursorOffset, rememberDeletion = false) {
    const killedText = characters.slice(start, end).join('');
    return editResult(characters, start, end, '', cursorOffset, {
        killedText: rememberDeletion && killedText ? killedText : undefined,
    });
}

export function composerReadlineAction(keyval, state = 0) {
    const controlPressed = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
    const altPressed = (state & Gdk.ModifierType.ALT_MASK) !== 0;

    if (controlPressed === altPressed)
        return null;

    const normalizedKeyval = Gdk.keyval_to_lower(keyval);

    if (controlPressed)
        return CONTROL_ACTIONS.get(normalizedKeyval) ?? null;

    return ALT_ACTIONS.get(normalizedKeyval) ?? null;
}

export function composerHistoryDirection(
    keyval,
    state,
    text,
    cursorOffset,
    selectionBoundOffset = cursorOffset,
) {
    if ((state & HISTORY_NAVIGATION_MODIFIER_MASK) !== 0)
        return 0;

    const characters = [...String(text ?? '')];
    const cursor = clampOffset(cursorOffset, characters.length);
    const selectionBound = clampOffset(selectionBoundOffset, characters.length);

    if (cursor !== selectionBound)
        return 0;

    if (keyval === Gdk.KEY_Up && lineStart(characters, cursor) === 0)
        return -1;

    if (keyval === Gdk.KEY_Down && lineEnd(characters, cursor) === characters.length)
        return 1;

    return 0;
}

export function buildComposerHistoryEntries(
    messages,
    pendingMessages = [],
    limit = 100,
) {
    const persistedEntries = (Array.isArray(messages) ? messages : [])
        .filter((message) => message?.role === 'user')
        .map((message) => ({
            text: typeof message.metadata?.composerText === 'string'
                ? message.metadata.composerText
                : String(message.content ?? ''),
            references: Array.isArray(message.metadata?.composerReferences)
                ? message.metadata.composerReferences.map((reference) => ({ ...reference }))
                : [],
        }));
    const pendingEntries = (Array.isArray(pendingMessages) ? pendingMessages : [])
        .map((message) => ({
            text: String(message?.content ?? ''),
            references: Array.isArray(message?.references)
                ? message.references.map((reference) => ({ ...reference }))
                : [],
        }));
    const entries = [...persistedEntries, ...pendingEntries]
        .filter((entry) => entry.text.trim());
    const safeLimit = Math.max(0, Number(limit) || 0);

    return safeLimit > 0 ? entries.slice(-safeLimit) : [];
}

export function planComposerReadlineEdit(
    text,
    cursorOffset,
    selectionBoundOffset,
    action,
    yankText = '',
) {
    const characters = [...String(text ?? '')];
    const cursor = clampOffset(cursorOffset, characters.length);
    const selectionBound = clampOffset(selectionBoundOffset, characters.length);
    const selectionStart = Math.min(cursor, selectionBound);
    const selectionEnd = Math.max(cursor, selectionBound);
    const hasSelection = selectionStart !== selectionEnd;
    const movementResult = (nextCursor) => ({
        edit: null,
        cursorOffset: clampOffset(nextCursor, characters.length),
    });
    const deleteSelection = (rememberDeletion = false) => deletionResult(
        characters,
        selectionStart,
        selectionEnd,
        selectionStart,
        rememberDeletion,
    );

    switch (action) {
    case 'beginning-of-line':
        return movementResult(lineStart(characters, cursor));
    case 'end-of-line':
        return movementResult(lineEnd(characters, cursor));
    case 'backward-character':
        return movementResult(cursor - 1);
    case 'forward-character':
        return movementResult(cursor + 1);
    case 'backward-word':
        return movementResult(previousWordStart(characters, cursor));
    case 'forward-word':
        return movementResult(nextWordEnd(characters, cursor));
    case 'previous-line':
        return movementResult(previousLinePosition(characters, cursor));
    case 'next-line':
        return movementResult(nextLinePosition(characters, cursor));
    case 'backward-delete-character':
        if (hasSelection)
            return deleteSelection();
        return cursor > 0
            ? deletionResult(characters, cursor - 1, cursor, cursor - 1)
            : movementResult(cursor);
    case 'delete-character':
        if (hasSelection)
            return deleteSelection();
        return cursor < characters.length
            ? deletionResult(characters, cursor, cursor + 1, cursor)
            : movementResult(cursor);
    case 'kill-line': {
        if (hasSelection)
            return deleteSelection(true);

        let end = lineEnd(characters, cursor);

        if (end === cursor && characters[end] === '\n')
            end += 1;

        return deletionResult(characters, cursor, end, cursor, true);
    }
    case 'backward-kill-line':
        if (hasSelection)
            return deleteSelection(true);
        return deletionResult(
            characters,
            lineStart(characters, cursor),
            cursor,
            lineStart(characters, cursor),
            true,
        );
    case 'unix-word-rubout': {
        if (hasSelection)
            return deleteSelection(true);

        let start = cursor;

        while (start > 0 && /\s/u.test(characters[start - 1]))
            start -= 1;
        while (start > 0 && !/\s/u.test(characters[start - 1]))
            start -= 1;

        return deletionResult(characters, start, cursor, start, true);
    }
    case 'backward-kill-word': {
        if (hasSelection)
            return deleteSelection(true);

        const start = previousWordStart(characters, cursor);
        return deletionResult(characters, start, cursor, start, true);
    }
    case 'kill-word': {
        if (hasSelection)
            return deleteSelection(true);

        const end = nextWordEnd(characters, cursor);
        return deletionResult(characters, cursor, end, cursor, true);
    }
    case 'yank': {
        const replacement = String(yankText ?? '');
        const start = hasSelection ? selectionStart : cursor;
        const end = hasSelection ? selectionEnd : cursor;
        return editResult(
            characters,
            start,
            end,
            replacement,
            start + [...replacement].length,
        );
    }
    case 'transpose-characters': {
        if (hasSelection)
            return movementResult(cursor);

        const startOfLine = lineStart(characters, cursor);
        const endOfLine = lineEnd(characters, cursor);

        if (cursor <= startOfLine)
            return movementResult(cursor);

        if (cursor < endOfLine) {
            return editResult(
                characters,
                cursor - 1,
                cursor + 1,
                `${characters[cursor]}${characters[cursor - 1]}`,
                cursor + 1,
            );
        }

        if (cursor - startOfLine < 2)
            return movementResult(cursor);

        return editResult(
            characters,
            cursor - 2,
            cursor,
            `${characters[cursor - 1]}${characters[cursor - 2]}`,
            cursor,
        );
    }
    default:
        return null;
    }
}
