const TOOL_DISPLAY_PRESETS = {
    bash: {
        label: 'Bash',
        actions: {
            running: 'Running command',
            completed: 'Ran command',
            failed: 'Command failed',
            cancelled: 'Command stopped',
        },
    },
    file_list: {
        label: 'File List',
        actions: {
            running: 'Listing files',
            completed: 'Listed files',
            failed: 'File listing failed',
            cancelled: 'File listing stopped',
        },
    },
    file_read: {
        label: 'File Read',
        actions: {
            running: 'Reading file',
            completed: 'Read file',
            failed: 'File read failed',
            cancelled: 'File read stopped',
        },
    },
    search: {
        label: 'Web Search',
        actions: {
            running: 'Searching web',
            completed: 'Searched web',
            failed: 'Search failed',
            cancelled: 'Search stopped',
        },
    },
    calc: {
        label: 'Calculator',
        actions: {
            running: 'Calculating',
            completed: 'Calculated',
            failed: 'Calculation failed',
            cancelled: 'Calculation stopped',
        },
    },
    data: {
        label: 'Structured Data',
        actions: {
            running: 'Summarizing data',
            completed: 'Summarized data',
            failed: 'Data summary failed',
            cancelled: 'Data summary stopped',
        },
    },
    image_gen: {
        label: 'Image Generation',
        actions: {
            running: 'Generating image',
            completed: 'Generated image',
            failed: 'Image generation failed',
            cancelled: 'Image generation stopped',
        },
    },
};

const FALLBACK_DISPLAY = {
    label: 'Tool',
    actions: {
        running: 'Running tool',
        completed: 'Tool result',
        failed: 'Tool failed',
        cancelled: 'Tool stopped',
    },
};

export const TOOL_OUTPUT_PREVIEW_MAX_LINES = 3;
export const TOOL_OUTPUT_PREVIEW_MAX_CHARS = 12000;

function normalizeStatus(status) {
    if (status === 'running' || status === 'failed' || status === 'cancelled')
        return status;

    return 'completed';
}

