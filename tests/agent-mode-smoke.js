import {
    buildAgentModeSystemPrompt,
    createAgentToolFailurePrompt,
    createAgentToolResultPrompt,
    DEFAULT_AGENT_MAX_ITERATIONS,
    formatAgentToolCall,
    isPartialAgentToolCall,
    parseAgentToolCall,
    pruneComputerUseObservationImages,
} from '../src/chat/agentMode.js';
import { createToolPermissionDecision, TOOL_PERMISSION_DENY } from '../src/tools/permissions.js';
import { createAskUserTool } from '../src/tools/askUser.js';
import { ToolManager } from '../src/tools/tools.js';

const tools = new ToolManager();
const prompt = buildAgentModeSystemPrompt(tools.listTools(), { maxIterations: 2 });
const defaultPrompt = buildAgentModeSystemPrompt(tools.listTools());
const nativeSearchPrompt = buildAgentModeSystemPrompt(
    tools.listTools().filter((tool) => tool.name !== 'search'),
    { nativeSearchTools: ['web_search', 'x_search'] },
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

if (!nativeSearchPrompt.includes('Provider-managed search tools are enabled: web_search, x_search')
    || nativeSearchPrompt.includes('- search: Web Search')) {
    throw new Error('Agent Mode prompt did not route search to provider-managed tools');
}

if (!nativeToolPrompt.includes('native function-calling interface')
    || !nativeToolPrompt.includes('call ask_user instead of asking in ordinary assistant text')
    || !nativeToolPrompt.includes('prefer computer_step')
    || !nativeToolPrompt.includes('first call computer_act with create_workspace')
    || !nativeToolPrompt.includes('maximize it when canMaximize is true')
    || !nativeToolPrompt.includes('prefer keypress Down followed by Return')
    || !nativeToolPrompt.includes('include an expect entry')
    || !nativeToolPrompt.includes('coordinate click without a matching expectation as unverified')
    || !nativeToolPrompt.includes('call computer_observe_region')
    || !nativeToolPrompt.includes('one computer_step type action containing x, y, and text')
    || !nativeToolPrompt.includes('Add replace:true when the field already contains text')
    || !nativeToolPrompt.includes('click and inspect before later keyboard input')
    || !nativeToolPrompt.includes('when inputVerified is null')
    || !nativeToolPrompt.includes('complete value')
    || !nativeToolPrompt.includes('text lands in browser chrome')
    || !nativeToolPrompt.includes('synthetic coordinate grid')
    || !nativeToolPrompt.includes('whether the task succeeded or failed')
    || !nativeToolPrompt.includes('last computer-use action focus the Cusco app')
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

print('Cusco Agent Mode smoke passed');
