const MODEL_VISIBLE_TEXT_LIMIT = 10000;

function isRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function limitText(value) {
    const text = String(value ?? '');

    if (text.length <= MODEL_VISIBLE_TEXT_LIMIT)
        return text;

    const edge = Math.floor((MODEL_VISIBLE_TEXT_LIMIT - 48) / 2);
    return `${text.slice(0, edge)}\n[Hook output truncated by Cusco]\n${text.slice(-edge)}`;
}

function outputObject(run) {
    const text = String(run.stdout ?? '').trim();

    if (!text)
        return { value: null, plainText: '', error: '' };

    try {
        const parsed = JSON.parse(text);

        if (!isRecord(parsed))
            return { value: null, plainText: '', error: 'Hook JSON output must be an object.' };

        return { value: parsed, plainText: '', error: '' };
    } catch (error) {
        return { value: null, plainText: text, error: error.message };
    }
}

function exitTwoDecision(eventName, run) {
    if (run.exitStatus !== 2)
        return null;

    const reason = limitText(String(run.stderr ?? '').trim() || 'Hook blocked the operation.');

    if (['PreToolUse', 'UserPromptSubmit'].includes(eventName))
        return { blocked: true, reason };

    if (eventName === 'PostToolUse')
        return { feedback: reason, stopNormalProcessing: true };

    if (eventName === 'Stop')
        return { continuationReason: reason };

    return { failure: `Exit code 2 is not supported for ${eventName}.` };
}

function commonFields(eventName, value, result) {
    if (typeof value?.systemMessage === 'string' && value.systemMessage.trim())
        result.systemMessages.push(limitText(value.systemMessage.trim()));

    if (value?.continue === false) {
        if ([
            'SessionStart',
            'PostToolUse',
            'PreCompact',
            'PostCompact',
            'UserPromptSubmit',
            'Stop',
        ].includes(eventName)) {
            result.continue = false;
            result.stopReason = limitText(String(value.stopReason ?? '').trim());
        } else {
            result.failures.push(`${eventName} does not support continue or stopReason.`);
        }
    }

    if (value?.suppressOutput !== undefined)
        result.failures.push(`${eventName} does not currently support suppressOutput.`);
}

function additionalContext(value, eventName) {
    const output = value?.hookSpecificOutput;

    if (!isRecord(output) || output.hookEventName !== eventName)
        return '';

    return limitText(String(output.additionalContext ?? '').trim());
}

function applyEventOutput(eventName, value, result) {
    commonFields(eventName, value, result);
    const context = additionalContext(value, eventName);

    if (context)
        result.additionalContext.push(context);

    switch (eventName) {
    case 'PreToolUse': {
        const output = value?.hookSpecificOutput;

        if (value?.decision === 'block') {
            result.blocked = true;
            result.reason = limitText(String(value.reason ?? '').trim() || 'Tool call blocked by hook.');
        }

        if (isRecord(output) && output.hookEventName === eventName) {
            if (output.permissionDecision === 'deny') {
                result.blocked = true;
                result.reason = limitText(
                    String(output.permissionDecisionReason ?? '').trim()
                        || 'Tool call blocked by hook.',
                );
            } else if (output.permissionDecision === 'allow' && isRecord(output.updatedInput)) {
                result.updatedInput = output.updatedInput;
                result.updatedInputCount += 1;
            } else if (output.permissionDecision === 'ask') {
                result.failures.push('PreToolUse does not currently support permissionDecision "ask".');
            } else if (output.updatedInput !== undefined) {
                result.failures.push('PreToolUse updatedInput requires permissionDecision "allow".');
            }
        }

        if (value?.decision === 'approve')
            result.failures.push('PreToolUse does not currently support legacy decision "approve".');
        break;
    }
    case 'PermissionRequest': {
        const decision = value?.hookSpecificOutput?.decision;

        if (isRecord(decision) && decision.behavior === 'deny') {
            result.permissionDecision = 'deny';
            result.reason = limitText(String(decision.message ?? '').trim() || 'Permission denied by hook.');
        } else if (isRecord(decision)
            && decision.behavior === 'allow'
            && result.permissionDecision !== 'deny') {
            result.permissionDecision = 'allow';
        }

        for (const field of ['updatedInput', 'updatedPermissions', 'interrupt']) {
            if (value?.hookSpecificOutput?.[field] !== undefined)
                result.failures.push(`PermissionRequest does not currently support ${field}.`);
        }
        break;
    }
    case 'PostToolUse':
        if (value?.decision === 'block') {
            result.stopNormalProcessing = true;
            result.feedback.push(limitText(String(value.reason ?? '').trim() || 'Tool result blocked by hook.'));
        }
        if (value?.continue === false)
            result.stopNormalProcessing = true;
        if (value?.updatedMCPToolOutput !== undefined)
            result.failures.push('PostToolUse does not currently support updatedMCPToolOutput.');
        break;
    case 'UserPromptSubmit':
        if (value?.decision === 'block') {
            result.blocked = true;
            result.reason = limitText(String(value.reason ?? '').trim() || 'Prompt blocked by hook.');
        }
        break;
    case 'Stop':
        if (value?.decision === 'block') {
            result.continuationReasons.push(
                limitText(String(value.reason ?? '').trim() || 'Continue the response.'),
            );
        }
        break;
    default:
        break;
    }
}

