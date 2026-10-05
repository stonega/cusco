import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { ConversationManager } from '../src/chat/conversation.js';
import { createArchivedChatsWindow } from '../src/settings/archivedChats.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function delay(milliseconds) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function findRemoveAll(widget) {
    if (widget instanceof Gtk.Button && widget.get_tooltip_text()?.startsWith('Hold for 3 seconds'))
        return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const found = findRemoveAll(child);
        if (found)
            return found;
    }
    return null;
}

function controller(button, type) {
    const controllers = button.observe_controllers();
    for (let i = 0; i < controllers.get_n_items(); i++) {
        const item = controllers.get_item(i);
        if (item instanceof type && item.get_propagation_phase() === Gtk.PropagationPhase.CAPTURE)
            return item;
    }
    throw new Error(`Missing input controller: ${type}`);
}

if (!Gtk.init_check()) {
    print('Cusco archived chats window smoke skipped: no display');
} else {
    Adw.init();
    const manager = new ConversationManager({ providerId: 'test', modelId: 'test' });
    const visible = manager.createConversation({ title: 'Keep this chat' });
    for (let i = 0; i < 3; i++) {
        const archived = manager.createConversation({ title: `Archived ${i}` });
        manager.archiveConversation(archived.id);
    }
    const changes = [];
    const window = createArchivedChatsWindow(null, manager, (change) => changes.push(change));
    window.present();
    await delay(100);
    const button = findRemoveAll(window);
    assert(button?.get_sensitive(), 'Remove All is missing or disabled with archived chats');
    const labels = button.get_child();
    const keys = controller(button, Gtk.EventControllerKey);
    const pointer = controller(button, Gtk.GestureClick);

    button.emit('clicked');
    assert(manager.archivedConversations.length === 3, 'A simple click deleted archived chats');

    pointer.emit('pressed', 1, 5, 5);
    await delay(100);
    pointer.emit('released', 1, 5, 5);
    await delay(3100);
    assert(manager.archivedConversations.length === 3, 'An early pointer release deleted chats');
    assert(labels.get_visible_child_name() === 'idle', 'Pointer release did not reset the countdown');

    keys.emit('key-pressed', Gdk.KEY_space, 0, 0);
    await delay(100);
    keys.emit('key-released', Gdk.KEY_space, 0, 0);
    assert(labels.get_visible_child_name() === 'idle', 'Key release did not reset the countdown');

    keys.emit('key-pressed', Gdk.KEY_Return, 0, 0);
    await delay(1500);
    keys.emit('key-pressed', Gdk.KEY_Return, 0, 0);
    assert(manager.archivedConversations.length === 3, 'Chats were deleted before three seconds');
    assert(labels.get_visible_child_name() === 'holding', 'Hold did not show a countdown');
    await delay(1700);
    keys.emit('key-released', Gdk.KEY_Return, 0, 0);
    assert(manager.archivedConversations.length === 0, 'A full hold did not remove archived chats');
    assert(manager.getConversation(visible.id) === visible, 'Remove All deleted an unarchived chat');
    assert(changes.length === 1 && changes[0].conversationIds.length === 3,
        'Bulk deletion did not notify the parent exactly once');
    assert(!button.get_sensitive(), 'Remove All stayed enabled for an empty archive');
    window.destroy();
    await delay(30);

    const archived = manager.createConversation({ title: 'Keep on close' });
    manager.archiveConversation(archived.id);
    const closingWindow = createArchivedChatsWindow(null, manager);
    closingWindow.present();
    await delay(100);
    const closingButton = findRemoveAll(closingWindow);
    controller(closingButton, Gtk.EventControllerKey).emit('key-pressed', Gdk.KEY_space, 0, 0);
    closingWindow.close();
    await delay(3100);
    assert(manager.archivedConversations.length === 1, 'Closing during a hold deleted archived chats');

    const pointerWindow = createArchivedChatsWindow(null, manager);
    pointerWindow.present();
    await delay(100);
    const pointerButton = findRemoveAll(pointerWindow);
    const pointerController = controller(pointerButton, Gtk.GestureClick);
    pointerController.emit('pressed', 1, 5, 5);
    pointerController.emit('cancel', null);
    assert(pointerButton.get_child().get_visible_child_name() === 'idle',
        'A cancelled pointer gesture retained its countdown');
    pointerController.emit('pressed', 1, 5, 5);
    await delay(3200);
    pointerController.emit('released', 1, 5, 5);
    assert(manager.archivedConversations.length === 0, 'A full pointer hold did not remove archived chats');
    pointerWindow.destroy();
    await delay(30);
    print('Cusco archived chats window smoke passed');
}
