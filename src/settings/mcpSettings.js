import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import {
    MCP_TRANSPORT_HTTP,
    MCP_TRANSPORT_STDIO,
} from '../mcp/config.js';
import { presentDetailDialog } from '../detailDialog.js';

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function createEntryRow(title, placeholderText = '') {
    return new Adw.EntryRow({
        title,
        text: '',
        input_purpose: Gtk.InputPurpose.FREE_FORM,
        tooltip_text: placeholderText || null,
    });
}

function createDynamicListEditor({
    title,
    description = '',
    entryTitle,
    addTooltip,
    initialValues = [],
    validate = () => true,
    onChanged = () => {},
}) {
    const group = new Adw.PreferencesGroup({ title, description });
    const rows = [];
    const addRow = (initialValue = '') => {
        const row = createEntryRow(entryTitle);
        const removeButton = createActionButton(
            'user-trash-symbolic',
            `Remove ${entryTitle.toLowerCase()}`,
            () => {
                group.remove(row);
                rows.splice(rows.indexOf(row), 1);
                onChanged();
            },
        );

        row.set_text(initialValue);
        row.add_suffix(removeButton);
        row.connect('changed', onChanged);
        rows.push(row);
        group.add(row);
        onChanged();
    };
    const addButton = createActionButton('list-add-symbolic', addTooltip, () => addRow());

    group.set_header_suffix(addButton);
    const startingValues = Array.isArray(initialValues)
        ? initialValues.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];

    for (const value of startingValues.length > 0 ? startingValues : [''])
        addRow(value);
    return {
        widget: group,
        values: () => rows.map((row) => row.get_text().trim()).filter(Boolean),
        isValid: () => {
            const values = rows.map((row) => row.get_text().trim()).filter(Boolean);
            return values.every(validate) && new Set(values).size === values.length;
        },
    };
}

function createKeyValueEditor({
    title,
    description = '',
    keyPlaceholder = 'Key',
    valuePlaceholder = 'Value',
    addTooltip,
    validateKey = () => true,
    validateValue = () => true,
    onChanged = () => {},
}) {
    const group = new Adw.PreferencesGroup({ title, description });
    const rows = [];
    const addRow = (initialKey = '', initialValue = '') => {
        const row = new Adw.PreferencesRow();
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 0,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 12,
            margin_end: 8,
        });
        const keyEntry = new Gtk.Entry({
            placeholder_text: keyPlaceholder,
            text: initialKey,
            hexpand: true,
            has_frame: false,
            width_chars: 1,
        });
        const valueEntry = new Gtk.Entry({
            placeholder_text: valuePlaceholder,
            text: initialValue,
            hexpand: true,
            has_frame: false,
            width_chars: 1,
        });
        const separator = new Gtk.Separator({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 6,
            margin_bottom: 6,
        });
        const removeButton = createActionButton('user-trash-symbolic', `Remove ${title} entry`, () => {
            group.remove(row);
            rows.splice(rows.findIndex((item) => item.row === row), 1);
            onChanged();
        });

        content.add_css_class('cusco-mcp-key-value-row');
        keyEntry.add_css_class('flat');
        valueEntry.add_css_class('flat');
        keyEntry.connect('changed', onChanged);
        valueEntry.connect('changed', onChanged);
        content.append(keyEntry);
        content.append(separator);
        content.append(valueEntry);
        content.append(removeButton);
        row.set_child(content);
        rows.push({ row, keyEntry, valueEntry });
        group.add(row);
        onChanged();
    };
    const addButton = createActionButton('list-add-symbolic', addTooltip, () => addRow());

    group.set_header_suffix(addButton);
    addRow();
    return {
        widget: group,
        value: () => Object.fromEntries(rows
            .map(({ keyEntry, valueEntry }) => [
                keyEntry.get_text().trim(),
                valueEntry.get_text().trim(),
            ])
            .filter(([key, value]) => key && value)),
        isValid: () => {
            const pairs = rows.map(({ keyEntry, valueEntry }) => [
                keyEntry.get_text().trim(),
                valueEntry.get_text().trim(),
            ]);
            const populated = pairs.filter(([key, value]) => key || value);
            const keys = populated.map(([key]) => key);

            return populated.every(([key, value]) => (
                key
                && value
                && validateKey(key)
                && validateValue(value)
            )) && new Set(keys).size === keys.length;
        },
    };
}

