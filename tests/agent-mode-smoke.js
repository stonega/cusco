import {
    buildAgentModeSystemPrompt,
    createAgentToolFailurePrompt,
    createAgentToolResultPrompt,
    createAgentToolRuntimeMessages,
    createNativeToolIntegrityFailureResults,
    createNativeToolRuntimeBatch,
    decideNativeToolIntegrityRecovery,
    DEFAULT_AGENT_MAX_ITERATIONS,
    formatAgentToolCall,
    isPartialAgentToolCall,
    parseAgentToolCall,
    pruneComputerUseObservationImages,
} from '../src/chat/agentMode.js';
import { CuscoWindow } from '../src/window.js';
import { createToolPermissionDecision, TOOL_PERMISSION_DENY } from '../src/tools/permissions.js';
import { createAskUserTool } from '../src/tools/askUser.js';
import { ToolManager } from '../src/tools/tools.js';

const tools = new ToolManager();
const prompt = buildAgentModeSystemPrompt(tools.listTools(), { maxIterations: 2 });
const defaultPrompt = buildAgentModeSystemPrompt(tools.listTools());
const nativeSearchPrompt = buildAgentModeSystemPrompt(
    tools.listTools().filter((tool) => tool.name !== 'search'),
    { nativeSearchTools: ['google_search', 'url_context'] },
);
const nativeToolPrompt = buildAgentModeSystemPrompt([
    ...tools.listTools(),
    createAskUserTool(async () => ({ answers: null })),
    {
        name: 'computer_step',
        label: 'Act and observe desktop window',
        permissionPolicy: 'ask',
    },
    {
        name: 'computer_act',
        label: 'Control GNOME desktop',
        permissionPolicy: 'ask',
    },
    {
        name: 'computer_observe_region',
        label: 'Zoom into desktop window region',
        permissionPolicy: 'ask',
    },
    {
        name: 'computer_exit',
        label: 'Exit computer use',
        permissionPolicy: 'allow',
    },
], { nativeToolCalling: true });

if (DEFAULT_AGENT_MAX_ITERATIONS < 100
    || !defaultPrompt.includes(`at most ${DEFAULT_AGENT_MAX_ITERATIONS} tool-use iterations`)) {
    throw new Error(`Agent Mode max iteration default is too low: ${DEFAULT_AGENT_MAX_ITERATIONS}`);
}

if (!prompt.includes('Agent is enabled')
    || !prompt.includes('calc')
    || !prompt.includes('<cusco_tool_call>')
    || !prompt.includes('mcp__')
    || !prompt.includes('MCP server tools exposed through Cusco')) {
    throw new Error('Agent Mode prompt did not describe the tool protocol');
}

if (!nativeSearchPrompt.includes('Provider-managed tools are enabled: google_search, url_context')
    || !nativeSearchPrompt.includes('Use URL Context when the user supplies complete public URLs')
    || nativeSearchPrompt.includes('- search: Web Search')) {
    throw new Error('Agent Mode prompt did not route Gemini provider-managed tools');
}

