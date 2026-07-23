import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { HookAuditStore } from '../src/hooks/auditStore.js';
import {
    canonicalHookToolName,
    discoverHookSources,
    hookMatcherMatches,
    workspaceHooksPath,
} from '../src/hooks/config.js';
import { HookManager } from '../src/hooks/manager.js';
import { reduceHookRuns } from '../src/hooks/protocol.js';
import { runHookCommand } from '../src/hooks/runner.js';
import { HookTrustStore } from '../src/hooks/trustStore.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function writeJson(path, value) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(stdout, options = {}) {
    return {
        exitStatus: options.exitStatus ?? 0,
        stdout,
        stderr: options.stderr ?? '',
        timedOut: Boolean(options.timedOut),
        cancelled: Boolean(options.cancelled),
        durationMs: 1,
    };
}

const root = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-hooks-${GLib.uuid_string_random()}`,
]);
const userHooksPath = GLib.build_filenamev([root, 'config', 'hooks.json']);
const workingDirectory = GLib.build_filenamev([root, 'workspace']);
const workspacePath = workspaceHooksPath(workingDirectory);
const trustPath = GLib.build_filenamev([root, 'state', 'hook-state.json']);
const auditPath = GLib.build_filenamev([root, 'state', 'hook-audit.json']);
GLib.mkdir_with_parents(workingDirectory, 0o700);

writeJson(userHooksPath, {
    description: 'User hook tests',
    hooks: {
        SessionStart: [{
            matcher: 'startup|resume',
            hooks: [{ type: 'command', command: 'session-context' }],
        }],
        PreToolUse: [{
            matcher: '^Bash$',
            hooks: [
                { type: 'command', command: 'deny-tool', timeout: 5 },
                { type: 'command', command: 'rewrite-tool', timeout: 5 },
            ],
        }],
        PermissionRequest: [{
            matcher: 'Bash',
            hooks: [
                { type: 'command', command: 'allow-permission' },
                { type: 'command', command: 'deny-permission' },
            ],
        }],
        Stop: [{
            matcher: 'this matcher must be ignored',
            hooks: [
                { type: 'command', command: 'continue-stop' },
                { type: 'command', command: 'finish-stop' },
            ],
        }],
    },
});
writeJson(workspacePath, {
    hooks: {
        UserPromptSubmit: [{
            matcher: 'this matcher must also be ignored',
            hooks: [{ type: 'command', command: 'prompt-context' }],
        }],
        PostToolUse: [{
            matcher: '*',
            hooks: [{ type: 'prompt', command: 'unsupported-handler' }],
        }],
        SubagentStart: [{
            hooks: [{ type: 'command', command: 'unsupported-subagent' }],
        }],
    },
});

const sources = discoverHookSources({ userHooksPath, workingDirectory });
assert(sources.length === 2, `Expected two Cusco hook sources, got ${sources.length}`);
assert(sources[0].path === userHooksPath, 'User hook path was not used');
assert(sources[1].path === workspacePath, 'Workspace .cusco hook path was not used');
assert(sources.every((source) => !source.path.includes('/.codex/')), 'Codex hook paths must never be discovered');
assert(workspacePath.endsWith('/.cusco/hooks.json'), `Unexpected workspace hook path: ${workspacePath}`);
assert(
    discoverHookSources({ userHooksPath, workingDirectory: '' }).length === 1,
    'Workspace hooks must require an explicitly selected working directory',
);
assert(canonicalHookToolName('bash') === 'Bash', 'Bash hook alias was not normalized');

const preDefinitions = sources[0].definitions.filter((definition) => definition.eventName === 'PreToolUse');
assert(preDefinitions.length === 2, 'PreToolUse definitions were not parsed');
assert(hookMatcherMatches(preDefinitions[0], 'Bash'), 'Bash matcher did not match');
assert(!hookMatcherMatches(preDefinitions[0], 'file_read'), 'Bash matcher matched the wrong tool');
const unsupported = sources[1].definitions.find((definition) => definition.eventName === 'PostToolUse');
assert(unsupported && !unsupported.supported, 'Unsupported handler types must remain visible and skipped');
const unsupportedSubagent = sources[1].definitions.find((definition) => (
    definition.eventName === 'SubagentStart'
));
assert(unsupportedSubagent && !unsupportedSubagent.supported, 'Subagent hooks must remain visible and skipped');

const trust = new HookTrustStore({ path: trustPath });

for (const definition of sources.flatMap((source) => source.definitions)) {
    if (definition.supported)
        trust.trust(definition.fingerprint);
}

const starts = [];
const fakeRunner = async (definition) => {
    starts.push(definition.command);

    switch (definition.command) {
    case 'session-context':
        return run('Session context');
    case 'deny-tool':
        return run(JSON.stringify({
            decision: 'block',
            reason: 'Blocked by test policy.',
        }));
    case 'rewrite-tool':
        return run(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput: { command: 'echo rewritten' },
            },
        }));
    case 'allow-permission':
        return run(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: { behavior: 'allow' },
            },
        }));
    case 'deny-permission':
        return run(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: { behavior: 'deny', message: 'Denied by test.' },
            },
        }));
    case 'continue-stop':
        return run(JSON.stringify({
            decision: 'block',
            reason: 'Continue once.',
        }));
    case 'finish-stop':
        return run(JSON.stringify({
            continue: false,
            stopReason: 'Finish now.',
        }));
    case 'prompt-context':
        return run('Workspace prompt context');
    default:
        return run('');
    }
};
const manager = new HookManager({
    settings: { hooksEnabled: true },
    trustStore: trust,
    auditStore: new HookAuditStore({ path: auditPath }),
    userHooksPath,
    runner: fakeRunner,
});
const context = {
    session_id: 'conversation-1',
    conversation_id: 'conversation-1',
    cwd: workingDirectory,
    hooks_working_directory: workingDirectory,
    model: 'test-model',
    provider_id: 'test-provider',
    turn_id: 'turn-1',
    permission_mode: 'default',
};
const sessionResult = await manager.ensureSessionStarted(context, { source: 'resume' });
assert(sessionResult.additionalContext[0] === 'Session context', 'SessionStart context was not returned');
const startsAfterSession = starts.length;
await manager.ensureSessionStarted(context, { source: 'resume' });
assert(starts.length === startsAfterSession, 'SessionStart ran more than once for one runtime');

const preResult = await manager.dispatch('PreToolUse', context, {
    matchValue: 'Bash',
    eventInput: {
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        tool_input: { command: 'echo original' },
    },
});
assert(starts.includes('deny-tool') && starts.includes('rewrite-tool'), 'All matching hooks did not start');
assert(preResult.blocked && preResult.reason === 'Blocked by test policy.', 'PreToolUse deny did not win');
assert(preResult.updatedInput?.command === 'echo rewritten', 'PreToolUse rewrite was not parsed');
assert(
    new HookAuditStore({ path: auditPath }).records.some((record) => record.eventName === 'PreToolUse'),
    'Hook execution metadata was not persisted to the audit store',
);

const promptResult = await manager.dispatch('UserPromptSubmit', context, {
    eventInput: { prompt: 'hello' },
});
assert(promptResult.additionalContext[0] === 'Workspace prompt context', 'Prompt context was not returned');

const permissionResult = await manager.dispatch('PermissionRequest', context, {
    matchValue: 'Bash',
    eventInput: {
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
    },
});
assert(permissionResult.permissionDecision === 'deny', 'Permission deny must win over allow');
assert(permissionResult.reason === 'Denied by test.', 'Permission denial reason was lost');

const stopResult = await manager.dispatch('Stop', context, {
    eventInput: {
        stop_hook_active: false,
        last_assistant_message: 'Done',
    },
});
assert(!stopResult.shouldContinue, 'continue:false must win over Stop continuation requests');
assert(stopResult.stopReason === 'Finish now.', 'Stop reason was not retained');

const disabledStarts = starts.length;
const disabledManager = new HookManager({
    settings: { hooksEnabled: false },
    trustStore: trust,
    auditStore: new HookAuditStore({ path: auditPath }),
    userHooksPath,
    runner: fakeRunner,
});
await disabledManager.dispatch('PreToolUse', context, { matchValue: 'Bash' });
assert(starts.length === disabledStarts, 'Globally disabled hooks still ran');

const exitTwo = reduceHookRuns('UserPromptSubmit', [
    run('', { exitStatus: 2, stderr: 'Sensitive value blocked.' }),
]);
assert(exitTwo.blocked && exitTwo.reason === 'Sensitive value blocked.', 'Exit code 2 did not block prompt');

trust.setDisabled(preDefinitions[0].fingerprint, true);
assert(new HookTrustStore({ path: trustPath }).isDisabled(preDefinitions[0].fingerprint), 'Disabled state was not persisted');

const oldFingerprint = preDefinitions[0].fingerprint;
const changedConfig = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(userHooksPath)[1]));
changedConfig.hooks.PreToolUse[0].hooks[0].command = 'changed-deny-tool';
writeJson(userHooksPath, changedConfig);
const changedDefinition = manager.listHooks({ workingDirectory }).definitions.find((definition) => (
    definition.command === 'changed-deny-tool'
));
assert(changedDefinition.fingerprint !== oldFingerprint, 'Changed hook definition kept the old fingerprint');
assert(!changedDefinition.trusted, 'Changed hook definition must require review');

const commandResult = await runHookCommand({
    command: 'read payload; test -n "$payload"; printf runner-context',
    timeout: 5,
}, {
    session_id: 'runner-session',
}, {
    cwd: workingDirectory,
});
assert(commandResult.exitStatus === 0, `Command hook failed: ${commandResult.stderr}`);
assert(commandResult.stdout === 'runner-context', 'Command hook stdout was not captured');

const timeoutResult = await runHookCommand({
    command: 'while :; do :; done',
    timeout: 1,
}, {
    session_id: 'timeout-session',
}, {
    cwd: workingDirectory,
});
assert(timeoutResult.timedOut && timeoutResult.exitStatus === 124, 'Command hook timeout was not enforced');

const hookCancellable = new Gio.Cancellable();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
    hookCancellable.cancel();
    return GLib.SOURCE_REMOVE;
});
const cancelledResult = await runHookCommand({
    command: 'while :; do :; done',
    timeout: 5,
}, {
    session_id: 'cancel-session',
}, {
    cwd: workingDirectory,
    cancellable: hookCancellable,
});
assert(cancelledResult.cancelled && cancelledResult.exitStatus === 130, 'Command hook cancellation was not enforced');

print('Cusco hooks smoke tests passed');
