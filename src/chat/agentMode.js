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
    const hasAskUser = (tools ?? []).some(tool => tool?.name === 'ask_user');
    const askUserInstruction = hasAskUser
        ? 'When required information or a user choice is missing, call ask_user instead of asking in ordinary assistant text. Ask only the questions needed to continue.'
        : '';
    const computerUseInstruction = hasComputerStep
        ? [
            'For computer use, prefer computer_step after the initial observation. Attached computer screenshots may contain a synthetic coordinate grid that is not part of the application. Coordinates are normalized from 0 to 1000 and computer_step returns the post-action screenshot.',
            'Before coordinate input, computer_step passively verifies that the referenced UI is still visible and focused. If it reports a stale_observation, no coordinate action was dispatched: replan from the attached fresh screenshot and its new observationId.',
            hasAskUser
                ? 'Before using Google Chrome or Chromium, inspect its visible profile picker or profile menu when the user has not already named a profile. If multiple Chrome or Chromium profiles are available, call ask_user with their visible names and wait for the choice. Never guess, silently select, or switch a Chrome profile.'
                : '',
            hasComputerAct
                ? 'Whenever you open or launch an app, first call computer_act with create_workspace and remember the returned workspaceIndex. Launch the app while that new workspace is active; global type and keypress actions may omit windowId. Then call computer_list, move the new window to that workspace with move_to_workspace if necessary, and maximize it when canMaximize is true. If a new workspace cannot be created, do not silently launch the app in an occupied workspace.'
                : '',
            hasComputerRegion
                ? 'For a small visual target, an uncertain point, or a blocked coordinate retry, call computer_observe_region and then use the returned region observation ID. Region coordinates are local; do not manually add its offset.'
                : '',
            'Menus, dropdowns, popovers, and disclosure controls are stateful: click the trigger once, inspect the returned screenshot, then select the visible option from that new state. Do not reopen the trigger or switch to developer tools while the intended option is visible.',
            'For text input without semantic set_text_element, prefer native paste_text over direct simulated typing. paste_text copies the complete value to the clipboard and pastes it in one action. Use type only for sensitive values that should not enter clipboard history, when clipboard paste is unavailable, or when the target rejects pasted input.',
            'Prefer deterministic keyboard actions and semantic set_text_element over pixel clicks. When accessibility is unavailable, fill a visual text field with one computer_step paste_text action containing x, y, and text so focus and input are dispatched atomically; use type with the same fields for the documented fallbacks. Add replace:true when the field already contains text; Cusco will focus it, select all, and paste or type within one Shell request. Do not use other explicit click and keyboard batches; click and inspect before later keyboard input. Inspect verification and the returned screenshot after input. When a known payload was deterministically typed or pasted into the intended field, the field is visibly nonempty, and the application shows no error, continue without visually comparing every character. Long opaque values such as wallet addresses, IDs, hashes, and URLs may horizontally scroll and hide their prefix. Never repair individual characters based only on visual comparison; retry the complete value only if the field is empty, the wrong control changed, the application rejects it, or machine-readable readback mismatches.',
            'When a focused search field shows a result list and the intended item is first, prefer keypress Down followed by Return instead of estimating a row coordinate.',
            'When a coordinate click selects a named item or navigates to another view, include an expect entry for the intended post-action label or state. Treat a coordinate click without a matching expectation as unverified.',
            'coordinateActionVerified null with visualConfirmationRequired true means semantic verification was unavailable, not that the action failed. Continue when the returned screenshot visibly shows the intended state. If a step reports stalled, an explicit expectation fails, preAction.matched is false, text lands in browser chrome instead of the intended field, or the screenshot shows a miss, do not retry the same target or coordinates. Change strategy, using the fresh observation, accessibility, atomic coordinate typing, or Tab navigation. Do not claim completion until the requested final state is visibly verified.',
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
        askUserInstruction,
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
        'If the reason identifies correctable tool input, correct the request and retry. Do not retry an unchanged request or a permission denial. Otherwise continue with the available information or ask the user for a narrower request.',
    ].join('\n');
}

export function createAgentToolRuntimeMessages(
    request,
    responseText,
    transcriptText,
    {
        attachments = [],
        failed = false,
        nativeToolCall = null,
    } = {},
) {
    const assistantMessage = {
        role: 'assistant',
        content: String(responseText ?? ''),
    };
    const resultText = String(transcriptText ?? '');

    if (nativeToolCall) {
        return [
            {
                ...assistantMessage,
                toolCalls: [nativeToolCall],
            },
            {
                role: 'tool',
                content: failed
                    ? createAgentToolFailurePrompt(request, resultText)
                    : resultText,
                toolCallId: nativeToolCall.id,
                toolName: nativeToolCall.name ?? request?.name,
                attachments,
            },
        ];
    }

    return [
        assistantMessage,
        {
            role: 'user',
            content: failed
                ? createAgentToolFailurePrompt(request, resultText)
                : createAgentToolResultPrompt(request, resultText),
            attachments,
        },
    ];
}

export function createNativeToolRuntimeBatch(responseText, nativeToolCalls, runtimeMessages) {
    const toolCalls = Array.isArray(nativeToolCalls)
        ? nativeToolCalls.filter((call) => String(call?.name ?? '').trim())
        : [];

    if (toolCalls.length === 0)
        return [...(runtimeMessages ?? [])];

    return [
        {
            role: 'assistant',
            content: String(responseText ?? ''),
            toolCalls,
        },
        ...(runtimeMessages ?? []).filter((message) => message?.role !== 'assistant'),
    ];
}

export function isPartialAgentToolCall(text) {
    const source = String(text ?? '').toLowerCase();
    return source.includes(TOOL_CALL_OPEN_TAG) && !source.includes(TOOL_CALL_CLOSE_TAG);
}
