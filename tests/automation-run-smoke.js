import Gio from 'gi://Gio?version=2.0';

import { AgentRuntime } from '../src/chat/agentRuntime.js';
import { AssistantStreamRunner } from '../src/chat/assistantStreamRunner.js';
import { ConversationContextBuilder } from '../src/chat/contextBuilder.js';
import { ConversationManager } from '../src/chat/conversation.js';
import { PendingMessagesController } from '../src/chat/pendingMessages.js';
import { createStreamingAssistantView } from '../src/chat/streamingAssistantView.js';
import { TurnSubmission } from '../src/chat/turnSubmission.js';
import { CronConversationSync } from '../src/cron/conversationSync.js';
import { createMessage } from '../src/providers/provider.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const conversations = new ConversationManager({ providerId: 'test', modelId: 'test' });
const sync = new CronConversationSync({ conversations });
const { conversation } = sync.ensureConversation({
    id: 'daily-task', title: 'Daily task', prompt: 'Check status', schedule: '0 9 * * *', enabled: true,
});
assert(conversation.agentModeEnabled, 'New automation conversations must enable agent tools');

// Existing automation chats may have Agent Mode off and an arbitrarily long transcript.
conversation.agentModeEnabled = false;
conversation.memoryEnabled = true;
conversations.appendMessage(conversation.id, createMessage('system', 'OLD SUMMARY'));
conversations.appendMessage(conversation.id, createMessage('user', 'OLD PROMPT'));
conversations.appendMessage(conversation.id, createMessage('assistant', 'OLD ANSWER'));
const originalMessages = [...conversation.messages];
const pending = new Map();
const turns = new Map();
const hooksSeen = [];
let rejectPrompt = false;
const submission = new TurnSubmission({
    conversations,
    pendingUserMessagesByConversation: pending,
    turns,
    getPendingUserMessages: (id) => pending.get(id) ?? [],
    createAttachmentsForComposerReferences: () => [],
    formatUserMessageContent: (text) => text,
    renderPendingUserMessages() {},
    addMessageIfActiveConversation() {},
    promptMemoryProposal() {
        throw new Error('Automation prompts must not create memory proposals');
    },
    updateUsageDisplay() {},
    refreshConversationList() {},
    isConversationBusy: (id) => turns.has(id),
    ensureConversationProviderAvailable: () => true,
    beginActiveTurn(id) {
        const cancellable = new Gio.Cancellable();
        turns.set(id, { cancellable, turnId: 'turn', hookContexts: [] });
        return cancellable;
    },
    finishActiveTurn() {
        turns.delete(conversation.id);
    },
    runUserPromptHooks: async (_conversation, prompt) => {
        hooksSeen.push(prompt);
        return !rejectPrompt;
    },
    streamAssistantResponse: async (_id, options) => {
        assert(options.automationMessage?.metadata.automationJobId === 'daily-task',
            'Queued automation did not pass its run boundary to the response runner');
        assert(turns.get(conversation.id).automationRun,
            'The active turn did not identify isolated automation execution');
        const queuedFollowUp = await PendingMessagesController.prototype._enqueuePendingUserMessageWithHooks.call({
            _conversations: conversations,
            _activeTurnsByConversation: turns,
            _enqueuePendingUserMessage: (content) => ({ content }),
            _runUserPromptHooks() { throw new Error('Queued follow-up hooks ran inside an automation'); },
        }, 'Later follow-up', [], conversation.id);
        assert(queuedFollowUp.content === 'Later follow-up' && !queuedFollowUp.hookTurnId,
            'Manual input was not queued for its own future turn');
        // A stopped response leaves the next queued run available for inspection.
        options.cancellable.cancel();
        return { stoppedBeforeAssistantText: false };
    },
});

function queued(id, content, automation = true) {
    return { id, content, references: [], ...(automation ? { automationJobId: 'daily-task' } : {}) };
}

pending.set(conversation.id, [queued('first', 'FIRST TASK'), queued('second', 'SECOND TASK')]);
assert(submission._drainPendingUserMessagesForRuntime(conversation, []).length === 0,
    'An ordinary agent response consumed a queued automation');
