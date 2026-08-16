import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { isComputerUseError } from '../computerUse/protocol.js';
import { shouldSendSudoPasswordNotification } from '../chat/presentation.js';
import { createMessage } from '../providers/provider.js';
import {
    appendToolOutputPreview,
    createToolCallFromFailure,
    createToolCallFromRequest,
    createToolCallFromResult,
} from '../tools/display.js';
import { formatToolResultForTranscript } from '../tools/tools.js';

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isCancellableCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

function wasOperationCancelled(error, cancellable = null) {
    return isCancellableCancelled(cancellable) || isGioError(error, Gio.IOErrorEnum.CANCELLED);
}

function toolResultStatus(result) {
    if (result?.cancelled)
        return 'cancelled';
    if (result?.failed)
        return 'failed';
    return 'completed';
}

export class RequestedToolRunner {
    constructor({
        appSettings,
        conversations,
        providerConfigs,
        tools,
        getParentWindow,
        addMessageIfActiveConversation,
        appendToolCancellation,
        authorizeToolRequestWithHooks,
        manageArtifactList,
        runPostToolUseHooks,
        scrollToBottom,
        setToolHookProviderOverride,
        syncArtifactWorkspaceButton,
        updateUsageDisplay,
    }) {
        this._appSettings = appSettings;
        this._conversations = conversations;
        this._providerConfigs = providerConfigs;
        this._tools = tools;
        this._getParentWindow = getParentWindow;
        this._addMessageIfActiveConversation = addMessageIfActiveConversation;
        this._appendToolCancellation = appendToolCancellation;
        this._authorizeToolRequestWithHooks = authorizeToolRequestWithHooks;
        this._manageArtifactList = manageArtifactList;
        this._runPostToolUseHooks = runPostToolUseHooks;
        this._scrollToBottom = scrollToBottom;
        this._setToolHookProviderOverride = setToolHookProviderOverride;
        this._syncArtifactWorkspaceButton = syncArtifactWorkspaceButton;
        this._updateUsageDisplay = updateUsageDisplay;
    }

    async _runRequestedTool(text, conversationId, cancellable = null) {
        let request = this._tools.parseRequest(text);

        if (!request)
            return 'skipped';

        if (isCancellableCancelled(cancellable)) {
            this._appendToolCancellation(conversationId, request);
            return 'cancelled';
        }

        const conversation = this._conversations.getConversation(conversationId);
        const authorization = await this._authorizeToolRequestWithHooks(
            request,
            conversation,
            cancellable,
        );
        request = authorization.request;

        if (authorization.status === 'deny') {
            const message = createMessage('system', authorization.reason);
            this._conversations.appendMessage(conversationId, message);
            this._addMessageIfActiveConversation(conversationId, message);
            return 'blocked';
        }

        if (authorization.requiresUserApproval && !await this._confirmToolPermission(request, cancellable)) {
            if (isCancellableCancelled(cancellable)) {
                this._appendToolCancellation(conversationId, request);
                return 'cancelled';
            }

            const message = createMessage('system', `${request.label} was not run because permission was denied.`);
            this._conversations.appendMessage(conversationId, message);
            this._addMessageIfActiveConversation(conversationId, message);
            return 'denied';
        }

        const runningTool = this._appendRunningToolMessage(conversationId, request);

        try {
            const result = await this._tools.runRequest(request, {
                conversationId,
                providerId: conversation?.providerId ?? '',
                timeoutSeconds: request.name === 'bash'
                    ? undefined
                    : this._appSettings.responseTimeoutSeconds,
                cancellable,
                onOutput: (chunk) => this._appendToolOutputChunk(runningTool, chunk),
                requestSudoPassword: request.name === 'bash'
                    ? (command) => this._promptSudoPassword(command, cancellable)
                    : null,
            });
            const status = toolResultStatus(result);
            this._completeRunningToolMessage(conversationId, runningTool, result, status);
            const postHookResult = await this._runPostToolUseHooks(
                request,
                conversation,
                result,
                cancellable,
            );
            this._setToolHookProviderOverride(conversationId, runningTool, postHookResult);
            return status;
        } catch (error) {
            const postHookResult = await this._runPostToolUseHooks(request, conversation, {
                error: error.userMessage ?? error.message,
                cancelled: wasOperationCancelled(error, cancellable),
            }, cancellable);

            if (wasOperationCancelled(error, cancellable)) {
                this._completeRunningToolFailure(
                    conversationId,
                    runningTool,
                    request,
                    `${request.label} was stopped before it finished.`,
                    'cancelled',
                );
                this._setToolHookProviderOverride(conversationId, runningTool, postHookResult);
                return 'cancelled';
            }

            this._completeRunningToolFailure(
                conversationId,
                runningTool,
                request,
                error.userMessage ?? `Tool failed: ${error.message}`,
                'failed',
            );
            this._setToolHookProviderOverride(conversationId, runningTool, postHookResult);
            if (!isComputerUseError(error))
                logError(error, 'Failed to run tool request');
            return 'failed';
        }
    }

    _appendRunningToolMessage(conversationId, request, options = {}) {
        const message = createMessage('system', '', {
            toolCall: createToolCallFromRequest(request, {
                status: 'running',
                agentMode: Boolean(options.agentMode),
            }),
        });

        this._conversations.appendMessage(conversationId, message);
        const view = this._addMessageIfActiveConversation(conversationId, message);
        this._updateUsageDisplay(this._conversations.getConversation(conversationId));
        return { message, view };
    }

