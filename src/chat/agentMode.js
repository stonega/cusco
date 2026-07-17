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
    nativeToolCalling = false,
} = {}) {
    const toolList = (tools ?? []).map(formatToolForPrompt).join('\n\n') || 'No tools are available.';
    const nativeSearchInstruction = nativeSearchTools.length > 0
        ? `Provider-managed search tools are enabled: ${nativeSearchTools.join(', ')}. Use them directly for current web or social information; do not request a Cusco search tool.`
        : '';
    const toolProtocol = nativeToolCalling
        ? [
            'Use the provider native function-calling interface whenever you need a tool.',
            'Do not write XML tool tags, function-call JSON, or tool narration as ordinary assistant text.',
        ]
        : [
            'When you need a tool, respond with exactly one tool call and no other text:',
            `${TOOL_CALL_OPEN_TAG}{"name":"tool_name","input":"tool input"}${TOOL_CALL_CLOSE_TAG}`,
        ];
    const hasComputerStep = (tools ?? []).some(tool => tool?.name === 'computer_step');
    const hasComputerAct = (tools ?? []).some(tool => tool?.name === 'computer_act');
    const hasComputerRegion = (tools ?? []).some(tool => tool?.name === 'computer_observe_region');
    const computerUseInstruction = hasComputerStep
        ? [
            'For computer use, prefer computer_step after the initial observation. Attached computer screenshots may contain a synthetic coordinate grid that is not part of the application. Coordinates are normalized from 0 to 1000 and computer_step returns the post-action screenshot.',
            hasComputerAct
                ? 'Whenever you open or launch an app, first call computer_act with create_workspace and remember the returned workspaceIndex. Launch the app while that new workspace is active; global type and keypress actions may omit windowId. Then call computer_list, move the new window to that workspace with move_to_workspace if necessary, and maximize it when canMaximize is true. If a new workspace cannot be created, do not silently launch the app in an occupied workspace.'
                : '',
            hasComputerRegion
                ? 'For a small visual target, an uncertain point, or a blocked coordinate retry, call computer_observe_region and then use the returned region observation ID. Region coordinates are local; do not manually add its offset.'
                : '',
            'Prefer deterministic keyboard actions over pixel clicks. Never assume typing or clicking succeeded: inspect verification and the returned screenshot. Never batch a coordinate click with typing or key presses; click and verify first, then enter input in a separate step.',
            'When a focused search field shows a result list and the intended item is first, prefer keypress Down followed by Return instead of estimating a row coordinate.',
            'When a coordinate click selects a named item or navigates to another view, include an expect entry for the intended post-action label or state. Treat a coordinate click without a matching expectation as unverified.',
            'If a step reports stalled, do not retry the same target or coordinates. Change strategy. Do not claim completion until the requested final state is visibly verified.',
            hasComputerAct
                ? 'Before giving the user your final response, whether the task succeeded or failed, always make your last computer-use action focus the Cusco app. Use computer_list to find the Cusco window first if needed, then call computer_act with focus for that window.'
                : '',
        ].filter(Boolean).join(' ')
        : '';

    return [
        'Agent is enabled for this chat.',
        'You may solve the user request normally, or request one available tool when a tool result would materially help.',
        nativeSearchInstruction,
        'Do not invent tool results. Do not request a tool unless the tool is listed below.',
        'Tools whose names start with mcp__ are configured MCP server tools exposed through Cusco. If the user asks to use an MCP server such as Context7 and a matching mcp__ tool is listed, use that tool instead of saying the MCP server is not configured.',
        'For MCP tools, pass JSON matching the listed input fields. Include every required or clearly relevant field from the input description.',
        `You have at most ${maxIterations} tool-use iterations for this response.`,
        computerUseInstruction,
        '',
        ...toolProtocol,
        '',
        'After Cusco returns a tool result, continue reasoning from that result. If you have enough information, answer the user directly without a tool call.',
        '',
        'Available tools:',
        toolList,
    ].join('\n');
}

export function pruneComputerUseObservationImages(messages) {
    let removed = 0;

    for (const message of messages ?? []) {
        if (!Array.isArray(message?.attachments) || message.attachments.length === 0)
            continue;

        const content = String(message.content ?? '');
        const isNativeComputerResult = message.role === 'tool'
            && /^computer_(?:observe(?:_region)?|step)$/i.test(String(message.toolName ?? ''));

        if (!isNativeComputerResult
            && !/^Tool result for computer_(?:observe(?:_region)?|step):/i.test(content)) {
            continue;
        }

        const nextAttachments = message.attachments.filter((attachment) => {
            const shouldRemove = attachment?.kind === 'image';

            if (shouldRemove)
                removed += 1;
            return !shouldRemove;
        });

        message.attachments = nextAttachments;
    }

    return removed;
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