await submission._sendQueuedUserMessages(conversation.id);
assert(pending.get(conversation.id)?.length === 1 && hooksSeen.join() === 'FIRST TASK',
    'Queued automation runs were merged or future run hooks ran early');
const firstPrompt = conversation.messages.at(-1);

const tool = {
    name: 'mcp__status__read', label: 'Read status', description: 'Read current status',
    permissionPolicy: 'allow',
};
let toolsRefreshed = 0;
let connectorsRefreshed = 0;
let skillLoads = 0;
const toolManager = {
    listTools: () => toolsRefreshed ? [tool] : [],
    createRequest: (name, input) => ({ id: 'request', name, input }),
};
const context = new ConversationContextBuilder({
    tools: toolManager,
    workspace: {
        getSkillsForConversation(run) {
            skillLoads += 1;
            assert(run.messages[0].metadata?.automationJobId === 'daily-task',
                'Skill loading received history from an earlier run');
            return [{ id: 'status-skill', name: 'status-skill', enabled: true, content: 'TASK SKILL INSTRUCTIONS' }];
        },
    },
    providerConfigs: { getNativeSearchTools: () => [] },
    sessionHookContexts: new Map([[conversation.id, ['OLD SESSION CONTEXT']]]),
    activeTurnHookContexts: () => ['CURRENT TURN CONTEXT'],
});
const providerCalls = [];
const toolCalls = [];
let expectedPrompt = 'FIRST TASK';
let providerStep = 0;
let continuationCount = 0;
let activeRun = null;
const runtime = new AgentRuntime({
    conversations,
    tools: toolManager,
    drainPendingUserMessagesForRuntime: (...args) => submission._drainPendingUserMessagesForRuntime(...args),
    collectProviderResponseWithFallback: async (run, messages, _cancellable, _onChunk, options) => {
        activeRun = run;
        providerCalls.push(messages.map((message) => ({ ...message })));
        assert(!messages.some((message) => /OLD |Automation:|Schedule:/.test(message.content)),
            'Automation provider context included prior history or task metadata');
        assert(options.tools.some((candidate) => candidate.name === tool.name),
            'Automation did not expose refreshed MCP tools to native function calling');
        assert(messages.some((message) => message.content.includes('TASK SKILL INSTRUCTIONS')),
            'Automation omitted its skill instructions');
        assert(messages.some((message) => message.content.includes('CURRENT TURN CONTEXT')),
            'Automation lost its current lifecycle hook instructions');
        if (providerStep++ === 0) {
            const nonSystem = messages.filter((message) => message.role !== 'system');
            assert(nonSystem.length === 1 && nonSystem[0].content === expectedPrompt,
                'A task run did not start with exactly one user prompt');
            return { text: '', reasoning: '', toolCalls: [{ id: 'mcp-call', name: tool.name, input: '{}' }] };
        }
        if (providerStep === 2) {
            assert(messages.some((message) => message.role === 'tool' && message.content === 'CURRENT STATUS'),
                'Tool results from the current run were not retained');
        }
        return { text: `${expectedPrompt} RESULT ${providerStep}`, reasoning: '', toolCalls: [] };
    },
});
runtime._runAgentToolRequest = async (request, _text, run, messages) => {
    toolCalls.push(request.name);
    conversations.appendMessage(run.id, createMessage('system', 'CURRENT TOOL TRANSCRIPT'));
    messages.push({ role: 'tool', toolCallId: 'mcp-call', toolName: request.name, content: 'CURRENT STATUS' });
    return true;
};
const runner = new AssistantStreamRunner({
    appSettings: { responseTimeoutSeconds: 30 },
    conversations,
    tools: toolManager,
    mcp: { refreshTools: async () => { toolsRefreshed += 1; } },
    connectors: { refreshTools: async () => { connectorsRefreshed += 1; } },
    hooks: {
        dispatch: async (event) => event === 'Stop' && continuationCount++ === 0
            ? { shouldContinue: true, continuationReasons: ['Verify this run'] }
            : { shouldContinue: false },
    },
    ensureTurnSessionHooks: async () => true,
    injectMemoryContext() { throw new Error('Automation used saved memory'); },
    injectSkillContext: (run) => context.injectSkillContext(run),
    maybeAutoCompactConversation() { throw new Error('Automation compacted its stored history'); },
    buildProviderMessages: (...args) => context.buildProviderMessages(...args),
    runAgentModeResponse: (...args) => runtime._runAgentModeResponse(...args),
    collectProviderResponseWithFallback() { throw new Error('Automation bypassed agent execution'); },
    createStreamingAssistantView: (run) => createStreamingAssistantView({
        conversation: run, conversations, isActiveConversationId: () => false,
    }),
    isActiveConversationId: () => false,
    startLongResponseNotification() {},
    stopLongResponseNotification() {},
    applyHookResult() {},
    appendHookNotice() {},
    turnHookContext: () => ({}),
    materializeAssistantArtifacts: () => [],
    refreshConversationList() {},
    updateUsageDisplay() {},
});