    _appendToolOutputChunk(runningTool, chunk) {
        const message = runningTool?.message;
        const toolCall = message?.toolCall;

        if (!toolCall || toolCall.name !== 'bash')
            return;

        const text = typeof chunk === 'object' ? chunk.text : chunk;
        if (!text)
            return;

        toolCall.outputPreview = appendToolOutputPreview(toolCall.outputPreview, text);
        runningTool?.view?.append_tool_output?.(toolCall.outputPreview);
        this._scrollToBottom();
    }

    _updateRunningToolMessage(conversationId, runningTool, content, toolCall) {
        const message = runningTool?.message;

        if (!message)
            return null;

        message.content = content;
        message.toolCall = toolCall;
        const storedMessage = this._conversations.updateMessageToolCall(
            conversationId,
            message.id,
            toolCall,
            content,
        );

        runningTool?.view?.update_tool_message?.(message);
        this._updateUsageDisplay(this._conversations.getConversation(conversationId));
        return storedMessage;
    }

    _completeRunningToolMessage(conversationId, runningTool, result, status, options = {}) {
        const content = formatToolResultForTranscript(result);
        const toolCall = createToolCallFromResult(result, {
            status,
            agentMode: Boolean(options.agentMode),
            createdAt: runningTool?.message?.toolCall?.createdAt,
            outputPreview: runningTool?.message?.toolCall?.outputPreview,
        });
        toolCall.artifacts = this._manageArtifactList(toolCall.artifacts, conversationId);
        this._syncArtifactWorkspaceButton();

        return this._updateRunningToolMessage(conversationId, runningTool, content, toolCall);
    }

    _completeRunningToolFailure(conversationId, runningTool, request, reason, status = 'failed', options = {}) {
        const toolCall = createToolCallFromFailure(request, reason, {
            status,
            agentMode: Boolean(options.agentMode),
            createdAt: runningTool?.message?.toolCall?.createdAt,
            outputPreview: runningTool?.message?.toolCall?.outputPreview,
        });

        return this._updateRunningToolMessage(conversationId, runningTool, String(reason ?? ''), toolCall);
    }

    _confirmToolPermission(request, cancellable = null) {
        return new Promise((resolve) => {
            if (isCancellableCancelled(cancellable)) {
                resolve(false);
                return;
            }

            const searchProviderName = request.name === 'search'
                ? this._providerConfigs.listWebSearchProviders()
                    .find((provider) => provider.selected)?.name ?? 'the selected search service'
                : '';
            const dialog = new Adw.AlertDialog({
                heading: `Run ${request.label}?`,
                body: request.name === 'search'
                    ? `Cusco will send this query through ${searchProviderName}:\n${request.input}`
                    : request.name === 'image_gen'
                        ? `Cusco will send this image prompt to the selected provider:\n${request.input}`
                    : request.input,
            });
            dialog.add_response('deny', 'Deny');
            dialog.add_response('stop', 'Stop');
            dialog.add_response('allow', 'Allow');
            dialog.set_default_response('allow');
            dialog.set_close_response('stop');
            dialog.set_response_appearance('stop', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.set_response_appearance('allow', Adw.ResponseAppearance.SUGGESTED);
            dialog.choose(this._getParentWindow(), cancellable, (_dialog, result) => {
                try {
                    const response = dialog.choose_finish(result);

                    if (response === 'stop')
                        cancellable?.cancel();

                    resolve(response === 'allow');
                } catch (error) {
                    if (!wasOperationCancelled(error, cancellable))
                        logError(error, 'Failed to resolve tool permission dialog');

                    resolve(false);
                }
            });
        });
    }

    _promptSudoPassword(command, cancellable = null) {
        return new Promise((resolve) => {
            if (isCancellableCancelled(cancellable)) {
                resolve(null);
                return;
            }

            const application = this._getParentWindow().get_application();
            const notificationId = shouldSendSudoPasswordNotification(this._getParentWindow())
                ? `sudo-password-${GLib.uuid_string_random()}`
                : null;

            if (notificationId) {
                const notification = new Gio.Notification();
                notification.set_title('Sudo password required');
                notification.set_body('Return to Cusco to continue the command.');
                application?.send_notification(notificationId, notification);
            }

            const entry = new Gtk.PasswordEntry({
                placeholder_text: 'Password',
                show_peek_icon: true,
                activates_default: true,
                hexpand: true,
            });
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 8,
            });
            const commandLabel = new Gtk.Label({
                label: String(command ?? ''),
                xalign: 0,
                selectable: true,
                wrap: true,
                max_width_chars: 72,
            });
            commandLabel.add_css_class('monospace');
            commandLabel.add_css_class('caption');
            box.append(commandLabel);
            box.append(entry);

            const dialog = new Adw.AlertDialog({
                heading: 'Sudo Password Required',
                body: 'Enter your sudo password to run this command. The password is not stored.',
            });
            dialog.set_extra_child(box);
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('run', 'Run');
            dialog.set_default_response('run');
            dialog.set_close_response('cancel');
            dialog.set_response_appearance('run', Adw.ResponseAppearance.SUGGESTED);
            dialog.choose(this._getParentWindow(), cancellable, (_dialog, result) => {
                if (notificationId)
                    application?.withdraw_notification(notificationId);

                try {
                    const response = dialog.choose_finish(result);
                    const password = entry.get_text();

                    resolve(response === 'run' && password ? password : null);
                } catch (error) {
                    if (!wasOperationCancelled(error, cancellable))
                        logError(error, 'Failed to resolve sudo password dialog');

                    resolve(null);
                }
            });

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                entry.grab_focus();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

}