if (!nativeToolPrompt.includes('native function-calling interface')
    || !nativeToolPrompt.includes('call ask_user instead of asking in ordinary assistant text')
    || !nativeToolPrompt.includes('prefer computer_step')
    || !nativeToolPrompt.includes('reuse a suitable existing window on its current workspace')
    || !nativeToolPrompt.includes('move_to_new_workspace')
    || !nativeToolPrompt.includes('Maximize the target when canMaximize is true')
    || !nativeToolPrompt.includes('prefer keypress Down followed by Return')
    || !nativeToolPrompt.includes('include an expect entry')
    || !nativeToolPrompt.includes('coordinate click without a matching expectation as unverified')
    || !nativeToolPrompt.includes('stale_observation')
    || !nativeToolPrompt.includes('no coordinate action was dispatched')
    || !nativeToolPrompt.includes('Menus, dropdowns, popovers')
    || !nativeToolPrompt.includes('autoZoom.applied')
    || !nativeToolPrompt.includes('visualStateCycleDetected')
    || !nativeToolPrompt.includes('single automatically enlarged view')
    || !nativeToolPrompt.includes('interactionGuard.localBounds')
    || !nativeToolPrompt.includes('rejects clicks outside')
    || !nativeToolPrompt.includes('retainedRegion.applied')
    || !nativeToolPrompt.includes('click the visual center')
    || !nativeToolPrompt.includes('simultaneous chord, not a sequence')
    || !nativeToolPrompt.includes('prefer native paste_text over direct simulated typing')
    || !nativeToolPrompt.includes('copies the complete value to the clipboard')
    || !nativeToolPrompt.includes('sensitive values that should not enter clipboard history')
    || !nativeToolPrompt.includes('when the target rejects pasted input')
    || !nativeToolPrompt.includes('call computer_observe_region')
    || !nativeToolPrompt.includes('one computer_step paste_text action containing x, y, and text')
    || !nativeToolPrompt.includes('Add replace:true when the field already contains text')
    || !nativeToolPrompt.includes('click and inspect before later keyboard input')
    || !nativeToolPrompt.includes('complete value')
    || !nativeToolPrompt.includes('multiple Chrome or Chromium profiles')
    || !nativeToolPrompt.includes('call ask_user with their visible names')
    || !nativeToolPrompt.includes('known payload was deterministically typed or pasted')
    || !nativeToolPrompt.includes('Long opaque values')
    || !nativeToolPrompt.includes('Never repair individual characters')
    || !nativeToolPrompt.includes('visualConfirmationRequired true')
    || !nativeToolPrompt.includes('semantic verification was unavailable, not that the action failed')
    || !nativeToolPrompt.includes('text lands in browser chrome')
    || !nativeToolPrompt.includes('synthetic coordinate grid')
    || !nativeToolPrompt.includes('whether the task succeeded or failed')
    || !nativeToolPrompt.includes('Cusco window and its workspaceIndex')
    || !nativeToolPrompt.includes('computer_act with switch_workspace for that workspace')
    || !nativeToolPrompt.includes('last desktop-control action computer_act with focus for the Cusco window')
    || !nativeToolPrompt.includes('call computer_exit automatically')
    || !nativeToolPrompt.includes('Do not ask the user whether to exit')
    || !nativeToolPrompt.includes('final computer-use tool')
    || nativeToolPrompt.includes('<cusco_tool_call>')) {
    throw new Error('Native Agent Mode prompt mixed native and XML tool protocols');
}

const runtimeMessages = [
    {
        role: 'user',
        content: 'Tool result for computer_observe:\n{}',
        attachments: [
            { kind: 'image', path: '/tmp/old-observation.png' },
            { kind: 'file', path: '/tmp/keep.txt' },
        ],
    },
    {
        role: 'user',
        content: 'Tool result for image_gen:\n{}',
        attachments: [{ kind: 'image', path: '/tmp/generated.png' }],
    },
    {
        role: 'tool',
        toolName: 'computer_step',
        content: '{}',
        attachments: [{ kind: 'image', path: '/tmp/old-step.png' }],
    },
    {
        role: 'tool',
        toolName: 'computer_observe_region',
        content: '{}',
        attachments: [{ kind: 'image', path: '/tmp/old-region.png' }],
    },
];

if (pruneComputerUseObservationImages(runtimeMessages) !== 3
    || runtimeMessages[0].attachments.length !== 1
    || runtimeMessages[1].attachments.length !== 1
    || runtimeMessages[2].attachments.length !== 0
    || runtimeMessages[3].attachments.length !== 0) {
    throw new Error('Superseded computer-use observations were not pruned');
}

const parsedCall = parseAgentToolCall('<cusco_tool_call>{"name":"calc","input":"2 + 2"}</cusco_tool_call>');

