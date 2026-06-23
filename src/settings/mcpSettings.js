import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    MCP_TRANSPORT_HTTP,
    MCP_TRANSPORT_STDIO,
} from '../mcp/config.js';

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

function promptForText(parent, heading, placeholder, onSave) {
    const entry = new Gtk.Entry({
        placeholder_text: placeholder,
        hexpand: true,
    });
    const dialog = new Adw.AlertDialog({ heading });
    dialog.set_extra_child(entry);
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('save', 'Save');
    dialog.set_default_response('save');
    dialog.set_close_response('cancel');
    dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
    dialog.choose(parent, null, (_dialog, result) => {
        if (dialog.choose_finish(result) !== 'save')
            return;

        onSave(entry.get_text());
    });
}

function parseCommandLine(commandLine) {
    const source = String(commandLine ?? '').trim();
    const parts = [];
    let current = '';
    let quote = '';
    let escaped = false;

    for (const char of source) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (quote) {
            if (char === quote)
                quote = '';
            else
                current += char;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current) {
                parts.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current)
        parts.push(current);

    return parts;
}

function displayCommand(server) {
    if (server.transport === MCP_TRANSPORT_HTTP)
        return server.url;

    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
}

function serverSubtitle(server) {
    const source = server.source === 'file'
        ? `Config file: ${server.sourcePath}`
        : 'Settings';
    const status = server.status
        ? `${server.status.state}: ${server.status.message}`
        : 'idle: Not connected.';
    const counts = [
        `${server.toolCount ?? 0} tools`,
        `${server.resourceCount ?? 0} resources`,
        `${server.promptCount ?? 0} prompts`,
    ].join(', ');

    return [
        `${server.transport} · ${source}`,
        displayCommand(server),
        `${status} · ${counts}`,
    ].filter(Boolean).join('\n');
}

function nameFromCommand(command) {
    const basename = GLib.path_get_basename(command);
    return basename || 'MCP Server';
}

function nameFromUrl(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() || 'MCP Server';
    } catch (_error) {
        return 'MCP Server';
    }
}

function addServerRows(group, parent, mcpManager, refresh, onChanged) {
    const rows = [];

    for (const server of mcpManager.listServers()) {
        const row = new Adw.ActionRow({
            title: server.name,
            subtitle: serverSubtitle(server),
        });
        const enabledSwitch = new Gtk.Switch({
            active: Boolean(server.enabled),
            sensitive: server.source === 'workspace',
            tooltip_text: server.source === 'workspace'
                ? 'Enable this MCP server'
                : 'Edit config-file servers in mcp.json',
            valign: Gtk.Align.CENTER,
        });
        enabledSwitch.connect('notify::active', () => {
            try {
                mcpManager.setServerEnabled(server.key, enabledSwitch.get_active());
                refresh();
                onChanged();
            } catch (error) {
                logError(error, 'Failed to update MCP server enabled state');
            }
        });
        row.add_suffix(enabledSwitch);
        row.add_suffix(createActionButton('view-refresh-symbolic', 'Refresh MCP server', async () => {
            try {
                await mcpManager.refreshServer(server.key, { timeoutSeconds: 10 });
                refresh();
                onChanged();
            } catch (error) {
                logError(error, 'Failed to refresh MCP server');
                refresh();
            }
        }));

        if (server.source === 'workspace') {
            row.add_suffix(createActionButton('user-trash-symbolic', 'Delete MCP server', () => {
                try {
                    mcpManager.deleteServer(server.key);
                    refresh();
                    onChanged();
                } catch (error) {
                    logError(error, 'Failed to delete MCP server');
                }
            }));
        }

        group.add(row);
        rows.push(row);
    }

    if (rows.length === 0) {
        const emptyRow = new Adw.ActionRow({
            title: 'No MCP servers',
            subtitle: 'Add a server here or define mcpServers in the config file.',
        });
        group.add(emptyRow);
        rows.push(emptyRow);
    }

    return rows;
}

export function createMcpSettingsPage(parent, mcpManager, onChanged = () => {}) {
    const page = new Adw.PreferencesPage({
        title: 'MCP',
        icon_name: 'network-server-symbolic',
    });
    const refreshers = [];
    const refresh = () => {
        for (const refresher of refreshers)
            refresher();
    };

    const configGroup = new Adw.PreferencesGroup({
        title: 'Config File',
        description: 'Cusco loads MCP servers from this file and from servers added below.',
    });
    const configRow = new Adw.ActionRow({
        title: 'mcp.json',
        subtitle: mcpManager.configPath,
    });
    configRow.add_suffix(createActionButton('view-refresh-symbolic', 'Reload MCP config file', () => {
        mcpManager.reloadConfig();
        refresh();
        onChanged();
    }));
    configGroup.add(configRow);
    const renderConfig = () => {
        configRow.set_subtitle(mcpManager.configError
            ? `${mcpManager.configPath}\nError: ${mcpManager.configError}`
            : mcpManager.configPath);
    };
    refreshers.push(renderConfig);
    renderConfig();

    const addGroup = new Adw.PreferencesGroup({
        title: 'Add Server',
    });
    const addStdioRow = new Adw.ActionRow({
        title: 'Add stdio server',
        subtitle: 'Run a local MCP server command.',
    });
    addStdioRow.add_suffix(createActionButton('list-add-symbolic', 'Add stdio MCP server', () => {
        promptForText(parent, 'Add MCP Stdio Server', 'command --arg value', (commandLine) => {
            const argv = parseCommandLine(commandLine);

            if (argv.length === 0)
                return;

            try {
                mcpManager.addWorkspaceServer({
                    name: nameFromCommand(argv[0]),
                    transport: MCP_TRANSPORT_STDIO,
                    command: argv[0],
                    args: argv.slice(1),
                    enabled: false,
                    permissionPolicy: 'ask',
                });
                refresh();
                onChanged();
            } catch (error) {
                logError(error, 'Failed to add MCP stdio server');
            }
        });
    }));
    addGroup.add(addStdioRow);

    const addHttpRow = new Adw.ActionRow({
        title: 'Add HTTP server',
        subtitle: 'Connect to a Streamable HTTP MCP endpoint.',
    });
    addHttpRow.add_suffix(createActionButton('list-add-symbolic', 'Add HTTP MCP server', () => {
        promptForText(parent, 'Add MCP HTTP Server', 'https://example.com/mcp', (url) => {
            const normalizedUrl = String(url ?? '').trim();

            if (!normalizedUrl)
                return;

            try {
                mcpManager.addWorkspaceServer({
                    name: nameFromUrl(normalizedUrl),
                    transport: MCP_TRANSPORT_HTTP,
                    url: normalizedUrl,
                    enabled: false,
                    permissionPolicy: 'ask',
                });
                refresh();
                onChanged();
            } catch (error) {
                logError(error, 'Failed to add MCP HTTP server');
            }
        });
    }));
    addGroup.add(addHttpRow);

    const serversGroup = new Adw.PreferencesGroup({
        title: 'Servers',
        description: 'Enabled servers expose namespaced tools to Agent Mode.',
    });
    let serverRows = [];
    const renderServers = () => {
        for (const row of serverRows)
            serversGroup.remove(row);

        serverRows = addServerRows(serversGroup, parent, mcpManager, refresh, onChanged);
    };
    refreshers.push(renderServers);
    renderServers();

    page.add(configGroup);
    page.add(addGroup);
    page.add(serversGroup);
    return page;
}
