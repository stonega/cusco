import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

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

function createTextButton(label, tooltipText, onClicked) {
    const button = new Gtk.Button({
        label,
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
    });
    button.add_css_class('suggested-action');
    button.connect('clicked', onClicked);
    return button;
}

function createSwitch(active, tooltipText, onChanged) {
    const control = new Gtk.Switch({
        active,
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
    });

    control.connect('notify::active', () => onChanged(control.get_active()));
    return control;
}

function createStatusDot(status) {
    const label = statusLabel(status.state);
    const message = status.message ? `: ${status.message}` : '';
    const dot = new Gtk.Box({
        tooltip_text: `${label}${message}`,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    });

    dot.set_size_request(9, 9);
    dot.add_css_class('cusco-status-dot');
    dot.add_css_class(`cusco-status-dot-${statusDotClass(status.state)}`);
    return dot;
}

function createServerTitle(server) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 7,
        valign: Gtk.Align.CENTER,
    });
    const label = new Gtk.Label({
        label: server.name,
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
        valign: Gtk.Align.CENTER,
    });

    label.add_css_class('heading');
    box.append(label);
    box.append(createStatusDot(server.status));
    return box;
}

function createServerSubtitle(text) {
    const label = new Gtk.Label({
        label: text,
        xalign: 0,
        wrap: true,
        lines: 3,
        ellipsize: Pango.EllipsizeMode.END,
    });

    label.add_css_class('caption');
    label.add_css_class('dim-label');
    return label;
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

function presentError(parent, heading, error) {
    const dialog = new Adw.AlertDialog({
        heading,
        body: error.userMessage ?? error.message,
    });
    dialog.add_response('close', 'Close');
    dialog.set_default_response('close');
    dialog.set_close_response('close');
    dialog.present(parent);
}

function statusLabel(state) {
    switch (state) {
    case 'auth_required':
        return 'Auth required';
    case 'connected':
        return 'Connected';
    case 'connecting':
        return 'Connecting';
    case 'disabled':
        return 'Disabled';
    case 'error':
        return 'Error';
    default:
        return 'Not connected';
    }
}

function statusDotClass(state) {
    switch (state) {
    case 'auth_required':
        return 'warning';
    case 'connected':
        return 'connected';
    case 'connecting':
        return 'connecting';
    case 'disabled':
        return 'disabled';
    case 'error':
        return 'error';
    default:
        return 'idle';
    }
}

function serverStatusSubtitle(server) {
    const status = server.status;
    const counts = status.state === 'connected'
        ? `${server.toolCount} tools, ${server.resourceCount} resources, ${server.promptCount} prompts`
        : '';
    const statusMessage = ['auth_required', 'error'].includes(status.state)
        ? status.message
        : '';

    return [
        counts,
        statusMessage,
        status.auth?.scope ? `Scope: ${status.auth.scope}` : '',
        `${server.source === 'file' ? 'mcp.json' : 'Workspace'} · ${server.transport}`,
    ].filter(Boolean).join('\n');
}

export function createMcpConfigGroup(parent, mcpManager, onChanged = () => {}) {
    const configGroup = new Adw.PreferencesGroup({
        title: 'MCP Config File',
        description: 'Cusco loads MCP servers from this file.',
    });
    const configRow = new Adw.ActionRow({
        title: 'mcp.json',
        subtitle: mcpManager.configPath,
    });
    let serverRows = [];

    const renderConfig = () => {
        configRow.set_subtitle(mcpManager.configError
            ? `${mcpManager.configPath}\nError: ${mcpManager.configError}`
            : mcpManager.configPath);

        for (const row of serverRows)
            configGroup.remove(row);

        serverRows = mcpManager.listServers()
            .map((server) => {
                const row = new Adw.PreferencesRow();
                const content = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 12,
                    margin_top: 9,
                    margin_bottom: 9,
                    margin_start: 12,
                    margin_end: 12,
                });
                const textColumn = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    spacing: 3,
                    hexpand: true,
                    valign: Gtk.Align.CENTER,
                });
                const actions = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                    valign: Gtk.Align.CENTER,
                });
                const subtitle = serverStatusSubtitle(server);

                textColumn.append(createServerTitle(server));

                if (subtitle)
                    textColumn.append(createServerSubtitle(subtitle));

                const refreshButton = createActionButton('view-refresh-symbolic', `Refresh ${server.name}`, () => {
                    refreshButton.set_sensitive(false);
                    mcpManager.refreshServer(server.key).then(() => {
                        renderConfig();
                        onChanged();
                    }).catch((error) => {
                        logError(error, 'Failed to refresh MCP server');
                        renderConfig();
                        presentError(parent, `Refresh ${server.name}`, error);
                    }).finally(() => {
                        refreshButton.set_sensitive(true);
                    });
                });
                const toggle = createSwitch(
                    server.enabled,
                    server.source === 'workspace'
                        ? `Enable ${server.name}`
                        : `Enable ${server.name} in mcp.json`,
                    (enabled) => {
                        try {
                            mcpManager.setServerEnabled(server.key, enabled);
                            renderConfig();
                            onChanged();
                        } catch (error) {
                            logError(error, 'Failed to update MCP server enabled state');
                            toggle.set_active(server.enabled);
                            presentError(parent, `Update ${server.name}`, error);
                        }
                    },
                );

                if (server.status.state === 'auth_required') {
                    const authButton = createTextButton('Auth', `Authorize ${server.name}`, () => {
                        authButton.set_sensitive(false);
                        mcpManager.authorizeServer(server.key).then(() => {
                            renderConfig();
                            onChanged();
                        }).catch((error) => {
                            logError(error, 'Failed to authorize MCP server');
                            presentError(parent, `Authorize ${server.name}`, error);
                        }).finally(() => {
                            authButton.set_sensitive(true);
                        });
                    });
                    actions.append(authButton);
                }

                actions.append(refreshButton);
                actions.append(toggle);
                content.append(textColumn);
                content.append(actions);
                row.set_child(content);
                configGroup.add(row);
                return row;
            });
    };

    configRow.add_suffix(createActionButton('document-edit-symbolic', 'Edit MCP config file', () => {
        try {
            openConfigFile(mcpManager.configPath);
        } catch (error) {
            logError(error, 'Failed to open MCP config file');
        }
    }));
    configRow.add_suffix(createActionButton('view-refresh-symbolic', 'Reload MCP config file', () => {
        mcpManager.refreshServers().then(() => {
            renderConfig();
            onChanged();
        }).catch((error) => {
            logError(error, 'Failed to refresh MCP config file');
            mcpManager.reloadConfig();
            renderConfig();
            presentError(parent, 'Refresh MCP config', error);
            onChanged();
        });
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
