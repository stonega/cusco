import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

function updatedAtSubtitle(conversation) {
    const date = new Date(conversation.updatedAt);

    if (Number.isNaN(date.getTime()))
        return '';

    return `Updated ${date.toLocaleString()}`;
}

export function createArchivedChatsWindow(parent, conversationManager, onChanged = () => {}) {
    const window = new Adw.Window({
        title: 'Archived Chats',
        default_width: 560,
        default_height: 480,
        transient_for: parent,
    });
    const headerBar = new Adw.HeaderBar();
    const removeAllButton = new Gtk.Button({
        tooltip_text: 'Hold for 3 seconds to permanently remove all archived chats',
        valign: Gtk.Align.CENTER,
    });
    removeAllButton.add_css_class('destructive-action');
    const removeAllLabels = new Gtk.Stack();
    const countdownLabel = new Gtk.Label({ label: 'Remove in 3s' });
    removeAllLabels.add_named(new Gtk.Label({ label: 'Remove All' }), 'idle');
    removeAllLabels.add_named(countdownLabel, 'holding');
    removeAllButton.set_child(removeAllLabels);
    headerBar.pack_end(removeAllButton);

    let holdSourceId = 0;
    let holdInput = null;
    const cancelHold = () => {
        if (holdSourceId) {
            GLib.source_remove(holdSourceId);
            holdSourceId = 0;
        }
        holdInput = null;
        removeAllLabels.set_visible_child_name('idle');
        removeAllButton.unset_state_flags(Gtk.StateFlags.ACTIVE);
    };
    const startHold = (input) => {
        if (holdInput !== null || !removeAllButton.get_sensitive())
            return;

        holdInput = input;
        const startedAt = GLib.get_monotonic_time();
        countdownLabel.set_label('Remove in 3s');
        removeAllLabels.set_visible_child_name('holding');
        removeAllButton.set_state_flags(Gtk.StateFlags.ACTIVE, false);
        holdSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const elapsed = (GLib.get_monotonic_time() - startedAt) / 1000000;
            if (elapsed < 3) {
                countdownLabel.set_label(`Remove in ${Math.ceil(3 - elapsed)}s`);
                return GLib.SOURCE_CONTINUE;
            }

            holdSourceId = 0;
            cancelHold();
            const conversationIds = conversationManager.archivedConversations.map(({ id }) => id);
            for (const id of conversationIds)
                conversationManager.deleteConversation(id);
            refresh();
            if (conversationIds.length > 0)
                onChanged({ action: 'delete-all', conversationIds });
            return GLib.SOURCE_REMOVE;
        });
    };

    const press = new Gtk.GestureClick({
        button: Gdk.BUTTON_PRIMARY,
        propagation_phase: Gtk.PropagationPhase.CAPTURE,
    });
    press.connect('pressed', () => {
        removeAllButton.grab_focus();
        press.set_state(Gtk.EventSequenceState.CLAIMED);
        startHold('pointer');
    });
    const cancelPointerHold = () => {
        if (holdInput === 'pointer')
            cancelHold();
    };
    press.connect('released', cancelPointerHold);
    press.connect('unpaired-release', cancelPointerHold);
    press.connect('cancel', cancelPointerHold);
    press.connect('update', (_gesture, sequence) => {
        const [hasPoint, x, y] = press.get_point(sequence);
        if (hasPoint && (x < 0 || y < 0
            || x >= removeAllButton.get_width() || y >= removeAllButton.get_height())) {
            cancelPointerHold();
        }
    });
    removeAllButton.add_controller(press);
    const motion = new Gtk.EventControllerMotion();
    motion.connect('leave', cancelPointerHold);
    removeAllButton.add_controller(motion);

    const keys = new Gtk.EventControllerKey({ propagation_phase: Gtk.PropagationPhase.CAPTURE });
    keys.connect('key-pressed', (_controller, keyval) => {
        if (![Gdk.KEY_space, Gdk.KEY_Return, Gdk.KEY_KP_Enter].includes(keyval)) {
            cancelHold();
            return false;
        }
        startHold(keyval);
        return true;
    });
    keys.connect('key-released', (_controller, keyval) => {
        if (holdInput === keyval)
            cancelHold();
    });
    removeAllButton.add_controller(keys);
    const focus = new Gtk.EventControllerFocus();
    focus.connect('leave', cancelHold);
    removeAllButton.add_controller(focus);
    window.connect('unmap', cancelHold);
    window.connect('notify::is-active', () => {
        if (!window.is_active)
            cancelHold();
    });
    const list = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        margin_top: 18,
        margin_bottom: 18,
        margin_start: 18,
        margin_end: 18,
    });
    list.add_css_class('boxed-list');

    const scroller = new Gtk.ScrolledWindow({
        child: list,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    const emptyState = new Adw.StatusPage({
        icon_name: 'folder-documents-symbolic',
        title: 'No Archived Chats',
        description: 'Chats you archive will appear here.',
    });
    const stack = new Gtk.Stack();
    stack.add_named(scroller, 'chats');
    stack.add_named(emptyState, 'empty');

    const toolbarView = new Adw.ToolbarView();
    toolbarView.add_top_bar(headerBar);
    toolbarView.set_content(stack);
    window.set_content(toolbarView);

    const clearList = () => {
        for (let child = list.get_first_child(); child;) {
            const next = child.get_next_sibling();
            list.remove(child);
            child = next;
        }
    };

    const refresh = () => {
        cancelHold();
        removeAllButton.set_sensitive(conversationManager.archivedConversations.length > 0);
        clearList();

        for (const conversation of conversationManager.archivedConversations) {
            const row = new Adw.ActionRow({
                title: conversation.title,
                subtitle: updatedAtSubtitle(conversation),
            });
            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Delete chat',
                valign: Gtk.Align.CENTER,
            });
            deleteButton.add_css_class('flat');
            deleteButton.add_css_class('circular');
            deleteButton.add_css_class('destructive-action');
            deleteButton.connect('clicked', () => {
                const dialog = new Adw.AlertDialog({
                    heading: 'Delete Archived Chat?',
                    body: conversation.title,
                });
                dialog.add_response('cancel', 'Cancel');
                dialog.add_response('delete', 'Delete');
                dialog.set_default_response('cancel');
                dialog.set_close_response('cancel');
                dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
                dialog.choose(window, null, (_dialog, result) => {
                    if (dialog.choose_finish(result) !== 'delete')
                        return;

                    conversationManager.deleteConversation(conversation.id);
                    refresh();
                    onChanged({ action: 'delete', conversationId: conversation.id });
                });
            });

            const unarchiveButton = new Gtk.Button({
                label: 'Unarchive',
                valign: Gtk.Align.CENTER,
            });
            unarchiveButton.connect('clicked', () => {
                conversationManager.archiveConversation(conversation.id, false);
                refresh();
                onChanged({ action: 'unarchive', conversationId: conversation.id });
            });

            row.add_suffix(deleteButton);
            row.add_suffix(unarchiveButton);
            list.append(row);
        }

        stack.set_visible_child_name(
            conversationManager.archivedConversations.length > 0 ? 'chats' : 'empty',
        );
    };

    refresh();
    return window;
}

export function presentArchivedChatsWindow(parent, conversationManager, onChanged = () => {}) {
    const window = createArchivedChatsWindow(parent, conversationManager, onChanged);
    window.present();
    return window;
}
