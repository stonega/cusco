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

function serverLocation(server) {
    if (server.transport === 'streamable-http')
        return server.url || 'HTTP URL not configured';

    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') || 'Command not configured';
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

function serverStatusSubtitle(server) {
    const status = server.status;
    const counts = status.state === 'connected'
        ? `${server.toolCount} tools, ${server.resourceCount} resources, ${server.promptCount} prompts`
        : '';

    return [
        `${statusLabel(status.state)}: ${status.message}`,
        counts,
        status.auth?.scope ? `Scope: ${status.auth.scope}` : '',
        `${server.source === 'file' ? 'mcp.json' : 'Workspace'} · ${server.transport}`,
        serverLocation(server),
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
                const row = new Adw.ActionRow({
                    title: server.name,
                    subtitle: serverStatusSubtitle(server),
                    subtitle_lines: 4,
                });
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
                        : 'Edit mcp.json to enable or disable this server.',
                    (enabled) => {
                        if (server.source !== 'workspace') {
                            toggle.set_active(server.enabled);
                            return;
                        }

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
                    row.add_suffix(authButton);
                }

                toggle.set_sensitive(server.source === 'workspace');
                row.add_suffix(refreshButton);
                row.add_suffix(toggle);
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
