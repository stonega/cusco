import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

export const CuscoWindow = GObject.registerClass(
class CuscoWindow extends Adw.ApplicationWindow {
    _init(application) {
        super._init({
            application,
            title: 'Cusco',
            default_width: 1120,
            default_height: 760,
        });

        this._buildUi();
    }

    _buildUi() {
        const toolbarView = new Adw.ToolbarView();
        const headerBar = new Adw.HeaderBar();
        const title = new Adw.WindowTitle({
            title: 'Cusco',
            subtitle: 'GNOME AI chat',
        });

        headerBar.set_title_widget(title);
        headerBar.pack_start(new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'New chat',
        }));
        headerBar.pack_end(new Gtk.Button({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: 'Preferences',
        }));

        toolbarView.add_top_bar(headerBar);

        const split = new Gtk.Paned({
            orientation: Gtk.Orientation.HORIZONTAL,
            wide_handle: true,
            shrink_start_child: false,
            shrink_end_child: false,
            resize_start_child: false,
        });

        split.set_start_child(this._createSidebar());
        split.set_end_child(this._createChatSurface());
        toolbarView.set_content(split);

        this.set_content(toolbarView);
    }

    _createSidebar() {
        const sidebar = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        sidebar.set_size_request(280, -1);

        const search = new Gtk.SearchEntry({
            placeholder_text: 'Search chats',
            hexpand: true,
        });
        sidebar.append(search);

        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            vexpand: true,
        });

        ['Welcome to Cusco', 'Provider orchestration', 'Memory controls'].forEach((name) => {
            const row = new Gtk.ListBoxRow();
            const label = new Gtk.Label({
                label: name,
                xalign: 0,
                margin_top: 10,
                margin_bottom: 10,
                margin_start: 10,
                margin_end: 10,
            });

            row.set_child(label);
            list.append(row);
        });

        sidebar.append(list);
        return sidebar;
    }

    _createChatSurface() {
        const main = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
            hexpand: true,
            vexpand: true,
        });

        this._messages = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
        });

        this._addMessage('Cusco', 'Ask a question, compare providers, or start building a reusable AI workflow.', 'assistant');
        this._addMessage('Roadmap', 'Next steps: provider settings, streaming responses, markdown rendering, and local conversation storage.', 'system');

        const scroller = new Gtk.ScrolledWindow({
            child: this._messages,
            hexpand: true,
            vexpand: true,
        });

        const composerRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });

        const composer = new Gtk.Entry({
            placeholder_text: 'Message Cusco',
            hexpand: true,
        });

        const sendButton = new Gtk.Button({
            icon_name: 'mail-send-symbolic',
            tooltip_text: 'Send',
        });

        const sendMessage = () => {
            const text = composer.get_text().trim();

            if (!text)
                return;

            composer.set_text('');
            this._addMessage('You', text, 'user');
            this._addMessage('Cusco', 'Provider integration is not wired yet. This shell is ready for the chat engine.', 'assistant');
        };

        composer.connect('activate', sendMessage);
        sendButton.connect('clicked', sendMessage);

        composerRow.append(composer);
        composerRow.append(sendButton);

        main.append(scroller);
        main.append(composerRow);

        return main;
    }

    _addMessage(author, body, kind) {
        const wrapper = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 4,
            margin_bottom: 4,
            halign: kind === 'user' ? Gtk.Align.END : Gtk.Align.START,
        });

        const authorLabel = new Gtk.Label({
            label: author,
            xalign: kind === 'user' ? 1 : 0,
        });
        authorLabel.add_css_class('caption');
        authorLabel.add_css_class('dim-label');

        const bodyLabel = new Gtk.Label({
            label: body,
            wrap: true,
            selectable: true,
            xalign: 0,
            width_chars: 48,
            max_width_chars: 72,
        });
        bodyLabel.add_css_class(kind === 'user' ? 'accent' : 'card');

        wrapper.append(authorLabel);
        wrapper.append(bodyLabel);
        this._messages.append(wrapper);
    }
});
