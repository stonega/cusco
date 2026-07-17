import Adw from 'gi://Adw?version=1';
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
