import GLib from 'gi://GLib?version=2.0';

import { canonicalHookToolName } from '../hooks/config.js';
import { createTurnHookContext } from '../hooks/manager.js';
import { createMessage } from '../providers/provider.js';
import { createToolPermissionDecision } from '../tools/permissions.js';

export class HookCoordinator {
    constructor({
        appSettings,
        conversations,
        hooks,
        sessionHookContexts,
        tools,
        turns,
        activeTurnHookContexts,
        addMessageIfActiveConversation,
        showToast,
    }) {
        this._appSettings = appSettings;
        this._conversations = conversations;
        this._hooks = hooks;
        this._sessionHookContexts = sessionHookContexts;
        this._tools = tools;
        this._activeTurnsByConversation = turns;
        this._activeTurnHookContexts = activeTurnHookContexts;
        this._addMessageIfActiveConversation = addMessageIfActiveConversation;
        this._showToast = showToast;
    }

    _turnHookContext(conversation) {
        return createTurnHookContext(conversation, {
            turnId: this._activeTurnsByConversation.get(conversation.id)?.turnId ?? null,
            autoModeEnabled: this._appSettings.autoModeEnabled,
        });
    }

    _appendHookNotice(conversation, text) {
        const content = String(text ?? '').trim();

        if (!conversation || !content)
            return null;

        const message = createMessage('system', content, {
            metadata: { hookNotice: true },
        });
        this._conversations.appendMessage(conversation.id, message);
        this._addMessageIfActiveConversation(conversation.id, message);
        return message;
    }

    _applyHookResult(conversation, result, options = {}) {
        if (!result)
            return;

        const contexts = result.additionalContext
            ?.map((context) => String(context ?? '').trim())
            .filter(Boolean) ?? [];

        if (options.session && conversation) {
            this._sessionHookContexts.set(conversation.id, contexts);
        } else {
            this._activeTurnHookContexts(conversation?.id).push(...contexts);
        }

        for (const message of result.systemMessages ?? [])
            this._appendHookNotice(conversation, message);

        if ((result.failures?.length ?? 0) > 0) {
            log(
                `Cusco hook ${result.eventName} reported ${result.failures.length} failure(s); `
                + 'review the Hooks config file and application log for details.',
            );
        }
    }

    async _ensureTurnSessionHooks(conversation, cancellable) {
        const result = await this._hooks.ensureSessionStarted(
            this._turnHookContext(conversation),
            {
                source: conversation.messages.length === 0 ? 'startup' : 'resume',
                cancellable,
            },
        );
        this._applyHookResult(conversation, result, { session: true });

        if (result.continue === false) {
            const reason = result.stopReason || 'Session start was stopped by a hook.';
            this._appendHookNotice(conversation, reason);
            return false;
        }

        return true;
    }

    async _runUserPromptHooks(conversation, prompt, cancellable) {
        const result = await this._hooks.dispatch(
            'UserPromptSubmit',
            this._turnHookContext(conversation),
            {
                cancellable,
                eventInput: { prompt: String(prompt ?? '') },
            },
        );
        this._applyHookResult(conversation, result);

        if (result.blocked || result.continue === false) {
            this._showToast(result.reason || result.stopReason || 'Prompt blocked by hook.');
            return false;
        }

        return true;
    }

    _hookToolInput(request, options = {}) {
        let input;

        if (canonicalHookToolName(request.name) === 'Bash') {
            input = { command: String(request.input ?? '') };
        } else {
            try {
                const parsed = JSON.parse(String(request.input ?? ''));
                input = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? parsed
                    : { input: request.input };
            } catch (_error) {
                input = { input: request.input };
            }
        }

        if (options.description)
            input.description = options.description;

        return input;
    }

    _requestWithHookInput(request, updatedInput) {
        const toolName = canonicalHookToolName(request.name);
        let input;

        if (toolName === 'Bash') {
            if (typeof updatedInput?.command !== 'string')
                throw new Error('PreToolUse must rewrite Bash with a string command field.');

            input = updatedInput.command;
        } else {
            input = JSON.stringify(updatedInput);
        }

        return {
            ...this._tools.createRequest(request.name, input),
            hookToolUseId: request.hookToolUseId,
        };
    }

