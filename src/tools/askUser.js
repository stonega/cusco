const MAX_ASK_USER_QUESTIONS = 5;
const MAX_ASK_USER_OPTIONS = 8;

function userVisibleError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
}

function parseInput(input) {
    if (input && typeof input === 'object' && !Array.isArray(input))
        return input;

    const source = String(input ?? '').trim();

    if (!source)
        throw userVisibleError('Ask User requires at least one question.');

    try {
        const parsed = JSON.parse(source);

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed;
    } catch (_error) {
        return { questions: [{ question: source }] };
    }

    throw userVisibleError('Ask User input must be a JSON object.');
}

function normalizeOption(option) {
    if (typeof option === 'string') {
        const label = option.trim();

        return label ? { label, value: label, description: '' } : null;
    }

    if (!option || typeof option !== 'object')
        return null;

    const label = String(option.label ?? option.value ?? '').trim();

    if (!label)
        return null;

    return {
        label,
        value: String(option.value ?? label).trim() || label,
        description: String(option.description ?? '').trim(),
    };
}

export function normalizeAskUserQuestions(input) {
    const parsed = parseInput(input);
    const sourceQuestions = Array.isArray(parsed.questions)
        ? parsed.questions
        : parsed.question || parsed.prompt
            ? [parsed]
            : [];

    if (sourceQuestions.length === 0)
        throw userVisibleError('Ask User requires at least one question.');

    if (sourceQuestions.length > MAX_ASK_USER_QUESTIONS) {
        throw userVisibleError(
            `Ask User supports at most ${MAX_ASK_USER_QUESTIONS} questions at a time.`,
        );
    }

    const usedIds = new Set();

    return sourceQuestions.map((question, index) => {
        const source = typeof question === 'string' ? { question } : question;
        const text = String(source?.question ?? source?.prompt ?? '').trim();

        if (!text)
            throw userVisibleError(`Ask User question ${index + 1} is empty.`);

        let id = String(source?.id ?? `question_${index + 1}`).trim() || `question_${index + 1}`;

        if (usedIds.has(id))
            id = `${id}_${index + 1}`;
        usedIds.add(id);

        const rawOptions = Array.isArray(source?.options) ? source.options : [];

        if (rawOptions.length > MAX_ASK_USER_OPTIONS) {
            throw userVisibleError(
                `Ask User question ${index + 1} supports at most ${MAX_ASK_USER_OPTIONS} options.`,
            );
        }

        return {
            id,
            header: String(source?.header ?? '').trim(),
            question: text,
            options: rawOptions.map(normalizeOption).filter(Boolean),
        };
    });
}

export function formatAskUserAnswers(answers) {
    return JSON.stringify({ answers: answers ?? null }, null, 2);
}

export function createAskUserTool(requestUserInput) {
    if (typeof requestUserInput !== 'function')
        throw new TypeError('Ask User requires a requestUserInput callback.');

    return {
        name: 'ask_user',
        label: 'Ask User',
        description: 'Pause the agent and ask the user for required information or a choice. Supports multiple sequential questions, suggested options, custom answers, and a null response when skipped.',
        inputDescription: 'JSON object with a questions array. Each question has an id, question, optional short header, and optional options array of {label, description}. Ask only questions required to continue.',
        inputSchema: {
            type: 'object',
            properties: {
                questions: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_ASK_USER_QUESTIONS,
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            header: { type: 'string' },
                            question: { type: 'string' },
                            options: {
                                type: 'array',
                                maxItems: MAX_ASK_USER_OPTIONS,
                                items: {
                                    type: 'object',
                                    properties: {
                                        label: { type: 'string' },
                                        description: { type: 'string' },
                                    },
                                    required: ['label'],
                                    additionalProperties: false,
                                },
                            },
                        },
                        required: ['id', 'question'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['questions'],
            additionalProperties: false,
        },
        permissionPolicy: 'allow',
        requiresPermission: false,
        concurrencySafe: false,
        run: async (input, options = {}) => {
            const questions = normalizeAskUserQuestions(input);
            const response = await requestUserInput(questions, options);
            const answers = response?.answers ?? null;
            const cancelled = Boolean(response?.cancelled);

            return {
                questions,
                answers,
                cancelled,
                detail: cancelled
                    ? 'Stopped'
                    : answers === null
                        ? 'Skipped'
                        : `${questions.length} answer${questions.length === 1 ? '' : 's'}`,
                output: formatAskUserAnswers(answers),
            };
        },
    };
}
