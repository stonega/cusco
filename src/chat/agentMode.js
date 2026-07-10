export const DEFAULT_AGENT_MAX_ITERATIONS = 100;

const TOOL_CALL_OPEN_TAG = '<cusco_tool_call>';
const TOOL_CALL_CLOSE_TAG = '</cusco_tool_call>';

function stringifyInput(input) {
    if (typeof input === 'string')
        return input;

    if (input === null || input === undefined)
        return '';

    return JSON.stringify(input);
}

function formatToolForPrompt(tool) {
    return [
        `- ${tool.name}: ${tool.label}`,
        tool.description ? `  Description: ${tool.description}` : '',
        tool.inputDescription ? `  Input: ${tool.inputDescription}` : '',
        `  Permission: ${tool.permissionPolicy ?? (tool.requiresPermission ? 'ask' : 'allow')}`,
    ].filter(Boolean).join('\n');
}

export function buildAgentModeSystemPrompt(tools, {
    maxIterations = DEFAULT_AGENT_MAX_ITERATIONS,
    nativeSearchTools = [],
} = {}) {
    const toolList = (tools ?? []).map(formatToolForPrompt).join('\n\n') || 'No tools are available.';
    const nativeSearchInstruction = nativeSearchTools.length > 0
        ? `Provider-managed search tools are enabled: ${nativeSearchTools.join(', ')}. Use them directly for current web or social information; do not request a Cusco search tool.`
        : '';

    return [
        'Agent is enabled for this chat.',
        'You may solve the user request normally, or request one available tool when a tool result would materially help.',
        nativeSearchInstruction,
        'Do not invent tool results. Do not request a tool unless the tool is listed below.',
        'Tools whose names start with mcp__ are configured MCP server tools exposed through Cusco. If the user asks to use an MCP server such as Context7 and a matching mcp__ tool is listed, use that tool instead of saying the MCP server is not configured.',
        'For MCP tools, pass JSON matching the listed input fields. Include every required or clearly relevant field from the input description.',
        `You have at most ${maxIterations} tool-use iterations for this response.`,
        '',
        'When you need a tool, respond with exactly one tool call and no other text:',
        `${TOOL_CALL_OPEN_TAG}{"name":"tool_name","input":"tool input"}${TOOL_CALL_CLOSE_TAG}`,
        '',
        'After Cusco returns a tool result, continue reasoning from that result. If you have enough information, answer the user directly without a tool call.',
        '',
        'Available tools:',
        toolList,
    ].join('\n');
}

export function formatAgentToolCall(toolCall) {
    return `${TOOL_CALL_OPEN_TAG}${JSON.stringify({
        name: toolCall?.name ?? '',
        input: toolCall?.input ?? '',
    })}${TOOL_CALL_CLOSE_TAG}`;
}

export function parseAgentToolCall(text) {
    const source = String(text ?? '');
    const match = source.match(/<cusco_tool_call>\s*([\s\S]*?)\s*<\/cusco_tool_call>/i);

    if (!match)
        return null;

    let parsed;

    try {
        parsed = JSON.parse(match[1]);
    } catch (error) {
        const parseError = new Error(`Agent tool call JSON is invalid: ${error.message}`);
        parseError.userMessage = 'Agent produced an invalid tool request.';
        throw parseError;
    }

    const name = String(parsed.name ?? parsed.tool ?? '').trim();

    if (!name) {
        const error = new Error('Agent tool call is missing a tool name.');
        error.userMessage = 'Agent produced a tool request without a tool name.';
        throw error;
    }

    return {
        name,
        input: stringifyInput(parsed.input),
        raw: match[0],
    };
}

export function createAgentToolResultPrompt(request, transcriptText) {
    return [
        `Tool result for ${request.name}:`,
        transcriptText,
        '',
        'Use this result to continue. Request another tool only if needed; otherwise answer the user directly.',
    ].join('\n');
}

export function createAgentToolFailurePrompt(request, reason) {
    return [
        `Tool ${request?.name ?? 'unknown'} could not be run.`,
        `Reason: ${reason}`,
        '',
        'Continue with the available information or ask the user for a narrower request.',
    ].join('\n');
}

export function isPartialAgentToolCall(text) {
    const source = String(text ?? '').toLowerCase();
    return source.includes(TOOL_CALL_OPEN_TAG) && !source.includes(TOOL_CALL_CLOSE_TAG);
}