if (parsedCall.name !== 'calc' || parsedCall.input !== '2 + 2')
    throw new Error('Agent tool call was not parsed');

const formattedCall = parseAgentToolCall(formatAgentToolCall({
    name: 'mcp__context7__resolve_library_id',
    input: '{"query":"React","libraryName":"React"}',
}));

if (formattedCall.name !== 'mcp__context7__resolve_library_id'
    || !formattedCall.input.includes('libraryName')) {
    throw new Error('Formatted Agent tool call was not parsed');
}

const objectInput = parseAgentToolCall('<cusco_tool_call>{"tool":"data","input":{"a":1}}</cusco_tool_call>');

if (objectInput.name !== 'data' || objectInput.input !== '{"a":1}')
    throw new Error('Agent tool call object input was not stringified');

if (!isPartialAgentToolCall('<cusco_tool_call>{"name":"calc"'))
    throw new Error('Partial Agent Mode tool call was not detected');

let invalidJsonFailed = false;

try {
    parseAgentToolCall('<cusco_tool_call>{"name":</cusco_tool_call>');
} catch (error) {
    invalidJsonFailed = error.userMessage?.includes('invalid tool request');
}

if (!invalidJsonFailed)
    throw new Error('Invalid Agent Mode tool call did not produce a user-visible error');

const calcRequest = tools.createRequest('calc', '4 * 5');
const calcResult = await tools.runRequest(calcRequest);

if (calcResult.output !== '20')
    throw new Error(`Agent Mode calculator request returned ${calcResult.output}`);

const searchRequest = tools.createRequest('search', 'GNOME AI chat app');
const searchDecision = createToolPermissionDecision(searchRequest);

if (searchDecision.status !== 'ask' || !searchDecision.requiresUserApproval)
    throw new Error('Search tool did not require approval');

tools.registerTool({
    name: 'blocked',
    label: 'Blocked Tool',
    permissionPolicy: TOOL_PERMISSION_DENY,
    run: () => 'should not run',
});
const denyDecision = createToolPermissionDecision(tools.createRequest('blocked', 'test'));

if (denyDecision.status !== 'deny')
    throw new Error('Denied tool policy was not preserved');

const autoModeDecision = createToolPermissionDecision(tools.createRequest('blocked', 'test'), {
    autoModeEnabled: true,
});

if (autoModeDecision.status !== 'allow' || autoModeDecision.requiresUserApproval)
    throw new Error('Auto Mode did not allow a blocked tool without approval');

if (!createAgentToolResultPrompt(calcRequest, 'Calculator result').includes('Tool result for calc'))
    throw new Error('Agent tool result prompt was not formatted');

if (!createAgentToolFailurePrompt(calcRequest, 'nope').includes('could not be run'))
    throw new Error('Agent tool failure prompt was not formatted');

const legacyResultMessages = createAgentToolRuntimeMessages(
    calcRequest,
    '',
    '20',
    { attachments: [{ kind: 'file', path: '/tmp/result.txt' }] },
);

if (legacyResultMessages.length !== 2
    || legacyResultMessages[0].role !== 'assistant'
    || legacyResultMessages[1].role !== 'user'
    || !legacyResultMessages[1].content.includes('Tool result for calc')
    || legacyResultMessages[1].attachments[0].path !== '/tmp/result.txt') {
    throw new Error('Legacy Agent tool results were not preserved');
}

const nativeFailureCall = {
    id: 'call-failed-calc',
    name: 'calc',
    input: 'not-an-expression',
};
const nativeFailureMessages = createAgentToolRuntimeMessages(
    calcRequest,
    '',
    'Calculator input was invalid.',
    { failed: true, nativeToolCall: nativeFailureCall },
);

