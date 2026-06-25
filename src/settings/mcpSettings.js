import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

function createActionButton(iconName, tooltipText, onClicked) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
    });
    button.add_css_class('flat');
    button.connect('clicked', onClicked);
    return button;
}

function ensureConfigFile(path) {
    const directory = GLib.path_get_dirname(path);

    GLib.mkdir_with_parents(directory, 0o700);

    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        GLib.file_set_contents(path, '{\n  "mcpServers": {}\n}\n');
}

function openConfigFile(path) {
    ensureConfigFile(path);
    Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(path).get_uri(), null);
}

export function createMcpConfigGroup(_parent, mcpManager, onChanged = () => {}) {
    const configGroup = new Adw.PreferencesGroup({
        title: 'MCP Config File',
        description: 'Cusco loads MCP servers from this file.',
    });
    const configRow = new Adw.ActionRow({
        title: 'mcp.json',
        subtitle: mcpManager.configPath,
    });

    const renderConfig = () => {
        configRow.set_subtitle(mcpManager.configError
            ? `${mcpManager.configPath}\nError: ${mcpManager.configError}`
            : mcpManager.configPath);
    };

    configRow.add_suffix(createActionButton('document-edit-symbolic', 'Edit MCP config file', () => {
        try {
            openConfigFile(mcpManager.configPath);
        } catch (error) {
            logError(error, 'Failed to open MCP config file');
        }
    }));
    configRow.add_suffix(createActionButton('view-refresh-symbolic', 'Reload MCP config file', () => {
        mcpManager.reloadConfig();
        renderConfig();
        onChanged();
    }));

    configGroup.add(configRow);
    renderConfig();
    return configGroup;
}

export function createMcpSettingsPage(parent, mcpManager, onChanged = () => {}) {
    const page = new Adw.PreferencesPage({
        title: 'MCP',
        icon_name: 'network-server-symbolic',
    });

    page.add(createMcpConfigGroup(parent, mcpManager, onChanged));
    return page;
}