function expandUserPath(path) {
    const value = String(path ?? '').trim();

    if (value === '~')
        return GLib.get_home_dir();
    if (value.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), value.slice(2)]);
    return value;
}

function isHttpUrl(value) {
    return /^https?:\/\/[^\s]+$/i.test(String(value ?? '').trim());
}

function isLoopbackCallbackUrl(value) {
    const text = String(value ?? '').trim();

    if (!text)
        return true;

    try {
        const uri = GLib.Uri.parse(text, GLib.UriFlags.NONE);
        const host = String(uri.get_host() ?? '').toLowerCase();

        return uri.get_scheme() === 'http'
            && (host === 'localhost' || host === '::1' || host.startsWith('127.'))
            && !uri.get_query()
            && !uri.get_fragment();
    } catch (_error) {
        return false;
    }
}

function isOptionalPort(value) {
    const text = String(value ?? '').trim();

    if (!text)
        return true;

    const port = Number(text);
    return Number.isInteger(port) && port > 0 && port <= 65535;
}

function commandArgv(value) {
    try {
        const [, argv] = GLib.shell_parse_argv(String(value ?? '').trim());
        return argv ?? [];
    } catch (_error) {
        return [];
    }
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
    case 'authorizing':
        return 'Authorizing';
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
    case 'authorizing':
        return 'connecting';
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
    const statusMessage = ['auth_required', 'authorizing', 'error'].includes(status.state)
        ? status.message
        : '';

    return [
        counts,
        statusMessage,
        status.auth?.scope ? `Scope: ${status.auth.scope}` : '',
        `${server.source === 'file' ? 'mcp.json' : 'Workspace'} · ${server.transport}`,
    ].filter(Boolean).join('\n');
}

