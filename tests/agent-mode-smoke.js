import {
    buildAgentModeSystemPrompt,
    createAgentToolFailurePrompt,
    createAgentToolResultPrompt,
    DEFAULT_AGENT_MAX_ITERATIONS,
    formatAgentToolCall,
    isPartialAgentToolCall,
    parseAgentToolCall,
} from '../src/chat/agentMode.js';
import { createToolPermissionDecision, TOOL_PERMISSION_DENY } from '../src/tools/permissions.js';
import { ToolManager } from '../src/tools/tools.js';

const tools = new ToolManager();
const prompt = buildAgentModeSystemPrompt(tools.listTools(), { maxIterations: 2 });
const defaultPrompt = buildAgentModeSystemPrompt(tools.listTools());

if (DEFAULT_AGENT_MAX_ITERATIONS < 100
    || !defaultPrompt.includes(`at most ${DEFAULT_AGENT_MAX_ITERATIONS} tool-use iterations`)) {
    throw new Error(`Agent Mode max iteration default is too low: ${DEFAULT_AGENT_MAX_ITERATIONS}`);
}

if (!prompt.includes('Agent Mode is enabled')
    || !prompt.includes('calc')
    || !prompt.includes('<cusco_tool_call>')
    || !prompt.includes('mcp__')
    || !prompt.includes('MCP server tools exposed through Cusco')) {
    throw new Error('Agent Mode prompt did not describe the tool protocol');
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
