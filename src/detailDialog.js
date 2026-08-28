import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

export const DETAIL_DIALOG_WIDTH = 720;

export function presentDetailDialog(parent, { title, child, focusWidget = null }) {
    const dialog = new Adw.Dialog({
        title,
        content_width: DETAIL_DIALOG_WIDTH,
    });
    const toolbarView = new Adw.ToolbarView();
    const headerBar = new Adw.HeaderBar({
        show_start_title_buttons: false,
        show_end_title_buttons: false,
    });
    const closeButton = new Gtk.Button({
        icon_name: 'window-close-symbolic',
        tooltip_text: 'Close',
    });

    closeButton.add_css_class('flat');
    closeButton.connect('clicked', () => dialog.close());
    headerBar.pack_end(closeButton);
    toolbarView.add_top_bar(headerBar);
    toolbarView.set_content(child);
    dialog.set_child(toolbarView);
    dialog.set_focus(focusWidget ?? closeButton);
    dialog.present(parent);
    return dialog;
}
