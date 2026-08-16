import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { applyReferenceTextStyles } from './messageView.js';
import { normalizeComposerReferences } from '../composer/presentation.js';
import { createBundledIcon } from '../bundledIcons.js';

const QUEUED_ICON_FILE = 'queued-symbolic.svg';
const PENDING_MESSAGE_STACK_SPAN = 5;
const PENDING_MESSAGE_STACK_STEP = 4;

export class PendingMessagesController {
    constructor({
        conversations,
        pendingUserMessagesByConversation = new Map(),
        turns = new Map(),
        getState,
        setState,
        clearBox,
        composerReferenceStyles,
        focusComposer,
        isConversationBusy,
        runUserPromptHooks,
        syncComposerHint,
    }) {
        this._conversations = conversations;
        this._pendingUserMessagesByConversation = pendingUserMessagesByConversation;
        this._activeTurnsByConversation = turns;
        this._clearBox = clearBox;
        this._composerReferenceStyles = composerReferenceStyles;
        this.focusComposer = focusComposer;
        this._isConversationBusy = isConversationBusy;
        this._runUserPromptHooks = runUserPromptHooks;
        this._syncComposerHint = syncComposerHint;

        for (const name of [
            '_pendingUserMessagesList',
            '_pendingUserMessagesRow',
        ]) {
            Object.defineProperty(this, name, {
                configurable: true,
                get: () => getState(name),
                set: (value) => setState(name, value),
            });
        }
    }

    _createPendingUserMessagesRow() {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            visible: false,
        });
        row.add_css_class('cusco-pending-message-row');

        this._pendingUserMessagesList = new Gtk.Grid({
            row_homogeneous: true,
            hexpand: true,
        });
        this._pendingUserMessagesList.add_css_class('cusco-pending-message-stack');

        const scroller = new Gtk.ScrolledWindow({
            child: this._pendingUserMessagesList,
            hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            max_content_height: 112,
            propagate_natural_height: true,
        });
        scroller.add_css_class('cusco-pending-message-scroller');
        row.append(scroller);
        return row;
    }

    _pendingConversationId() {
        return this._conversations.activeConversation?.id ?? null;
    }

    _getPendingUserMessages(conversationId) {
        return this._pendingUserMessagesByConversation.get(conversationId) ?? [];
    }

    _enqueuePendingUserMessage(
        text,
        references = [],
        conversationId = this._pendingConversationId(),
    ) {
        const content = String(text ?? '').trim();

        if (!content || !conversationId)
            return null;

        const message = {
            id: GLib.uuid_string_random(),
            conversationId,
            content,
            references: normalizeComposerReferences(references),
            createdAt: new Date().toISOString(),
        };
        const messages = [...this._getPendingUserMessages(conversationId), message];
        this._pendingUserMessagesByConversation.set(conversationId, messages);
        this._renderPendingUserMessages();
        this._syncComposerHint(this._isConversationBusy(conversationId));
        return message;
    }

    async _enqueuePendingUserMessageWithHooks(
        text,
        references = [],
        conversationId = this._pendingConversationId(),
    ) {
        const conversation = this._conversations.getConversation(conversationId);

        if (!conversation)
            return null;

        const runtime = this._activeTurnsByConversation.get(conversationId);

        if (!runtime)
            return null;

        const hookContextStart = runtime.hookContexts.length;
        if (!await this._runUserPromptHooks(
            conversation,
            text,
            runtime.cancellable,
        )) {
            return null;
        }

        const message = this._enqueuePendingUserMessage(text, references, conversationId);

        if (message) {
            message.hookContexts = runtime.hookContexts.slice(hookContextStart);
            message.hookTurnId = runtime.turnId;
        }

        return message;
    }

    _removePendingUserMessage(conversationId, messageId) {
        const messages = this._getPendingUserMessages(conversationId)
            .filter((message) => message.id !== messageId);

        if (messages.length > 0)
            this._pendingUserMessagesByConversation.set(conversationId, messages);
        else
            this._pendingUserMessagesByConversation.delete(conversationId);

        this._renderPendingUserMessages();
        this.focusComposer();
    }

    _createPendingUserMessageCard(message) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });
        card.add_css_class('cusco-pending-message');
        card.set_tooltip_text(message.content);

        const status = createBundledIcon(QUEUED_ICON_FILE, 'go-next-symbolic');
        status.set_tooltip_text('Queued message');
        status.set_valign(Gtk.Align.CENTER);
        status.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ['Queued message'],
        );
        status.add_css_class('cusco-pending-message-status');

        const label = new Gtk.Label({
            label: message.content,
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            hexpand: true,
            lines: 1,
            max_width_chars: 76,
            single_line_mode: true,
            valign: Gtk.Align.CENTER,
        });
        label.add_css_class('cusco-pending-message-text');
        applyReferenceTextStyles(
            label,
            message.references,
            this._composerReferenceStyles(),
        );

        const removeButton = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            tooltip_text: 'Remove queued message',
            valign: Gtk.Align.CENTER,
        });
        removeButton.add_css_class('flat');
        removeButton.add_css_class('circular');
        removeButton.connect('clicked', () => {
            this._removePendingUserMessage(message.conversationId, message.id);
        });

        card.append(status);
        card.append(label);
        card.append(removeButton);
        return card;
    }

    _renderPendingUserMessages(conversation = this._conversations.activeConversation) {
        if (!this._pendingUserMessagesRow || !this._pendingUserMessagesList)
            return;

        this._clearBox(this._pendingUserMessagesList);
        const messages = conversation?.id ? this._getPendingUserMessages(conversation.id) : [];

        messages.forEach((message, index) => {
            this._pendingUserMessagesList.attach(
                this._createPendingUserMessageCard(message),
                0,
                index * PENDING_MESSAGE_STACK_STEP,
                1,
                PENDING_MESSAGE_STACK_SPAN,
            );
        });

        this._pendingUserMessagesRow.set_visible(messages.length > 0);
    }

}