if (nativeFailureMessages.length !== 2
    || nativeFailureMessages[0].role !== 'assistant'
    || nativeFailureMessages[0].toolCalls[0] !== nativeFailureCall
    || nativeFailureMessages[1].role !== 'tool'
    || nativeFailureMessages[1].toolCallId !== nativeFailureCall.id
    || nativeFailureMessages[1].toolName !== nativeFailureCall.name
    || !nativeFailureMessages[1].content.includes('could not be run')
    || !nativeFailureMessages[1].content.includes('correct the request and retry')
    || !nativeFailureMessages[1].content.includes('Calculator input was invalid.')) {
    throw new Error('Native Agent tool failures were not returned as tool results');
}

const parallelNativeCalls = [
    {
        id: 'call-observe',
        name: 'computer_observe',
        input: '{}',
        thoughtSignature: 'gemini-parallel-signature',
    },
    {
        id: 'call-list',
        name: 'computer_list',
        input: '{}',
    },
];
const parallelRuntimeBatch = createNativeToolRuntimeBatch(
    '',
    parallelNativeCalls,
    [
        ...createAgentToolRuntimeMessages(calcRequest, '', 'observed', {
            nativeToolCall: parallelNativeCalls[0],
        }),
        ...createAgentToolRuntimeMessages(calcRequest, '', 'listed', {
            nativeToolCall: parallelNativeCalls[1],
        }),
    ],
    {
        providerParts: [{
            toolCall: { id: 'server-search-1', toolType: 'GOOGLE_SEARCH_WEB' },
            thoughtSignature: 'server-search-signature',
        }],
    },
);

if (parallelRuntimeBatch.length !== 3
    || parallelRuntimeBatch[0].role !== 'assistant'
    || parallelRuntimeBatch[0].toolCalls.length !== 2
    || parallelRuntimeBatch[0].providerParts[0].toolCall.id !== 'server-search-1'
    || parallelRuntimeBatch[0].providerParts[0].thoughtSignature !== 'server-search-signature'
    || parallelRuntimeBatch[0].toolCalls[0].thoughtSignature !== 'gemini-parallel-signature'
    || parallelRuntimeBatch[0].toolCalls[1].thoughtSignature !== undefined
    || parallelRuntimeBatch[1].role !== 'tool'
    || parallelRuntimeBatch[2].role !== 'tool') {
    throw new Error('Parallel native tool calls were not preserved as one assistant turn');
}

const invalidNativeBatch = [{
    id: 'call-invalid-json',
    name: 'artifact_create',
    input: '',
    rawArguments: '{"content":"unfinished',
    argumentsValid: false,
}, {
    id: 'call-valid-sibling',
    name: 'calc',
    input: '2 + 2',
    rawArguments: '{"input":"2 + 2"}',
    argumentsValid: true,
}];
const truncatedIntegrity = {
    status: 'truncated',
    reason: 'max_output_with_incomplete_tool_call',
};
const firstIntegrityDecision = decideNativeToolIntegrityRecovery(
    invalidNativeBatch,
    truncatedIntegrity,
    { recoveryUsed: false },
);
const repeatedIntegrityDecision = decideNativeToolIntegrityRecovery(
    invalidNativeBatch,
    truncatedIntegrity,
    { recoveryUsed: true },
);
const integrityFailureResults = createNativeToolIntegrityFailureResults(
    invalidNativeBatch,
    truncatedIntegrity,
);

if (firstIntegrityDecision.action !== 'retry'
    || !firstIntegrityDecision.userMessage.includes('smaller')
    || repeatedIntegrityDecision.action !== 'stop'
    || !repeatedIntegrityDecision.userMessage.includes('repeatedly')) {
    throw new Error('Native tool integrity retry policy was not bounded');
}

if (integrityFailureResults.length !== 2
    || integrityFailureResults.some((message) => message.role !== 'tool')
    || !integrityFailureResults[0].content.includes('output limit')
    || !integrityFailureResults[1].content.includes('not executed')
    || !integrityFailureResults[1].content.includes('reissue')) {
    throw new Error('Native tool integrity failure results were not classified per call');
}

