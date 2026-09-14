function isEscaped(source, index) {
    let backslashes = 0;
    while (index > 0 && source[--index] === '\\')
        backslashes++;
    return backslashes % 2 === 1;
}

export function mathTokenAt(source, index, { incomplete = false } = {}) {
    const opener = source.startsWith('$$', index) ? '$$'
        : source.startsWith('\\[', index) ? '\\['
            : source.startsWith('\\(', index) ? '\\('
                : source[index] === '$' ? '$' : null;
    if (!opener || isEscaped(source, index))
        return null;
    const display = opener === '$$' || opener === '\\[';
    const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener;
    const start = index + opener.length;
    if (opener === '$' && (!source[start] || /\s/.test(source[start])
        || /[\d$]/.test(source[index - 1] ?? '')))
        return null;

    for (let end = start; end < source.length; end++) {
        if (opener === '$' && source[end] === '`')
            return null;
        if (!display && source[end] === '\n')
            return null;
        if (!source.startsWith(closer, end) || isEscaped(source, end))
            continue;
        // Do not join dollar amounts, e.g. "$5 and $10", into a formula.
        if (opener === '$' && (/\s/.test(source[end - 1])
            || /[\d$]/.test(source[end + 1] ?? '')))
            return null;
        const tex = source.slice(start, end);
        if (!tex.trim())
            return null;
        return { tex, display, raw: source.slice(index, end + closer.length),
            nextIndex: end + closer.length, complete: true };
    }
    return incomplete && (display || opener === '\\(')
        ? { nextIndex: source.length, complete: false }
        : null;
}
