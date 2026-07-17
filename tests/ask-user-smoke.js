import {
    createAskUserTool,
    formatAskUserAnswers,
    normalizeAskUserQuestions,
} from '../src/tools/askUser.js';
import { ToolManager } from '../src/tools/tools.js';
import { CuscoWindow } from '../src/window.js';

const normalized = normalizeAskUserQuestions(JSON.stringify({
    questions: [
        {
            id: 'format',
            header: 'Output',
            question: 'Which format should be used?',
            options: [
                { label: 'Markdown', description: 'Human-readable output.' },
                'JSON',
            ],
        },
        {
            id: 'scope',
            question: 'Which scope should be included?',
        },
    ],
}));

if (normalized.length !== 2
    || normalized[0].options[1].value !== 'JSON'
    || normalized[1].id !== 'scope') {
    throw new Error('Ask User questions were not normalized');
}

const manager = new ToolManager();
let requestedQuestions = null;
manager.registerTool(createAskUserTool(async (questions) => {
    requestedQuestions = questions;
    return {
        answers: {
            format: 'Markdown',
            scope: 'Current conversation',
        },
    };
}));

const tool = manager.getTool('ask_user');

if (tool.permissionPolicy !== 'allow'
    || tool.requiresPermission
    || tool.inputSchema?.properties?.questions?.maxItems < 2) {
    throw new Error('Ask User tool metadata is invalid');
}

const result = await manager.runRequest(manager.createRequest('ask_user', JSON.stringify({
    questions: normalized,
})));

if (requestedQuestions?.length !== 2
    || result.answers?.format !== 'Markdown'
    || !result.output.includes('Current conversation')) {
    throw new Error('Ask User tool did not return collected answers');
}

if (formatAskUserAnswers(null) !== '{\n  "answers": null\n}')
    throw new Error('Ask User null response was not explicit');

const restoredDrafts = [];
const questionHarness = {
    _activeQuestionSession: null,
    _composerReferences: [],
    _getComposerText: () => 'preserved draft',
    _getComposerReferences: () => [{ kind: 'file', value: '/tmp/note.txt' }],
    _setQuestionComposerMode: () => {},
    _setComposerText: (text, options = {}) => restoredDrafts.push({ text, options }),
    _showActiveAgentQuestion: () => {},
    focusComposer: () => {},
    _requestAgentQuestions: CuscoWindow.prototype._requestAgentQuestions,
    _submitAgentQuestionAnswer: CuscoWindow.prototype._submitAgentQuestionAnswer,
    _finishAgentQuestions: CuscoWindow.prototype._finishAgentQuestions,
};
const answerPromise = questionHarness._requestAgentQuestions(normalized);

questionHarness._submitAgentQuestionAnswer('Markdown');

if (questionHarness._activeQuestionSession?.index !== 1)
    throw new Error('Ask User did not advance to the next question');

questionHarness._submitAgentQuestionAnswer('Current conversation');
const collected = await answerPromise;

if (collected.answers?.format !== 'Markdown'
    || collected.answers?.scope !== 'Current conversation'
    || restoredDrafts.at(-1)?.text !== 'preserved draft'
    || !restoredDrafts.at(-1)?.options?.preserveReferences) {
    throw new Error('Ask User composer session did not collect answers and restore its draft');
}

const skippedPromise = questionHarness._requestAgentQuestions(normalized.slice(0, 1));
questionHarness._finishAgentQuestions(null);
const skipped = await skippedPromise;

if (skipped.answers !== null || skipped.cancelled)
    throw new Error('Ask User Escape-style completion did not return a non-cancelled null answer');

print('Cusco Ask User smoke passed');