function createAgentIntegrityWindow(responses) {
    const providerCalls = [];
    const createdRequests = [];
    const runRequests = [];
    const systemMessages = [];
    const view = {
        set_status() {},
        clear_status() {},
        set_usage() {},
    };
    const window = {
        _tools: {
            listTools() {
                return [];
            },
        },
        _drainPendingUserMessagesForRuntime() {
            return [];
        },
        _appendOrUpdateAgentReasoningSegment() {
            return null;
        },
        _parseAgentToolCallForRuntime() {
            return null;
        },
        async _collectProviderResponseWithFallback(_conversation, runtimeMessages) {
            providerCalls.push(runtimeMessages.map((message) => ({ ...message })));
            return responses.shift() ?? {
                text: 'Done',
                reasoning: '',
                toolCalls: [],
                toolCallIntegrity: { status: 'valid', reason: '' },
                providerParts: [],
            };
        },
        _createAgentToolRequest(toolCall) {
            createdRequests.push(toolCall);
            return { id: toolCall.id, name: toolCall.name, input: toolCall.input };
        },
        async _runAgentToolRequest(request, _responseText, _conversation, runtimeMessages) {
            runRequests.push(request);
            runtimeMessages.push({
                role: 'tool',
                content: 'ok',
                toolCallId: request.id,
                toolName: request.name,
            });
            return true;
        },
        _conversations: {
            appendMessage(_conversationId, message) {
                systemMessages.push(message);
            },
        },
        _addMessageIfActiveConversation() {},
    };

    return {
        window,
        providerCalls,
        createdRequests,
        runRequests,
        systemMessages,
        assistantViewState: { view, workingStartedAt: 0 },
    };
}

const integrityRecoveryCases = [{
    name: 'malformed',
    integrity: { status: 'malformed', reason: 'invalid_tool_arguments' },
    invalidCallGuidance: ['malformed JSON', 'complete, valid JSON arguments'],
    siblingGuidance: ['another call in the same batch was incomplete', 'reissue every required call'],
}, {
    name: 'truncated',
    integrity: truncatedIntegrity,
    invalidCallGuidance: ['cut off by the output limit', 'smaller payload or split the work'],
    siblingGuidance: ['another call in the same batch was incomplete', 'reissue every required call'],
}, {
    name: 'output_limited',
    integrity: { status: 'output_limited', reason: 'max_output' },
    invalidCallGuidance: ['reached the output limit', 'smaller payload or split the work'],
    siblingGuidance: ['reached the output limit', 'smaller payload or split the work'],
}];

