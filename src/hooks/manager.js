import GLib from 'gi://GLib?version=2.0';

import { HookAuditStore } from './auditStore.js';
import {
    discoverHookSources,
    hookMatcherMatches,
} from './config.js';
import { reduceHookRuns } from './protocol.js';
import { runHookCommand } from './runner.js';
import { HookTrustStore } from './trustStore.js';

function emptyDispatch(eventName) {
    return reduceHookRuns(eventName, []);
}

function sessionKey(context) {
    return [
        String(context.session_id ?? ''),
        String(context.hooks_working_directory ?? ''),
    ].join('\u0000');
}

export class HookManager {
    constructor(options = {}) {
        this._settings = options.settings ?? null;
        this._trust = options.trustStore ?? new HookTrustStore(options.trustOptions);
        this._audit = options.auditStore ?? new HookAuditStore(options.auditOptions);
        this._userHooksPath = options.userHooksPath;
        this._runner = options.runner ?? runHookCommand;
        this._onStatus = options.onStatus ?? null;
        this._sessionStarts = new Set();
        this._lastRuns = new Map();
        this._reportedSourceErrors = new Set();
    }

    get enabled() {
        return this._settings?.hooksEnabled !== false;
    }

    listHooks(options = {}) {
        const sources = discoverHookSources({
            userHooksPath: this._userHooksPath,
            workingDirectory: options.workingDirectory,
        });

        return {
            sources,
            definitions: sources.flatMap((source) => source.definitions).map((definition) => ({
                ...definition,
                trusted: this._trust.isTrusted(definition.fingerprint),
                disabled: this._trust.isDisabled(definition.fingerprint),
                lastRun: this._lastRuns.get(definition.fingerprint)
                    ?? this._audit.latest(definition.fingerprint),
            })),
        };
    }

    trust(fingerprint) {
        const changed = this._trust.trust(fingerprint);

        if (changed)
            this.resetAllSessions();

        return changed;
    }

    revoke(fingerprint) {
        return this._trust.revoke(fingerprint);
    }

    setDisabled(fingerprint, disabled) {
        const changed = this._trust.setDisabled(fingerprint, disabled);

        if (changed && !disabled)
            this.resetAllSessions();

        return changed;
    }

    resetAllSessions() {
        this._sessionStarts.clear();
    }

    resetSession(sessionId, workingDirectory = '') {
        this._sessionStarts.delete([
            String(sessionId ?? ''),
            String(workingDirectory ?? ''),
        ].join('\u0000'));
    }

    async ensureSessionStarted(context, options = {}) {
        const key = sessionKey(context);

        if (!this.enabled)
            return emptyDispatch('SessionStart');

        if (this._sessionStarts.has(key))
            return emptyDispatch('SessionStart');

        this._sessionStarts.add(key);
        return await this.dispatch('SessionStart', context, {
            ...options,
            matchValue: options.source ?? 'resume',
            eventInput: {
                source: options.source ?? 'resume',
                ...(options.eventInput ?? {}),
            },
        });
    }

    async dispatch(eventName, context, options = {}) {
        if (!this.enabled)
            return emptyDispatch(eventName);

        const listing = this.listHooks({
            workingDirectory: context.hooks_working_directory,
        });

        for (const source of listing.sources) {
            for (const error of source.errors) {
                const key = `${source.path}\u0000${error}`;

                if (this._reportedSourceErrors.has(key))
                    continue;

                this._reportedSourceErrors.add(key);
                this._onStatus?.(`Hooks configuration needs attention: ${source.path}`, null);
            }
        }

        const matcherIgnored = ['UserPromptSubmit', 'Stop'].includes(eventName);
        const matching = listing.definitions.filter((definition) => (
            definition.eventName === eventName
            && definition.supported
            && definition.trusted
            && !definition.disabled
            && (matcherIgnored || hookMatcherMatches(definition, options.matchValue))
        ));

        if (matching.length === 0)
            return emptyDispatch(eventName);

        const input = {
            session_id: String(context.session_id ?? ''),
            transcript_path: context.transcript_path ?? null,
            cwd: String(context.cwd ?? ''),
            hook_event_name: eventName,
            model: String(context.model ?? ''),
            ...(context.turn_id ? { turn_id: String(context.turn_id) } : {}),
            ...(context.permission_mode
                ? { permission_mode: String(context.permission_mode) }
                : {}),
            ...(context.provider_id
                ? { provider_id: String(context.provider_id) }
                : {}),
            ...(context.conversation_id
                ? { conversation_id: String(context.conversation_id) }
                : {}),
            ...(context.agent_mode !== undefined
                ? { agent_mode: Boolean(context.agent_mode) }
                : {}),
            ...(options.eventInput ?? {}),
        };

        const promises = matching.map(async (definition) => {
            if (definition.statusMessage)
                this._onStatus?.(definition.statusMessage, definition);

            let commandResult;

            try {
                commandResult = await this._runner(definition, input, {
                    cwd: input.cwd,
                    cancellable: options.cancellable ?? null,
                });
            } catch (error) {
                commandResult = {
                    exitStatus: 1,
                    stdout: '',
                    stderr: error.message,
                    timedOut: false,
                    cancelled: false,
                    durationMs: 0,
                    failedToStart: true,
                };
            }

            const run = {
                ...commandResult,
                fingerprint: definition.fingerprint,
                sourcePath: definition.sourcePath,
                eventName,
                command: definition.command,
                finishedAt: new Date().toISOString(),
            };
            const lastRun = {
                fingerprint: definition.fingerprint,
                eventName,
                sourcePath: definition.sourcePath,
                exitStatus: run.exitStatus,
                timedOut: run.timedOut,
                cancelled: run.cancelled,
                durationMs: run.durationMs,
                finishedAt: run.finishedAt,
                outputPath: run.stdoutPath ?? '',
                error: run.exitStatus === 0
                    ? ''
                    : String(run.stderr ?? '').trim().slice(0, 500),
            };
            this._lastRuns.set(definition.fingerprint, lastRun);
            this._audit.record({
                ...lastRun,
                outputPath: undefined,
                error: run.timedOut
                    ? 'Hook timed out.'
                    : run.cancelled
                        ? 'Hook was cancelled.'
                        : run.exitStatus === 0
                            ? ''
                            : `Hook exited with status ${run.exitStatus}.`,
            });
            return run;
        });

        return reduceHookRuns(eventName, await Promise.all(promises));
    }
}

export function createTurnHookContext(conversation, options = {}) {
    const selectedWorkingDirectory = String(conversation?.workingDirectory ?? '').trim();
    const workingDirectory = selectedWorkingDirectory || GLib.get_current_dir();

    return {
        session_id: String(conversation?.id ?? ''),
        conversation_id: String(conversation?.id ?? ''),
        transcript_path: null,
        cwd: workingDirectory,
        hooks_working_directory: selectedWorkingDirectory,
        model: String(conversation?.modelId ?? ''),
        provider_id: String(conversation?.providerId ?? ''),
        agent_mode: Boolean(conversation?.agentModeEnabled),
        turn_id: String(options.turnId ?? ''),
        permission_mode: options.autoModeEnabled ? 'dontAsk' : 'default',
    };
}
