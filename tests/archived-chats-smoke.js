import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import { ConversationManager } from '../src/chat/conversation.js';
import { AppSettingsStore, createApplicationSettingsPage } from '../src/settings/appSettings.js';
import { createArchivedChatsWindow } from '../src/settings/archivedChats.js';

function walkWidgets(widget, callback) {
    callback(widget);

    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        walkWidgets(child, callback);
}

if (Gtk.init_check()) {
    Adw.init();

    const conversations = new ConversationManager({
        providerId: 'test',
        modelId: 'test-model',
    });
    const first = conversations.createConversation({ title: 'First archived chat' });
    const second = conversations.createConversation({ title: 'Second archived chat' });
    conversations.archiveConversation(first.id);
    conversations.archiveConversation(second.id);

    const changes = [];
    const archivedWindow = createArchivedChatsWindow(null, conversations, (change) => changes.push(change));
    let deleteButton = null;
    let unarchiveButton = null;

    walkWidgets(archivedWindow, (widget) => {
        if (!(widget instanceof Gtk.Button))
            return;

        if (!deleteButton && widget.get_tooltip_text() === 'Delete chat')
            deleteButton = widget;

        if (!unarchiveButton && widget.get_label() === 'Unarchive')
            unarchiveButton = widget;
    });

    if (!deleteButton || !unarchiveButton)
        throw new Error('Archived chat rows did not expose delete and unarchive actions');

    unarchiveButton.emit('clicked');

    if (conversations.archivedConversations.length !== 1
        || changes[0]?.action !== 'unarchive') {
        throw new Error('Archived chat window did not unarchive the selected chat');
    }

    let openedArchivedChats = 0;
    let updateArchivedChatCount = null;
    const appSettings = new AppSettingsStore({ settings: null });
    appSettings.setEmptyChatImagePath('/tmp/custom-empty-chat.png');
    const settingsChanges = [];
    const settingsPage = createApplicationSettingsPage(
        appSettings,
        (change) => settingsChanges.push(change),
        {
            archivedChatCount: 2,
            onOpenArchivedChats: (_parent, onCountChanged) => {
                openedArchivedChats++;
                updateArchivedChatCount = onCountChanged;
            },
        },
    );
    let archivedChatsRow = null;
    let emptyChatImageRow = null;
    let resetEmptyChatImageButton = null;

    walkWidgets(settingsPage, (widget) => {
        if (widget instanceof Adw.ActionRow && widget.get_title() === 'Archived Chats')
            archivedChatsRow = widget;

        if (widget instanceof Adw.ActionRow && widget.get_title() === 'Empty Chat Image')
            emptyChatImageRow = widget;

        if (widget instanceof Gtk.Button && widget.get_tooltip_text() === 'Use default artwork')
            resetEmptyChatImageButton = widget;
    });

    if (!emptyChatImageRow
        || emptyChatImageRow.get_subtitle() !== 'custom-empty-chat.png (missing)'
        || !resetEmptyChatImageButton?.get_visible()) {
        throw new Error('Chat settings did not show the current empty chat image');
    }

    resetEmptyChatImageButton.emit('clicked');

    if (appSettings.emptyChatImagePath !== ''
        || emptyChatImageRow.get_subtitle() !== 'Cusco default artwork'
        || settingsChanges.at(-1)?.emptyChatImageChanged !== true) {
        throw new Error('Chat settings did not reset the empty chat image');
    }

    if (!archivedChatsRow || archivedChatsRow.get_subtitle() !== '2 archived chats')
        throw new Error('Chat settings did not show the Archived Chats entry and count');

    archivedChatsRow.emit('activated');
    updateArchivedChatCount?.(1);

    if (openedArchivedChats !== 1 || archivedChatsRow.get_subtitle() !== '1 archived chat')
        throw new Error('Archived Chats settings entry did not open or refresh its count');

    archivedWindow.destroy();
    print('Cusco archived chats smoke passed');
} else {
    print('Cusco archived chats smoke skipped: no display');
}