export function presentAddMcpServerDialog(
    parent,
    mcpManager,
    onAdded = () => {},
    options = {},
) {
    const defaults = options.defaults ?? {};
    let syncSaveState = () => {};
    const identityGroup = new Adw.PreferencesGroup({
        title: 'Server',
        description: 'Choose how Cusco connects to this MCP server.',
    });
    const nameRow = createEntryRow('Name', 'MCP server name');
    const typeRow = new Adw.ActionRow({ title: 'Type' });
    const typeButtons = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 0,
        homogeneous: true,
        valign: Gtk.Align.CENTER,
    });
    const stdioButton = new Gtk.ToggleButton({
        label: 'STDIO',
        active: true,
        valign: Gtk.Align.CENTER,
    });
    const httpButton = new Gtk.ToggleButton({
        label: 'Streamable HTTP',
        valign: Gtk.Align.CENTER,
    });

    typeButtons.add_css_class('linked');
    httpButton.set_group(stdioButton);
    if (defaults.transport === MCP_TRANSPORT_HTTP)
        httpButton.set_active(true);
    typeButtons.append(stdioButton);
    typeButtons.append(httpButton);
    typeRow.add_suffix(typeButtons);
    identityGroup.add(nameRow);
    identityGroup.add(typeRow);

    const commandGroup = new Adw.PreferencesGroup({
        title: 'Local process',
        description: 'Launch a command and communicate over standard input and output.',
    });
    const commandRow = createEntryRow('Command to launch', 'mcp-server');

    nameRow.set_text(String(defaults.name ?? ''));
    commandRow.set_text(String(defaults.command ?? ''));

    commandGroup.add(commandRow);
    const argumentsEditor = createDynamicListEditor({
        title: 'Arguments',
        entryTitle: 'Argument',
        addTooltip: 'Add argument',
        onChanged: () => syncSaveState(),
    });
    const environmentEditor = createKeyValueEditor({
        title: 'Environment variables',
        keyPlaceholder: 'Name',
        valuePlaceholder: 'Value',
        addTooltip: 'Add environment variable',
        validateKey: (value) => ENVIRONMENT_NAME_PATTERN.test(value),
        onChanged: () => syncSaveState(),
    });
    const passthroughEditor = createDynamicListEditor({
        title: 'Environment variable passthrough',
        description: 'Pass values from Cusco’s environment without storing their contents.',
        entryTitle: 'Variable name',
        addTooltip: 'Add passthrough variable',
        validate: (value) => ENVIRONMENT_NAME_PATTERN.test(value),
        onChanged: () => syncSaveState(),
    });
    const workingDirectoryGroup = new Adw.PreferencesGroup({
        title: 'Working directory',
        description: 'Optional directory used when the server process starts.',
    });
    const workingDirectoryRow = createEntryRow('Path', '~/code');

    workingDirectoryRow.set_text(String(defaults.cwd ?? ''));

    workingDirectoryGroup.add(workingDirectoryRow);
    const stdioContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 18,
    });

    stdioContent.append(commandGroup);
    stdioContent.append(argumentsEditor.widget);
    stdioContent.append(environmentEditor.widget);
    stdioContent.append(passthroughEditor.widget);
    stdioContent.append(workingDirectoryGroup);

    const endpointGroup = new Adw.PreferencesGroup({
        title: 'Remote endpoint',
        description: 'Connect to an MCP server over Streamable HTTP.',
    });
    const urlRow = createEntryRow('URL', 'https://mcp.example.com/mcp');
    const bearerTokenRow = createEntryRow('Bearer token environment variable', 'MCP_BEARER_TOKEN');

    urlRow.set_text(String(defaults.url ?? ''));
    bearerTokenRow.set_text(String(defaults.bearerTokenEnvVar ?? ''));

    endpointGroup.add(urlRow);
    endpointGroup.add(bearerTokenRow);
    const headersEditor = createKeyValueEditor({
        title: 'Headers',
        keyPlaceholder: 'Header name',
        valuePlaceholder: 'Value',
        addTooltip: 'Add header',
        onChanged: () => syncSaveState(),
    });
    const headerEnvironmentEditor = createKeyValueEditor({
        title: 'Headers from environment variables',
        description: 'Resolve header values at connection time without storing secrets.',
        keyPlaceholder: 'Header name',
        valuePlaceholder: 'Environment variable',
        addTooltip: 'Add environment header',
        validateValue: (value) => ENVIRONMENT_NAME_PATTERN.test(value),
        onChanged: () => syncSaveState(),
    });
    const allowedToolsEditor = createDynamicListEditor({
        title: 'Allowed tools',
        description: 'Optional raw MCP tool names exposed to Agent Mode. Leave empty to expose every discovered tool.',
        entryTitle: 'Tool name',
        addTooltip: 'Add allowed tool',
        initialValues: defaults.allowedTools,
        onChanged: () => syncSaveState(),
    });
    const oauthGroup = new Adw.PreferencesGroup({
        title: 'OAuth',
        description: 'Usually automatic. Use these fields for servers that require a fixed resource, pre-registered client, or callback.',
    });
    const oauthResourceRow = createEntryRow('Resource URL', 'https://mcp.example.com/mcp');
    const oauthClientIdRow = createEntryRow('Client ID', 'Pre-registered client ID or HTTPS metadata URL');
    const oauthClientSecretEnvRow = createEntryRow('Client secret environment variable', 'MCP_OAUTH_CLIENT_SECRET');
    const oauthTokenAuthMethodRow = createEntryRow(
        'Token endpoint authentication',
        'none, client_secret_post, or client_secret_basic',
    );
    const oauthCallbackUrlRow = createEntryRow('Callback URL', 'http://127.0.0.1:32123/callback');
    const oauthCallbackPortRow = createEntryRow('Callback port', '32123');
    const oauthScopesRow = createEntryRow('Scopes', 'Space-separated scopes');
    const oauthDefaults = defaults.oauth ?? {};
    const requireOauthClientId = options.requireOauthClientId === true
        || oauthDefaults.clientIdRequired === true;

    oauthResourceRow.set_text(String(oauthDefaults.resource ?? defaults.oauthResource ?? ''));
    oauthClientIdRow.set_text(String(oauthDefaults.clientId ?? ''));
    oauthClientSecretEnvRow.set_text(String(oauthDefaults.clientSecretEnvVar ?? ''));
    oauthTokenAuthMethodRow.set_text(String(oauthDefaults.tokenEndpointAuthMethod ?? ''));
    oauthCallbackUrlRow.set_text(String(oauthDefaults.callbackUrl ?? ''));
    oauthCallbackPortRow.set_text(oauthDefaults.callbackPort ? String(oauthDefaults.callbackPort) : '');
    oauthScopesRow.set_text(Array.isArray(oauthDefaults.scopes)
        ? oauthDefaults.scopes.join(' ')
        : String(oauthDefaults.scopes ?? ''));

    for (const row of [
        oauthResourceRow,
        oauthClientIdRow,
        oauthClientSecretEnvRow,
        oauthTokenAuthMethodRow,
        oauthCallbackUrlRow,
        oauthCallbackPortRow,
        oauthScopesRow,
    ]) {
        oauthGroup.add(row);
    }
    const httpContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 18,
    });

    httpContent.append(endpointGroup);
    httpContent.append(oauthGroup);
    httpContent.append(allowedToolsEditor.widget);
    httpContent.append(headersEditor.widget);
    httpContent.append(headerEnvironmentEditor.widget);

    const transportStack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        transition_duration: 160,
    });
    transportStack.add_named(stdioContent, MCP_TRANSPORT_STDIO);
    transportStack.add_named(httpContent, MCP_TRANSPORT_HTTP);
    transportStack.set_visible_child_name(
        defaults.transport === MCP_TRANSPORT_HTTP
            ? MCP_TRANSPORT_HTTP
            : MCP_TRANSPORT_STDIO,
    );

    const form = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 18,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 24,
        margin_end: 24,
    });
    form.append(identityGroup);
    form.append(transportStack);
    const scroller = new Gtk.ScrolledWindow({
        child: form,
        min_content_height: 430,
        max_content_height: 620,
        propagate_natural_height: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        window_placement: Gtk.CornerType.TOP_LEFT,
        vexpand: true,
    });
    const body = new Gtk.Label({
        label: options.body ?? 'Configure a local command or a Streamable HTTP endpoint.',
        justify: Gtk.Justification.CENTER,
        wrap: true,
        xalign: 0.5,
        margin_top: 8,
        margin_bottom: 14,
        margin_start: 24,
        margin_end: 24,
    });
    body.add_css_class('dim-label');
    const actions = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        homogeneous: true,
        margin_top: 12,
        margin_bottom: 16,
        margin_start: 24,
        margin_end: 24,
    });
    const cancelButton = new Gtk.Button({ label: 'Cancel' });
    const saveButton = new Gtk.Button({ label: 'Add Server' });
    saveButton.add_css_class('suggested-action');
    actions.append(cancelButton);
    actions.append(saveButton);
    const dialogContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
    });
    dialogContent.append(body);
    dialogContent.append(scroller);
    dialogContent.append(actions);
    const dialog = presentDetailDialog(parent, {
        title: options.heading ?? 'Add MCP Server',
        child: dialogContent,
        focusWidget: nameRow,
    });

    dialog.set_default_widget(saveButton);
    cancelButton.connect('clicked', () => dialog.close());

    const activeTransport = () => httpButton.get_active()
        ? MCP_TRANSPORT_HTTP
        : MCP_TRANSPORT_STDIO;
    syncSaveState = () => {
        const transport = activeTransport();
        const coreValid = Boolean(nameRow.get_text().trim())
            && (transport === MCP_TRANSPORT_STDIO
                ? commandArgv(commandRow.get_text()).length > 0
                : isHttpUrl(urlRow.get_text()))
            && (transport === MCP_TRANSPORT_STDIO
                || !bearerTokenRow.get_text().trim()
                || ENVIRONMENT_NAME_PATTERN.test(bearerTokenRow.get_text().trim()));
        const detailsValid = transport === MCP_TRANSPORT_STDIO
            ? argumentsEditor.isValid()
                && environmentEditor.isValid()
                && passthroughEditor.isValid()
            : headersEditor.isValid()
                && headerEnvironmentEditor.isValid()
                && allowedToolsEditor.isValid()
                && (!oauthResourceRow.get_text().trim() || isHttpUrl(oauthResourceRow.get_text()))
                && (!requireOauthClientId || oauthClientIdRow.get_text().trim())
                && (!oauthClientSecretEnvRow.get_text().trim()
                    || ENVIRONMENT_NAME_PATTERN.test(oauthClientSecretEnvRow.get_text().trim()))
                && ['', 'none', 'client_secret_post', 'client_secret_basic']
                    .includes(oauthTokenAuthMethodRow.get_text().trim())
                && isLoopbackCallbackUrl(oauthCallbackUrlRow.get_text())
                && isOptionalPort(oauthCallbackPortRow.get_text());

        saveButton.set_sensitive(coreValid && detailsValid);
    };
    const syncTransport = () => {
        const transport = activeTransport();

        transportStack.set_visible_child_name(transport);
        syncSaveState();
    };

    for (const entry of [
        nameRow,
        commandRow,
        workingDirectoryRow,
        urlRow,
        bearerTokenRow,
        oauthResourceRow,
        oauthClientIdRow,
        oauthClientSecretEnvRow,
        oauthTokenAuthMethodRow,
        oauthCallbackUrlRow,
        oauthCallbackPortRow,
        oauthScopesRow,
    ]) {
        entry.connect('changed', syncSaveState);
    }
    stdioButton.connect('toggled', () => {
        if (stdioButton.get_active())
            syncTransport();
    });
    httpButton.connect('toggled', () => {
        if (httpButton.get_active())
            syncTransport();
    });
    syncSaveState();

    saveButton.connect('clicked', () => {
        const transport = activeTransport();
        const server = {
            ...(defaults.id ? { id: String(defaults.id) } : {}),
            name: nameRow.get_text().trim(),
            transport,
            enabled: true,
            permissionPolicy: 'ask',
        };

        if (transport === MCP_TRANSPORT_STDIO) {
            const [command, ...commandArguments] = commandArgv(commandRow.get_text());

            Object.assign(server, {
                command,
                args: [...commandArguments, ...argumentsEditor.values()],
                cwd: expandUserPath(workingDirectoryRow.get_text()),
                env: environmentEditor.value(),
                envPassthrough: passthroughEditor.values(),
            });
        } else {
            const allowedTools = allowedToolsEditor.values();

            Object.assign(server, {
                url: urlRow.get_text().trim(),
                bearerTokenEnvVar: bearerTokenRow.get_text().trim(),
                headers: headersEditor.value(),
                headerEnv: headerEnvironmentEditor.value(),
                oauth: {
                    resource: oauthResourceRow.get_text().trim(),
                    clientId: oauthClientIdRow.get_text().trim(),
                    clientSecretEnvVar: oauthClientSecretEnvRow.get_text().trim(),
                    tokenEndpointAuthMethod: oauthTokenAuthMethodRow.get_text().trim(),
                    callbackUrl: oauthCallbackUrlRow.get_text().trim(),
                    callbackPort: Number(oauthCallbackPortRow.get_text().trim()) || 0,
                    scopes: oauthScopesRow.get_text().trim().split(/\s+/).filter(Boolean),
                },
                ...(allowedTools.length > 0 ? { allowedTools } : {}),
            });
        }

        try {
            const added = mcpManager.addWorkspaceServer(server);
            dialog.close();
            onAdded(added);
        } catch (error) {
            logError(error, 'Failed to add MCP server');
            presentError(parent, 'Could Not Add MCP Server', error);
        }
    });

    return dialog;
}