export function reduceHookRuns(eventName, runs) {
    const result = {
        eventName,
        runs,
        additionalContext: [],
        systemMessages: [],
        failures: [],
        blocked: false,
        reason: '',
        continue: true,
        stopReason: '',
        updatedInput: null,
        updatedInputCount: 0,
        permissionDecision: '',
        stopNormalProcessing: false,
        feedback: [],
        continuationReasons: [],
        shouldContinue: false,
    };

    for (const run of runs) {
        if (run.cancelled) {
            result.failures.push('Hook was cancelled.');
            continue;
        }

        if (run.timedOut) {
            result.failures.push('Hook timed out.');
            continue;
        }

        const exitDecision = exitTwoDecision(eventName, run);

        if (exitDecision) {
            if (exitDecision.failure)
                result.failures.push(exitDecision.failure);
            if (exitDecision.blocked) {
                result.blocked = true;
                result.reason = exitDecision.reason;
            }
            if (exitDecision.feedback) {
                result.feedback.push(exitDecision.feedback);
                result.stopNormalProcessing = exitDecision.stopNormalProcessing;
            }
            if (exitDecision.continuationReason)
                result.continuationReasons.push(exitDecision.continuationReason);
            continue;
        }

        if (run.exitStatus !== 0) {
            result.failures.push(limitText(
                String(run.stderr ?? '').trim() || `Hook exited with status ${run.exitStatus}.`,
            ));
            continue;
        }

        const parsed = outputObject(run);

        if (parsed.value) {
            applyEventOutput(eventName, parsed.value, result);
            if (run.stdoutPath && [
                'SessionStart',
                'PreToolUse',
                'PostToolUse',
                'UserPromptSubmit',
                'Stop',
            ].includes(eventName)) {
                result.additionalContext.push(`Full hook output: ${run.stdoutPath}`);
            }
            continue;
        }

        if (parsed.plainText && ['SessionStart', 'UserPromptSubmit'].includes(eventName)) {
            result.additionalContext.push(limitText(parsed.plainText));
            if (run.stdoutPath)
                result.additionalContext.push(`Full hook output: ${run.stdoutPath}`);
        } else if (parsed.plainText && eventName === 'Stop') {
            result.failures.push('Stop expects JSON hook output.');
        } else if (parsed.plainText) {
            // Plain stdout is ignored for events that do not accept context text.
        } else if (parsed.error) {
            result.failures.push(`Invalid hook JSON output: ${parsed.error}`);
        }
    }

    if (result.updatedInputCount > 1)
        result.failures.push('Multiple hooks rewrote the tool input; the last configured rewrite was used.');

    result.shouldContinue = eventName === 'Stop'
        && result.continue !== false
        && result.continuationReasons.length > 0;
    return result;
}
