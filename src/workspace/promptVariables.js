const PROMPT_VARIABLE_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_-]*)\s*}}/g;

export function extractPromptVariables(content) {
    const variables = [];
    const seen = new Set();

    for (const variable of findPromptVariables(content)) {
        const { name } = variable;

        if (seen.has(name))
            continue;

        seen.add(name);
        variables.push(name);
    }

    return variables;
}

export function findPromptVariables(content) {
    const variables = [];
    const text = String(content ?? '');

    for (const match of text.matchAll(PROMPT_VARIABLE_PATTERN)) {
        variables.push({
            name: match[1],
            start: match.index,
            end: match.index + match[0].length,
        });
    }

    return variables;
}

export function renderPromptTemplate(content, values = {}) {
    return String(content ?? '').replace(PROMPT_VARIABLE_PATTERN, (placeholder, name) => {
        if (!Object.hasOwn(values, name))
            return placeholder;

        return String(values[name] ?? '');
    });
}

export function formatPromptVariables(content) {
    const variables = extractPromptVariables(content);

    if (variables.length === 0)
        return '';

    return `Variables: ${variables.join(', ')}`;
}