function normalizeString(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function toolName(toolCall) {
    return normalizeString(toolCall?.name);
}

function toolPreset(name) {
    return TOOL_DISPLAY_PRESETS[name] ?? FALLBACK_DISPLAY;
}

function statusLabel(status) {
    if (status === 'running')
        return 'running';

    if (status === 'failed')
        return 'failed';

    if (status === 'cancelled')
        return 'cancelled';

    return 'done';
}

function targetForTool(name, toolCall) {
    if (name === 'bash')
        return normalizeString(toolCall?.command, normalizeString(toolCall?.input));

    if (name === 'file_list' || name === 'file_read')
        return normalizeString(toolCall?.path, normalizeString(toolCall?.input));

    if (name === 'search')
        return normalizeString(toolCall?.query, normalizeString(toolCall?.input));

    if (name === 'image_gen')
        return normalizeString(toolCall?.prompt, normalizeString(toolCall?.input));

    return normalizeString(toolCall?.target, normalizeString(toolCall?.input));
}

function detailForTool(name, toolCall) {
    if (name === 'bash') {
        if (toolCall?.exitStatus !== undefined && toolCall?.exitStatus !== null) {
            const suffixes = [
                toolCall.timedOut ? 'timed out' : '',
                toolCall.cancelled ? 'cancelled' : '',
            ].filter(Boolean);

            return `exit ${toolCall.exitStatus}${suffixes.length ? ` (${suffixes.join(', ')})` : ''}`;
        }

        return '';
    }

    if (name === 'file_read' && toolCall?.size !== undefined && toolCall?.size !== null)
        return `${toolCall.size} bytes${toolCall.truncated ? ' (truncated)' : ''}`;

    if (name === 'search' && Array.isArray(toolCall?.results))
        return `${toolCall.results.length} result${toolCall.results.length === 1 ? '' : 's'}`;

    if (name === 'image_gen')
        return normalizeString(toolCall?.detail, [
            normalizeString(toolCall?.providerName, normalizeString(toolCall?.providerId)),
            normalizeString(toolCall?.modelId),
        ].filter(Boolean).join(' · '));

    return normalizeString(toolCall?.detail);
}

export function latestOutputLines(text, maxLines = TOOL_OUTPUT_PREVIEW_MAX_LINES) {
    const lineLimit = Math.max(1, Math.round(maxLines));
    const lines = String(text ?? '').replace(/\r/g, '').split('\n');
    return lines.slice(-lineLimit).join('\n');
}

export function appendToolOutputPreview(current, chunk, maxChars = TOOL_OUTPUT_PREVIEW_MAX_CHARS) {
    const combined = `${String(current ?? '')}${String(chunk ?? '')}`;

    if (combined.length <= maxChars)
        return combined;

    return combined.slice(combined.length - maxChars);
}

export function getToolOutputPreview(toolCall) {
    if (toolCall?.name !== 'bash')
        return '';

    const preview = normalizeString(toolCall.outputPreview);

    if (preview)
        return preview;

    return [
        normalizeString(toolCall.stdout),
        normalizeString(toolCall.stderr),
    ].filter(Boolean).join('\n');
}

export function normalizeToolCallDisplay(toolCall = {}) {
    const name = toolName(toolCall);
    const preset = toolPreset(name);
    const status = normalizeStatus(toolCall.status);
    const label = normalizeString(toolCall.label, preset.label);
    const target = targetForTool(name, toolCall);

    return {
        name,
        label,
        status,
        statusLabel: statusLabel(status),
        action: preset.actions[status] ?? FALLBACK_DISPLAY.actions[status],
        target,
        detail: detailForTool(name, toolCall),
        command: name === 'bash' ? target : '',
        outputPreview: getToolOutputPreview(toolCall),
        isBash: name === 'bash',
    };
}

export function createToolCallFromRequest(request, options = {}) {
    const status = normalizeStatus(options.status ?? 'running');

    return {
        name: normalizeString(request?.name),
        label: normalizeString(request?.label, toolPreset(request?.name).label),
        input: String(request?.input ?? ''),
        output: '',
        outputPreview: '',
        results: [],
        status,
        agentMode: Boolean(options.agentMode),
        createdAt: options.createdAt ?? new Date().toISOString(),
    };
}

export function createToolCallFromResult(result, options = {}) {
    const status = normalizeStatus(options.status ?? (result?.cancelled ? 'cancelled' : 'completed'));
    const base = createToolCallFromRequest(result, {
        status,
        agentMode: options.agentMode,
        createdAt: options.createdAt ?? result?.createdAt,
    });

    return {
        ...base,
        output: String(result?.output ?? ''),
        outputPreview: String(options.outputPreview ?? result?.outputPreview ?? ''),
        results: Array.isArray(result?.results) ? result.results : [],
        path: result?.path ?? '',
        query: result?.query ?? '',
        command: result?.command ?? '',
        stdout: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
        stdoutTruncated: Boolean(result?.stdoutTruncated),
        stderrTruncated: Boolean(result?.stderrTruncated),
        exitStatus: result?.exitStatus ?? null,
        timedOut: Boolean(result?.timedOut),
        cancelled: Boolean(result?.cancelled),
        size: result?.size ?? null,
        truncated: Boolean(result?.truncated),
        prompt: result?.prompt ?? '',
        providerId: result?.providerId ?? '',
        providerName: result?.providerName ?? '',
        modelId: result?.modelId ?? '',
        modelName: result?.modelName ?? '',
        imagePath: result?.imagePath ?? '',
        mimeType: result?.mimeType ?? '',
        detail: result?.detail ?? '',
        completedAt: options.completedAt ?? new Date().toISOString(),
    };
}

export function createToolCallFromFailure(request, reason, options = {}) {
    return {
        ...createToolCallFromRequest(request, {
            status: options.status ?? 'failed',
            agentMode: options.agentMode,
            createdAt: options.createdAt,
        }),
        output: String(reason ?? ''),
        outputPreview: String(options.outputPreview ?? ''),
        completedAt: options.completedAt ?? new Date().toISOString(),
    };
}
