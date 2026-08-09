import Gio from 'gi://Gio?version=2.0';

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
    || !tool.concurrencySafe
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
const questionModeStates = [];
const questionHarness = {
    _activeQuestionSessionsByConversation: new Map(),
    _composerDraftsByConversation: new Map(),
    _pendingAttachments: [],
    _conversations: { activeConversation: { id: 'conversation-1' } },
    _composerReferences: [],
    _getComposerText: () => 'preserved draft',
    _getComposerReferences: () => [{ kind: 'file', value: '/tmp/note.txt' }],
    _setQuestionComposerMode: (active) => questionModeStates.push(active),
    _setComposerText: (text, options = {}) => restoredDrafts.push({ text, options }),
    _updateAttachmentLabel: () => {},
    _showActiveAgentQuestion: () => {},
    focusComposer: () => {},
    _activeQuestionSessionForConversation: CuscoWindow.prototype._activeQuestionSessionForConversation,
    _composerDraftSnapshot: CuscoWindow.prototype._composerDraftSnapshot,
    _applyComposerDraft: CuscoWindow.prototype._applyComposerDraft,
    _activateAgentQuestionSessionUi: CuscoWindow.prototype._activateAgentQuestionSessionUi,
    _deactivateAgentQuestionSessionUi: CuscoWindow.prototype._deactivateAgentQuestionSessionUi,
    _syncAgentQuestionComposerMode: CuscoWindow.prototype._syncAgentQuestionComposerMode,
    _requestAgentQuestions: CuscoWindow.prototype._requestAgentQuestions,
    _submitAgentQuestionAnswer: CuscoWindow.prototype._submitAgentQuestionAnswer,
    _finishAgentQuestions: CuscoWindow.prototype._finishAgentQuestions,
};
const answerPromise = questionHarness._requestAgentQuestions(normalized);

questionHarness._submitAgentQuestionAnswer('Markdown');

if (questionHarness._activeQuestionSessionForConversation('conversation-1')?.index !== 1)
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

const cancellable = new Gio.Cancellable();
const cancellablePromise = questionHarness._requestAgentQuestions(
    normalized.slice(0, 1),
    { cancellable },
);

if (!questionHarness._activeQuestionSessionForConversation('conversation-1')
    || questionModeStates.at(-1) !== true) {
    throw new Error('Ask User did not enter composer mode with a Gio.Cancellable');
}

cancellable.cancel();
const cancelled = await cancellablePromise;

if (cancelled.answers !== null
    || !cancelled.cancelled
    || questionHarness._activeQuestionSessionForConversation('conversation-1')
    || questionModeStates.at(-1) !== false) {
    throw new Error('Ask User did not leave composer mode after Gio.Cancellable cancellation');
}

questionHarness._conversations.activeConversation = { id: 'conversation-1' };
const foregroundQuestionPromise = questionHarness._requestAgentQuestions(
    normalized.slice(0, 1),
    { conversationId: 'conversation-1' },
);
const backgroundQuestionPromise = questionHarness._requestAgentQuestions(
    normalized.slice(0, 1),
    { conversationId: 'conversation-2' },
);

if (questionHarness._activeQuestionSessionsByConversation.size !== 2
    || questionHarness._activeQuestionSessionForConversation('conversation-2')?.uiActive) {
    throw new Error('A background chat replaced the active chat composer with its question');
}

questionHarness._submitAgentQuestionAnswer('Markdown');
const foregroundAnswers = await foregroundQuestionPromise;

if (foregroundAnswers.answers?.format !== 'Markdown')
    throw new Error('The foreground Ask User response lost its conversation owner');

questionHarness._conversations.activeConversation = { id: 'conversation-2' };
questionHarness._syncAgentQuestionComposerMode();

if (!questionHarness._activeQuestionSessionForConversation('conversation-2')?.uiActive
    || questionModeStates.at(-1) !== true) {
    throw new Error('Selecting a background chat did not reveal its pending question');
}

questionHarness._submitAgentQuestionAnswer('Markdown');
const backgroundAnswers = await backgroundQuestionPromise;

if (backgroundAnswers.answers?.format !== 'Markdown')
    throw new Error('Background chat question did not remain scoped to its conversation');

print('Cusco Ask User smoke passed');
