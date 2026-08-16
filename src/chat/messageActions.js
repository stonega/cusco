import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

export class MessageActions {
    constructor({
        conversations,
        getParentWindow,
        getProviderErrorMessage,
        appendSystemError,
        isConversationBusy,
        refreshConversationList,
        renderActiveConversation,
        streamAssistantResponse,
    }) {
        this._conversations = conversations;
        this._getParentWindow = getParentWindow;
        this._getProviderErrorMessage = getProviderErrorMessage;
        this._appendSystemError = appendSystemError;
        this._isConversationBusy = isConversationBusy;
        this._refreshConversationList = refreshConversationList;
        this._renderActiveConversation = renderActiveConversation;
        this._streamAssistantResponse = streamAssistantResponse;
    }

    _handleChatActionError(error) {
        logError(error, 'Failed to update conversation');
        this._appendSystemError(this._getProviderErrorMessage(error));
    }

    _editMessage(message) {
        const conversation = this._conversations.activeConversation;

        if (!conversation || this._isConversationBusy(conversation.id))
            return;

        const buffer = new Gtk.TextBuffer();
        buffer.set_text(message.content, -1);

        const textView = new Gtk.TextView({
            buffer,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            monospace: false,
            vexpand: true,
        });
        const scroller = new Gtk.ScrolledWindow({
            child: textView,
            min_content_height: 160,
            max_content_height: 260,
            propagate_natural_height: true,
        });
        const dialog = new Adw.AlertDialog({
            heading: 'Edit Message',
        });
        dialog.set_extra_child(scroller);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('save', 'Save');
        dialog.set_default_response('save');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.choose(this._getParentWindow(), null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'save')
                return;

            if (this._isConversationBusy(conversation.id))
                return;

            const [start, end] = buffer.get_bounds();
            const content = buffer.get_text(start, end, true).trim();

            if (!content)
                return;

            try {
                this._conversations.updateMessageContent(conversation.id, message.id, content);

                if (message.role === 'user') {
                    this._conversations.truncateAfterMessage(conversation.id, message.id);
                    this._renderActiveConversation();
                    this._streamAssistantResponse(conversation.id).catch((error) => this._handleChatActionError(error));
                } else {
                    this._renderActiveConversation();
                }

                this._refreshConversationList();
            } catch (error) {
                this._handleChatActionError(error);
            }
        });
    }

    _retryFromMessage(message) {
        const conversation = this._conversations.activeConversation;

        if (!conversation || this._isConversationBusy(conversation.id))
            return;

        try {
            this._conversations.truncateAfterMessage(conversation.id, message.id);
            this._renderActiveConversation();
            this._streamAssistantResponse(conversation.id).catch((error) => this._handleChatActionError(error));
        } catch (error) {
            this._handleChatActionError(error);
        }
    }

    _regenerateFromMessage(message) {
        const conversation = this._conversations.activeConversation;

        if (!conversation || this._isConversationBusy(conversation.id))
            return;

        try {
            this._conversations.truncateAfterMessage(conversation.id, message.id, { includeMessage: true });
            this._renderActiveConversation();
            this._streamAssistantResponse(conversation.id).catch((error) => this._handleChatActionError(error));
        } catch (error) {
            this._handleChatActionError(error);
        }
    }

    _branchFromMessage(message) {
        const conversation = this._conversations.activeConversation;

        if (!conversation)
            return;

        try {
            this._conversations.branchFromMessage(conversation.id, message.id);
            this._refreshConversationList();
            this._renderActiveConversation();
        } catch (error) {
            this._handleChatActionError(error);
        }
    }

}