await runner._streamAssistantResponse(conversation.id, {
    automationMessage: firstPrompt, cancellable: new Gio.Cancellable(),
});
assert(pending.get(conversation.id)?.[0].id === 'second', 'The live task absorbed its next scheduled run');
assert(providerCalls.length === 3 && toolCalls.length === 1,
    'Automation did not finish its tool loop and Stop-hook continuation');
assert(providerCalls[2].some((message) => message.content === 'FIRST TASK RESULT 2'),
    'Stop-hook continuation lost the current run output');

pending.set(conversation.id, [queued('chat', 'FOLLOW-UP', false), ...pending.get(conversation.id)]);
assert(submission._drainPendingUserMessagesForRuntime(activeRun, []).length === 0,
    'A live task absorbed a queued manual follow-up');
pending.get(conversation.id).shift();
expectedPrompt = 'SECOND TASK';
providerStep = 0;
continuationCount = 0;
await submission._sendQueuedUserMessages(conversation.id);
await runner._streamAssistantResponse(conversation.id, {
    automationMessage: conversation.messages.at(-1), cancellable: new Gio.Cancellable(),
});
assert(!pending.has(conversation.id) && toolsRefreshed === 2 && connectorsRefreshed === 2 && skillLoads === 2,
    'Repeated automation runs failed to refresh their skills and tools independently');
assert(providerCalls[3].filter((message) => message.role !== 'system').length === 1,
    'The second task inherited the first task result');
assert(originalMessages.every((message, index) => conversation.messages[index] === message),
    'Isolated automation execution changed earlier transcript messages');
assert(conversation.messages.some((message) => message.content === 'FIRST TASK RESULT 3')
    && conversation.messages.at(-1).content === 'SECOND TASK RESULT 3',
    'Automation results were not appended to the original conversation');
assert(!conversation.agentModeEnabled && conversation.memoryEnabled && !conversation.automationRun,
    'Run-specific settings leaked into the saved conversation');

const manualContext = context.buildProviderMessages(conversation, []);
assert(manualContext.some((message) => message.content === 'OLD ANSWER')
    && manualContext.some((message) => message.content.includes('OLD SESSION CONTEXT')),
    'Ordinary chat lost its conversation context');

submission._promptMemoryProposal = () => {};
pending.set(conversation.id, [queued('manual', 'MANUAL MESSAGE', false), queued('scheduled', 'NEXT TASK')]);
const manualRuntimeMessages = [];
submission._drainPendingUserMessagesForRuntime(conversation, manualRuntimeMessages);
assert(manualRuntimeMessages.length === 1 && manualRuntimeMessages[0].content === 'MANUAL MESSAGE'
    && pending.get(conversation.id)?.[0].id === 'scheduled',
    'Manual queue draining crossed an automation run boundary');

rejectPrompt = true;
pending.set(conversation.id, [queued('blocked', 'BLOCKED TASK'), queued('later', 'LATER TASK')]);
const sentBlocked = await submission._sendQueuedUserMessages(conversation.id);
assert(!sentBlocked && pending.get(conversation.id)?.[0].id === 'later'
    && !conversation.messages.some((message) => message.content === 'LATER TASK'),
    'A blocked task consumed the next automation without running its hooks');

print('Cusco automation run smoke passed');