for (const recoveryCase of integrityRecoveryCases) {
    const recoveredText = `Recovered from ${recoveryCase.name}.`;
    const recoveredIntegrityRun = createAgentIntegrityWindow([
        {
            text: '',
            reasoning: '',
            toolCalls: invalidNativeBatch,
            toolCallIntegrity: recoveryCase.integrity,
            providerParts: [],
        },
        {
            text: recoveredText,
            reasoning: '',
            toolCalls: [],
            toolCallIntegrity: { status: 'valid', reason: '' },
            providerParts: [],
        },
    ]);
    const recoveredIntegrityText = await CuscoWindow.prototype._runAgentModeResponse.call(
        recoveredIntegrityRun.window,
        { id: `conversation-integrity-${recoveryCase.name}` },
        [{ role: 'user', content: 'Create the artifact' }],
        recoveredIntegrityRun.assistantViewState,
        null,
    );
    const rejectedBatchResults = (recoveredIntegrityRun.providerCalls[1] ?? [])
        .filter((message) => message.role === 'tool');

    if (recoveredIntegrityText !== recoveredText
        || recoveredIntegrityRun.providerCalls.length !== 2
        || recoveredIntegrityRun.createdRequests.length !== 0
        || recoveredIntegrityRun.runRequests.length !== 0
        || rejectedBatchResults.length !== 2
        || rejectedBatchResults[0].toolCallId !== 'call-invalid-json'
        || rejectedBatchResults[0].toolName !== 'artifact_create'
        || rejectedBatchResults[1].toolCallId !== 'call-valid-sibling'
        || rejectedBatchResults[1].toolName !== 'calc'
        || recoveryCase.invalidCallGuidance.some(
            guidance => !rejectedBatchResults[0].content.includes(guidance),
        )
        || recoveryCase.siblingGuidance.some(
            guidance => !rejectedBatchResults[1].content.includes(guidance),
        )) {
        throw new Error(`${recoveryCase.name} native batch did not recover exactly once without tool side effects`);
    }

    const repeatedIntegrityRun = createAgentIntegrityWindow([
        {
            text: '',
            reasoning: '',
            toolCalls: invalidNativeBatch,
            toolCallIntegrity: recoveryCase.integrity,
            providerParts: [],
        },
        {
            text: '',
            reasoning: '',
            toolCalls: invalidNativeBatch,
            toolCallIntegrity: recoveryCase.integrity,
            providerParts: [],
        },
        {
            text: 'This response must not be requested.',
            reasoning: '',
            toolCalls: [],
            toolCallIntegrity: { status: 'valid', reason: '' },
            providerParts: [],
        },
    ]);
    const repeatedIntegrityText = await CuscoWindow.prototype._runAgentModeResponse.call(
        repeatedIntegrityRun.window,
        { id: `conversation-integrity-repeat-${recoveryCase.name}` },
        [{ role: 'user', content: 'Create the artifact' }],
        repeatedIntegrityRun.assistantViewState,
        null,
    );

    if (repeatedIntegrityRun.providerCalls.length !== 2
        || repeatedIntegrityRun.createdRequests.length !== 0
        || repeatedIntegrityRun.runRequests.length !== 0
        || repeatedIntegrityRun.systemMessages.length !== 1
        || repeatedIntegrityText !== repeatedIntegrityRun.systemMessages[0].content
        || !repeatedIntegrityText.includes('repeatedly')) {
        throw new Error(`Repeated ${recoveryCase.name} native batch did not stop deterministically`);
    }
}

const finalIterationResponses = Array.from(
    { length: DEFAULT_AGENT_MAX_ITERATIONS - 1 },
    (_value, index) => ({
        text: '',
        reasoning: '',
        toolCalls: [{
            id: `call-valid-${index}`,
            name: 'calc',
            input: '2 + 2',
            argumentsValid: true,
        }],
        toolCallIntegrity: { status: 'valid', reason: '' },
        providerParts: [],
    }),
);
finalIterationResponses.push(
    {
        text: '',
        reasoning: '',
        toolCalls: invalidNativeBatch,
        toolCallIntegrity: truncatedIntegrity,
        providerParts: [],
    },
    {
        text: 'Recovered on the dedicated slot.',
        reasoning: '',
        toolCalls: [],
        toolCallIntegrity: { status: 'valid', reason: '' },
        providerParts: [],
    },
);
const finalIterationRun = createAgentIntegrityWindow(finalIterationResponses);
const finalIterationText = await CuscoWindow.prototype._runAgentModeResponse.call(
    finalIterationRun.window,
    { id: 'conversation-integrity-final-slot' },
    [{ role: 'user', content: 'Use tools repeatedly' }],
    finalIterationRun.assistantViewState,
    null,
);

if (finalIterationText !== 'Recovered on the dedicated slot.'
    || finalIterationRun.providerCalls.length !== DEFAULT_AGENT_MAX_ITERATIONS + 1
    || finalIterationRun.createdRequests.length !== DEFAULT_AGENT_MAX_ITERATIONS - 1) {
    throw new Error('Integrity recovery did not retain a slot after the final ordinary iteration');
}

print('Cusco Agent Mode smoke passed');
