export const DEFAULT_AGENT_MAX_ITERATIONS = 6;

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

export function buildAgentModeSystemPrompt(tools, { maxIterations = DEFAULT_AGENT_MAX_ITERATIONS } = {}) {
    const toolList = (tools ?? []).map(formatToolForPrompt).join('\n\n') || 'No tools are available.';

    return [
        'Agent Mode is enabled for this chat.',
        'You may solve the user request normally, or request one available tool when a tool result would materially help.',
        'Do not invent tool results. Do not request a tool unless the tool is listed below.',
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
        parseError.userMessage = 'Agent Mode produced an invalid tool request.';
        throw parseError;
    }

    const name = String(parsed.name ?? parsed.tool ?? '').trim();

    if (!name) {
        const error = new Error('Agent tool call is missing a tool name.');
        error.userMessage = 'Agent Mode produced a tool request without a tool name.';
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
