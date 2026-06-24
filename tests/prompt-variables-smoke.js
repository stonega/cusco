import {
    extractPromptVariables,
    formatPromptVariables,
    renderPromptTemplate,
} from '../src/workspace/promptVariables.js';

function assertDeepEqual(actual, expected, message) {
    const actualText = JSON.stringify(actual);
    const expectedText = JSON.stringify(expected);

    if (actualText !== expectedText)
        throw new Error(`${message}: expected ${expectedText}, got ${actualText}`);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const template = 'Write a {{tone}} reply to {{ person }} about {{topic_1}} for {{team-name}}. Use {{tone}}.';

assertDeepEqual(
    extractPromptVariables(template),
    ['tone', 'person', 'topic_1', 'team-name'],
    'Prompt variables were not extracted in first-use order',
);

assertEqual(
    renderPromptTemplate(template, {
        tone: 'friendly',
        person: 'Ada',
        topic_1: 'launch planning',
        'team-name': 'Design',
    }),
    'Write a friendly reply to Ada about launch planning for Design. Use friendly.',
    'Prompt variables were not rendered',
);

assertEqual(
    renderPromptTemplate('Hello {{name}}. Keep {{missing}} and {{}} literal.', { name: 'Ada' }),
    'Hello Ada. Keep {{missing}} and {{}} literal.',
    'Missing or malformed placeholders should stay literal',
);

assertEqual(formatPromptVariables('No placeholders here'), '', 'Empty variable summary should be blank');
assertEqual(formatPromptVariables(template), 'Variables: tone, person, topic_1, team-name', 'Variable summary failed');

print('Cusco prompt variables smoke passed');
