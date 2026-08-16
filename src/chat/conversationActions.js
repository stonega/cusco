import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { copyTextToClipboard } from './messageView.js';
import { exportConversation } from '../workspace/exports.js';

function isCancellableCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

export class ConversationActions {
    constructor({
        conversations,
        cron,
        conversationsPendingDeletion,
        pendingUserMessagesByConversation,
        composerDraftsByConversation,
        pendingArtifactPresentationsByConversation,
        turns,
        getParentWindow,
        appendSystemError,
        applyComposerDraft,
        createConversationWithDefaults,
        deleteCronConversation,
        finishAgentQuestions,
        isActiveConversationId,
        isCronConversation,
        refreshConversationList,
        renderActiveConversation,
        setFollowLatestMessage,
        showToast,
    }) {
        this._conversations = conversations;
        this._cron = cron;
        this._conversationsPendingDeletion = conversationsPendingDeletion;
        this._pendingUserMessagesByConversation = pendingUserMessagesByConversation;
        this._composerDraftsByConversation = composerDraftsByConversation;
        this._pendingArtifactPresentationsByConversation = pendingArtifactPresentationsByConversation;
        this._activeTurnsByConversation = turns;
        this._getParentWindow = getParentWindow;
        this._appendSystemError = appendSystemError;
        this._applyComposerDraft = applyComposerDraft;
        this._createConversationWithDefaults = createConversationWithDefaults;
        this._deleteCronConversation = deleteCronConversation;
        this._finishAgentQuestions = finishAgentQuestions;
        this._isActiveConversationId = isActiveConversationId;
        this._isCronConversation = isCronConversation;
        this._refreshConversationList = refreshConversationList;
        this._renderActiveConversation = renderActiveConversation;
        this._setFollowLatestMessage = setFollowLatestMessage;
        this._showToast = showToast;
    }

    _archiveConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation || conversation.archived)
            return;

        this._conversations.archiveConversation(conversationId);

        if (this._conversations.conversations.length === 0)
            this._createConversationWithDefaults();

        this._refreshConversationList();
        this._renderActiveConversation();
        this._showToast('Chat archived');
    }

    _renameConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        const entry = new Gtk.Entry({
            text: conversation.title,
            hexpand: true,
        });
        const dialog = new Adw.AlertDialog({
            heading: 'Rename Chat',
        });
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('rename', 'Rename');
        dialog.set_default_response('rename');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('rename', Adw.ResponseAppearance.SUGGESTED);
        dialog.choose(this._getParentWindow(), null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'rename')
                return;

            this._conversations.renameConversation(conversationId, entry.get_text());
            this._refreshConversationList();
            this._renderActiveConversation();
        });
    }

    _exportConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        const dialog = new Adw.AlertDialog({
            heading: 'Export Chat',
            body: conversation.title,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('clipboard', 'Clipboard');
        dialog.add_response('markdown', 'Markdown');
        dialog.add_response('json', 'JSON');
        dialog.add_response('pdf', 'PDF');
        dialog.set_default_response('markdown');
        dialog.set_close_response('cancel');
        dialog.choose(this._getParentWindow(), null, (_dialog, result) => {
            const format = dialog.choose_finish(result);

            if (format === 'cancel')
                return;

            if (format === 'clipboard') {
                copyTextToClipboard(exportConversation(conversation, 'markdown'));
                this._showToast('Chat copied to clipboard');
                return;
            }

            this._saveConversationExport(conversation, format);
        });
    }

    _saveConversationExport(conversation, format) {
        const extension = format === 'markdown' ? 'md' : format;
        const dialog = new Gtk.FileDialog({
            title: 'Save Conversation',
            initial_name: `${conversation.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'conversation'}.${extension}`,
        });

        dialog.save(this._getParentWindow(), null, (_dialog, result) => {
            try {
                const file = dialog.save_finish(result);
                const path = file.get_path();

                if (!path)
                    throw new Error('Only local export paths are supported right now');

                GLib.file_set_contents(path, exportConversation(conversation, format));
            } catch (error) {
                logError(error, 'Failed to export conversation');
            }
        });
    }

    _confirmDeleteConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return;

        const dialog = new Adw.AlertDialog({
            heading: 'Delete Chat?',
            body: conversation.title,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(this._getParentWindow(), null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'delete')
                return;

            this._deleteConversationAfterStopping(conversationId).catch((error) => {
                logError(error, 'Failed to delete conversation');
                this._showToast('The chat could not be deleted.');
            });
        });
    }

    async _deleteConversationAfterStopping(conversationId) {
        if (!this._conversations.getConversation(conversationId)
            || this._conversationsPendingDeletion.has(conversationId)) {
            return false;
        }

        this._conversationsPendingDeletion.add(conversationId);
        this._pendingUserMessagesByConversation.delete(conversationId);
        this._finishAgentQuestions(null, { cancelled: true, conversationId });

        try {
            const runtime = this._activeTurnsByConversation.get(conversationId);

            if (runtime) {
                if (!isCancellableCancelled(runtime.cancellable))
                    runtime.cancellable.cancel();
                await runtime.finished;
            }

            const wasActive = this._isActiveConversationId(conversationId);
            this._conversations.deleteConversation(conversationId);
            this._composerDraftsByConversation.delete(conversationId);
            this._pendingArtifactPresentationsByConversation.delete(conversationId);

            if (this._conversations.conversations.length === 0)
                this._createConversationWithDefaults();

            if (wasActive) {
                this._setFollowLatestMessage(false);
                this._applyComposerDraft(this._composerDraftsByConversation.get(
                    this._conversations.activeConversation?.id,
                ));
            }

            this._refreshConversationList();
            this._renderActiveConversation();
            return true;
        } finally {
            this._conversationsPendingDeletion.delete(conversationId);
        }
    }

    _confirmDeleteCronJobConversation(conversationId) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation || !this._isCronConversation(conversation))
            return;

        const dialog = new Adw.AlertDialog({
            heading: 'Delete Cron Job?',
            body: conversation.title,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(this._getParentWindow(), null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'delete')
                return;

            this._cron.deleteJob(conversation.cronJobId).then(() => {
                this._deleteCronConversation(conversation.cronJobId);
            }).catch((error) => {
                logError(error, 'Failed to delete cron job from chat');
                this._appendSystemError(error.userMessage ?? error.message);
            });
        });
    }

}