    async _authorizeToolRequestWithHooks(request, conversation, cancellable) {
        let normalizedRequest = {
            ...request,
            hookToolUseId: request.hookToolUseId ?? GLib.uuid_string_random(),
        };
        const toolName = canonicalHookToolName(normalizedRequest.name);
        const preResult = await this._hooks.dispatch(
            'PreToolUse',
            this._turnHookContext(conversation),
            {
                cancellable,
                matchValue: toolName,
                eventInput: {
                    tool_name: toolName,
                    tool_use_id: normalizedRequest.hookToolUseId,
                    tool_input: this._hookToolInput(normalizedRequest),
                },
            },
        );
        this._applyHookResult(conversation, preResult);

        if (preResult.blocked) {
            return {
                status: 'deny',
                reason: preResult.reason || `${normalizedRequest.label} was blocked by a hook.`,
                request: normalizedRequest,
            };
        }

        if (preResult.updatedInput) {
            try {
                normalizedRequest = this._requestWithHookInput(
                    normalizedRequest,
                    preResult.updatedInput,
                );
            } catch (error) {
                return {
                    status: 'deny',
                    reason: error.message,
                    request: normalizedRequest,
                };
            }
        }

        const permissionDecision = createToolPermissionDecision(normalizedRequest, {
            autoModeEnabled: this._appSettings.autoModeEnabled,
        });

        if (permissionDecision.status === 'deny') {
            return {
                status: 'deny',
                reason: permissionDecision.reason,
                request: normalizedRequest,
            };
        }

        if (!permissionDecision.requiresUserApproval) {
            return {
                status: 'allow',
                request: normalizedRequest,
                requiresUserApproval: false,
            };
        }

        const permissionResult = await this._hooks.dispatch(
            'PermissionRequest',
            this._turnHookContext(conversation),
            {
                cancellable,
                matchValue: toolName,
                eventInput: {
                    tool_name: toolName,
                    tool_input: this._hookToolInput(normalizedRequest, {
                        description: permissionDecision.reason,
                    }),
                },
            },
        );
        this._applyHookResult(conversation, permissionResult);

        if (permissionResult.permissionDecision === 'deny') {
            return {
                status: 'deny',
                reason: permissionResult.reason || `${normalizedRequest.label} was denied by a hook.`,
                request: normalizedRequest,
            };
        }

        return {
            status: 'allow',
            request: normalizedRequest,
            requiresUserApproval: permissionResult.permissionDecision !== 'allow',
        };
    }

    async _runPostToolUseHooks(request, conversation, toolResponse, cancellable) {
        const toolName = canonicalHookToolName(request.name);
        const result = await this._hooks.dispatch(
            'PostToolUse',
            this._turnHookContext(conversation),
            {
                cancellable,
                matchValue: toolName,
                eventInput: {
                    tool_name: toolName,
                    tool_use_id: request.hookToolUseId ?? GLib.uuid_string_random(),
                    tool_input: this._hookToolInput(request),
                    tool_response: toolResponse,
                },
            },
        );
        this._applyHookResult(conversation, result);
        let feedback = [
            ...(result.feedback ?? []),
            result.stopReason,
        ].map((value) => String(value ?? '').trim()).filter(Boolean).join('\n\n');

        if (result.stopNormalProcessing && !feedback)
            feedback = 'A lifecycle hook stopped normal processing of this tool result.';

        if (feedback)
            this._appendHookNotice(conversation, feedback);

        return {
            ...result,
            feedback,
        };
    }

    _setToolHookProviderOverride(conversationId, runningTool, postHookResult) {
        if (!postHookResult?.stopNormalProcessing || !runningTool?.message)
            return;

        const message = runningTool.message;
        this._conversations.updateMessageMetadata(conversationId, message.id, {
            ...message.metadata,
            hookProviderContentOverride: postHookResult.feedback,
        });
    }

}