function createMcpConfigController(parent, mcpManager, onChanged = () => {}) {
    const configGroup = new Adw.PreferencesGroup({
        title: 'MCP Servers',
        description: 'Manage local commands, remote endpoints, and servers loaded from mcp.json.',
    });
    const addButton = new Gtk.Button({
        label: 'Add MCP Server',
        tooltip_text: 'Add MCP server',
        valign: Gtk.Align.CENTER,
    });
    addButton.add_css_class('suggested-action');
    configGroup.set_header_suffix(addButton);
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

                if (server.authenticated) {
                    actions.append(createActionButton(
                        'system-log-out-symbolic',
                        `Sign out of ${server.name}`,
                        () => {
                            try {
                                mcpManager.clearServerAuthorization(server.key);
                                renderConfig();
                                onChanged();
                            } catch (error) {
                                logError(error, 'Failed to clear MCP authorization');
                                presentError(parent, `Sign out of ${server.name}`, error);
                            }
                        },
                    ));
                }

                if (server.source === 'workspace') {
                    actions.append(createActionButton(
                        'user-trash-symbolic',
                        `Remove ${server.name}`,
                        () => {
                            const dialog = new Adw.AlertDialog({
                                heading: `Remove ${server.name}?`,
                                body: 'Cusco will remove this server configuration.',
                            });
                            dialog.add_response('cancel', 'Cancel');
                            dialog.add_response('remove', 'Remove');
                            dialog.set_default_response('cancel');
                            dialog.set_close_response('cancel');
                            dialog.set_response_appearance(
                                'remove',
                                Adw.ResponseAppearance.DESTRUCTIVE,
                            );
                            dialog.choose(parent, null, (_dialog, result) => {
                                if (dialog.choose_finish(result) !== 'remove')
                                    return;

                                try {
                                    mcpManager.deleteServer(server.key);
                                    renderConfig();
                                    onChanged();
                                } catch (error) {
                                    logError(error, 'Failed to remove MCP server');
                                    presentError(parent, `Remove ${server.name}`, error);
                                }
                            });
                        },
                    ));
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

    addButton.connect('clicked', () => {
        presentAddMcpServerDialog(parent, mcpManager, () => {
            renderConfig();
            onChanged();
        });
    });

    configGroup.add(configRow);
    renderConfig();
    return {
        widget: configGroup,
        refresh: renderConfig,
        addButton,
    };
}

export function createMcpConfigGroup(parent, mcpManager, onChanged = () => {}) {
    return createMcpConfigController(parent, mcpManager, onChanged).widget;
}

export function createMcpManagementPage(parent, mcpManager, onChanged = () => {}) {
    const page = new Adw.PreferencesPage({
        title: 'MCP',
        icon_name: 'network-server-symbolic',
    });
    const config = createMcpConfigController(parent, mcpManager, onChanged);

    page.add(config.widget);
    return {
        widget: page,
        refresh: config.refresh,
        addButton: config.addButton,
    };
}

export function createMcpSettingsPage(parent, mcpManager, onChanged = () => {}) {
    return createMcpManagementPage(parent, mcpManager, onChanged).widget;
}
