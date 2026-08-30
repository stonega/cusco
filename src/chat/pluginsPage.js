import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    createMcpManagementPage,
    presentAddMcpServerDialog,
} from '../settings/mcpSettings.js';
import {
    createSkillsManagementPage,
    presentSkillDetailsDialog,
} from '../settings/workspaceSettings.js';
import { presentDetailDialog } from '../detailDialog.js';

const BUNDLED_PLUGIN_DEVELOPER = 'Cusco';

function isCancelled(error) {
    return typeof error?.matches === 'function'
        && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function pluginPartsLabel(plugin) {
    return [
        plugin.hasSkills ? 'Skills' : '',
        plugin.hasMcpServers ? 'MCP' : '',
        plugin.hasApps ? 'Connector' : '',
        plugin.hasHooks ? 'Hooks' : '',
    ].filter(Boolean).join(' + ');
}

function pluginSubtitle(plugin) {
    const identity = [
        BUNDLED_PLUGIN_DEVELOPER,
        plugin.category,
        plugin.version ? `v${plugin.version}` : '',
    ].filter(Boolean).join(' · ');
    const parts = pluginPartsLabel(plugin);

    return [plugin.description, identity, parts].filter(Boolean).join('\n');
}

function pluginSearchText(plugin) {
    return [
        plugin.displayName,
        plugin.name,
        plugin.description,
        BUNDLED_PLUGIN_DEVELOPER,
        plugin.category,
        plugin.marketplaceName,
        ...(plugin.capabilities ?? []),
    ].join(' ').toLowerCase();
}

function createPluginAvatar(plugin) {
    const avatar = new Adw.Avatar({
        size: 42,
        text: plugin.displayName,
        show_initials: true,
        valign: Gtk.Align.CENTER,
    });
    avatar.add_css_class('cusco-plugin-avatar');

    if (plugin.logoPath) {
        try {
            avatar.set_custom_image(Gdk.Texture.new_from_filename(plugin.logoPath));
        } catch (error) {
            logError(error, `Failed to load logo for ${plugin.pluginId}`);
        }
    }

    return avatar;
}

function createLoadingView() {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: true,
        vexpand: true,
    });
    const spinner = new Gtk.Spinner({ spinning: true });
    spinner.set_size_request(32, 32);
    const label = new Gtk.Label({ label: 'Fetching Cusco plugins…' });
    label.add_css_class('dim-label');
    box.append(spinner);
    box.append(label);
    return box;
}

function detailValueRow(title, value) {
    return new Adw.ActionRow({
        title,
        subtitle: String(value ?? ''),
        subtitle_lines: 3,
    });
}

function pluginConnectionLabel(plugin) {
    const connectors = plugin.connectors ?? [];

    if (connectors.length === 0)
        return '';
    if (connectors.every((connector) => connector.connected))
        return 'Connected';
    if (connectors.some((connector) => connector.status === 'connecting'))
        return 'Connecting';
    if (connectors.some((connector) => (
        connector.type === 'gnome-online-accounts'
        && connector.status === 'unconfigured'
    )))
        return 'Online account required';
    if (connectors.some((connector) => !connector.server && connector.status === 'unconfigured'))
        return 'MCP endpoint required';
    if (connectors.some((connector) => pluginConnectorNeedsSetup(connector)))
        return 'OAuth client required';
    if (connectors.some((connector) => connector.bearerTokenRequired))
        return 'Access token required';

    return 'Not connected';
}

export function pluginConnectorNeedsSetup(connector) {
    return !connector?.server
        || (connector.server.oauth?.clientIdRequired === true
            && !connector.server.oauth?.clientId);
}

export function presentGoaAccountChooser(parent, accounts, options = {}) {
    return new Promise((resolve) => {
        const labels = accounts.map((account) => {
            const identity = account.emailAddress || account.presentationIdentity || '';
            const provider = account.providerName || '';

            return identity && provider
                ? `${identity} — ${provider}`
                : identity || provider || 'Online account';
        });
        const model = Gtk.StringList.new(labels);
        const selector = new Gtk.DropDown({ model, hexpand: true });
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 6,
            margin_bottom: 6,
        });
        const explanation = new Gtk.Label({
            label: 'Cusco stores only the selected GNOME Online Account ID. Authentication remains managed by GNOME.',
            xalign: 0,
            wrap: true,
        });
        explanation.add_css_class('dim-label');
        content.append(explanation);
        content.append(selector);

        const dialog = new Adw.AlertDialog({
            heading: options.heading || 'Choose an online account',
            body: options.body || 'Select the account Cusco may use.',
            extra_child: content,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('connect', 'Connect');
        dialog.set_default_response('connect');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('connect', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            resolve(response === 'connect'
                ? accounts[selector.get_selected()] ?? null
                : null);
        });
        dialog.present(parent);
    });
}

export function presentBearerCredentialDialog(parent, plugin, connector) {
    return new Promise((resolve) => {
        const tokenRow = new Adw.PasswordEntryRow({
            title: 'Access token',
            text: '',
        });
        const group = new Adw.PreferencesGroup({
            description: [
                'Cusco stores this token in Secret Service and never writes it to plugin settings.',
                connector?.bearerTokenEnvVar
                    ? `Environment alternative: ${connector.bearerTokenEnvVar}.`
                    : '',
            ].filter(Boolean).join(' '),
        });
        group.add(tokenRow);

        const dialog = new Adw.AlertDialog({
            heading: `Connect ${plugin.displayName}`,
            body: 'Enter a bearer token accepted by this plugin’s MCP server.',
            extra_child: group,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('connect', 'Connect');
        dialog.set_default_response('connect');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('connect', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_response_enabled('connect', false);
        tokenRow.connect('changed', () => {
            dialog.set_response_enabled('connect', Boolean(tokenRow.get_text().trim()));
        });
        dialog.connect('response', (_dialog, response) => {
            resolve(response === 'connect' ? tokenRow.get_text().trim() : null);
        });
        dialog.present(parent);
    });
}

export function presentPluginDetailsDialog(parent, plugin) {
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        margin_top: 4,
        margin_bottom: 4,
        margin_start: 4,
        margin_end: 4,
    });
    const hero = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 14,
    });
    const avatar = createPluginAvatar(plugin);
    avatar.set_size(64);
    avatar.add_css_class('cusco-detail-avatar');
    const heroCopy = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 5,
        hexpand: true,
        valign: Gtk.Align.CENTER,
    });
    const description = new Gtk.Label({
        label: plugin.longDescription || plugin.description || 'No description provided.',
        xalign: 0,
        wrap: true,
        selectable: true,
        max_width_chars: 62,
    });
    description.add_css_class('cusco-detail-description');
    heroCopy.append(description);
    hero.append(avatar);
    hero.append(heroCopy);
    hero.add_css_class('cusco-detail-hero');
    content.append(hero);

    const details = new Adw.PreferencesGroup({ title: 'Details' });
    const status = plugin.installed
        ? (plugin.enabled ? 'Installed and enabled' : 'Installed and disabled')
        : 'Available to install';
    details.add(detailValueRow('Status', status));

    if (plugin.category)
        details.add(detailValueRow('Category', plugin.category));
    if (plugin.version)
        details.add(detailValueRow('Version', plugin.version));
    details.add(detailValueRow('Developer', BUNDLED_PLUGIN_DEVELOPER));

    const parts = pluginPartsLabel(plugin);
    if (parts)
        details.add(detailValueRow('Includes', parts));

    const connection = pluginConnectionLabel(plugin);
    if (connection)
        details.add(detailValueRow('Connection', connection));

    content.append(details);

    if (plugin.capabilities?.length) {
        const capabilities = new Adw.PreferencesGroup({ title: 'Capabilities' });
        capabilities.add(detailValueRow('Access', plugin.capabilities.join(', ')));
        content.append(capabilities);
    }

    if (plugin.defaultPrompts?.length) {
        const prompts = new Adw.PreferencesGroup({ title: 'Example requests' });

        for (const prompt of plugin.defaultPrompts)
            prompts.add(detailValueRow('Try asking', prompt));

        content.append(prompts);
    }

    const scroller = new Gtk.ScrolledWindow({
        child: content,
        min_content_height: 300,
        max_content_height: 560,
        propagate_natural_height: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
    });
    scroller.add_css_class('cusco-detail-dialog-content');
    return presentDetailDialog(parent, {
        title: plugin.displayName || 'Plugin details',
        child: scroller,
    });
}

export class PluginsPage {
    constructor({
        client,
        getParentWindow = () => null,
        gmailConnector = null,
        goaConnectors = null,
        mcpManager = null,
        onBack = () => {},
        onChanged = () => {},
        onManagementChanged = () => {},
        onToast = () => {},
        presentPluginDetails = presentPluginDetailsDialog,
        presentBearerCredential = presentBearerCredentialDialog,
        presentSkillDetails = presentSkillDetailsDialog,
        workspaceManager = null,
    }) {
        this._client = client;
        this._getParentWindow = getParentWindow;
        this._gmailConnector = gmailConnector;
        this._goaConnectors = goaConnectors instanceof Map
            ? new Map(goaConnectors)
            : new Map(Object.entries(goaConnectors ?? {}));
        if (gmailConnector && !this._goaConnectors.has('gmail-goa'))
            this._goaConnectors.set('gmail-goa', gmailConnector);
        this._mcpManager = mcpManager;
        this._onBack = onBack;
        this._onChanged = onChanged;
        this._onManagementChanged = onManagementChanged;
        this._onToast = onToast;
        this._presentPluginDetails = presentPluginDetails;
        this._presentBearerCredential = presentBearerCredential;
        this._presentSkillDetails = presentSkillDetails;
        this._workspaceManager = workspaceManager;
        this._plugins = [];
        this._pluginRows = [];
        this._filter = 'all';
        this._busyPluginActions = new Map();
        this._refreshCancellable = null;
        this._widget = null;
    }

    get widget() {
        this._widget ??= this._createSurface();
        return this._widget;
    }

    cancelRefresh() {
        this._refreshCancellable?.cancel();
        this._refreshCancellable = null;
    }

    dispose() {
        this.cancelRefresh();
        this._plugins = [];
        this._pluginRows = [];
        this._busyPluginActions.clear();
    }

    async refresh() {
        this.widget;
        this.cancelRefresh();
        const cancellable = new Gio.Cancellable();
        this._refreshCancellable = cancellable;
        this._refreshButton.set_sensitive(false);

        if (this._plugins.length === 0)
            this._contentStack.set_visible_child_name('loading');

        try {
            const plugins = await this._client.listPlugins({ cancellable });

            if (cancellable.is_cancelled())
                return;

            this._plugins = plugins;

            await this._refreshGoaAccounts(cancellable);

            this._syncConnectorStates();
            this._render();
        } catch (error) {
            if (isCancelled(error) || cancellable.is_cancelled())
                return;

            this._errorDescription.set_label(
                error?.userMessage
                || error?.message
                || 'Cusco could not load its plugin catalog.',
            );
            this._contentStack.set_visible_child_name('error');
        } finally {
            if (this._refreshCancellable === cancellable)
                this._refreshCancellable = null;
            this._refreshButton.set_sensitive(true);
        }
    }

    _createSurface() {
        const toolbarView = new Adw.ToolbarView();
        const headerBar = new Adw.HeaderBar();

        this._backButton = new Gtk.Button({
            icon_name: 'go-previous-symbolic',
            tooltip_text: 'Back to chat',
        });
        this._backButton.connect('clicked', () => this._onBack());
        headerBar.pack_start(this._backButton);

        this._refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh plugins',
        });
        this._refreshButton.connect('clicked', () => this._refreshActiveSection());
        headerBar.pack_end(this._refreshButton);

        const pageBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 14,
            vexpand: true,
            margin_top: 18,
            margin_bottom: 24,
            margin_start: 12,
            margin_end: 12,
        });
        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
        });
        this._searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search plugins',
            hexpand: true,
        });
        this._searchEntry.connect('search-changed', () => this._renderList());
        controls.append(this._searchEntry);

        const filters = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
        filters.add_css_class('linked');
        const filterDefinitions = [
            ['all', 'All'],
            ['installed', 'Installed'],
            ['available', 'Available'],
        ];
        let firstFilter = null;

        for (const [id, label] of filterDefinitions) {
            const button = new Gtk.ToggleButton({ label });

            if (firstFilter)
                button.set_group(firstFilter);
            else
                firstFilter = button;

            if (id === this._filter)
                button.set_active(true);
            if (id === 'all')
                this._allFilterButton = button;
            button.connect('toggled', () => {
                if (!button.get_active())
                    return;
                this._filter = id;
                this._renderList();
            });
            filters.append(button);
        }

        controls.append(filters);
        pageBox.append(controls);

        this._pluginList = new Adw.PreferencesGroup();

        this._showAllButton = new Gtk.Button({
            label: 'Show All Plugins',
            halign: Gtk.Align.CENTER,
        });
        this._showAllButton.add_css_class('suggested-action');
        this._showAllButton.connect('clicked', () => this._showAllPlugins());
        this._emptyState = new Adw.StatusPage({
            icon_name: 'system-search-symbolic',
            title: 'No matching plugins',
            description: 'Try a different search or filter.',
            child: this._showAllButton,
        });
        this._resultsStack = new Gtk.Stack({
            hexpand: true,
            vexpand: false,
            valign: Gtk.Align.START,
            vhomogeneous: false,
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 160,
        });
        this._resultsStack.add_named(this._pluginList, 'plugins');
        this._resultsStack.add_named(this._emptyState, 'empty');
        this._resultsStack.set_visible_child_name('plugins');
        pageBox.append(this._resultsStack);

        const clamp = new Adw.Clamp({
            maximum_size: 600,
            child: pageBox,
            vexpand: true,
        });
        this._catalogClamp = clamp;
        const scroller = new Gtk.ScrolledWindow({
            child: clamp,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        });
        this._scroller = scroller;

        this._errorDescription = new Gtk.Label({
            wrap: true,
            justify: Gtk.Justification.CENTER,
            max_width_chars: 52,
        });
        this._errorDescription.add_css_class('dim-label');
        const retryButton = new Gtk.Button({
            label: 'Try Again',
            halign: Gtk.Align.CENTER,
        });
        retryButton.add_css_class('suggested-action');
        retryButton.connect('clicked', () => this.refresh());
        const errorContent = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
        });
        errorContent.append(this._errorDescription);
        errorContent.append(retryButton);
        const errorState = new Adw.StatusPage({
            icon_name: 'dialog-error-symbolic',
            title: 'Plugins are unavailable',
            description: 'Check the Cusco marketplace configuration and try again.',
            child: errorContent,
        });

        this._contentStack = new Gtk.Stack({
            hexpand: true,
            vexpand: true,
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 160,
        });
        this._contentStack.add_named(createLoadingView(), 'loading');
        this._contentStack.add_named(scroller, 'plugins');
        this._contentStack.add_named(errorState, 'error');
        this._contentStack.set_visible_child_name('loading');

        this._sectionStack = new Adw.ViewStack({
            hexpand: true,
            vexpand: true,
        });
        const catalogSection = this._sectionStack.add_titled(
            this._contentStack,
            'plugins',
            'Plugins',
        );
        catalogSection.set_icon_name('application-x-addon-symbolic');

        const parent = this._getParentWindow();
        if (this._workspaceManager) {
            this._skillsManagement = createSkillsManagementPage(
                parent,
                this._workspaceManager,
                () => this._onManagementChanged({ section: 'skills' }),
                {
                    onShowDetails: (skill) => this._presentSkillDetails(
                        this._getParentWindow(),
                        skill,
                    ),
                },
            );
            const skillsSection = this._sectionStack.add_titled(
                this._skillsManagement.widget,
                'skills',
                'Skills',
            );
            skillsSection.set_icon_name('emblem-system-symbolic');
        }

        if (this._mcpManager) {
            this._mcpManagement = createMcpManagementPage(
                parent,
                this._mcpManager,
                () => this._onManagementChanged({ section: 'mcp' }),
            );
            const mcpSection = this._sectionStack.add_titled(
                this._mcpManagement.widget,
                'mcp',
                'MCP',
            );
            mcpSection.set_icon_name('network-server-symbolic');
        }

        this._viewSwitcher = new Adw.ViewSwitcher({
            stack: this._sectionStack,
            policy: Adw.ViewSwitcherPolicy.WIDE,
        });
        headerBar.set_title_widget(this._viewSwitcher);
        toolbarView.add_top_bar(headerBar);
        toolbarView.set_content(this._sectionStack);
        this._sectionStack.connect('notify::visible-child-name', () => {
            this._syncActiveSection();
        });
        this._sectionStack.set_visible_child_name('plugins');
        this._syncActiveSection();
        return toolbarView;
    }

    _syncActiveSection() {
        const section = this._sectionStack?.get_visible_child_name() ?? 'plugins';
        const tooltips = {
            plugins: 'Refresh plugins',
            skills: 'Refresh installed skills',
            mcp: 'Refresh MCP servers',
        };

        this._refreshButton?.set_tooltip_text(tooltips[section] ?? 'Refresh');

        if (section === 'skills')
            this._skillsManagement?.refresh();
        else if (section === 'mcp')
            this._mcpManagement?.refresh();
    }

    async _refreshActiveSection() {
        const section = this._sectionStack?.get_visible_child_name() ?? 'plugins';

        if (section === 'plugins') {
            await this.refresh();
            return;
        }

        this._refreshButton.set_sensitive(false);
        try {
            if (section === 'skills') {
                this._workspaceManager?.refreshInstalledSkills();
                this._skillsManagement?.refresh();
            } else if (section === 'mcp') {
                await this._mcpManager?.refreshServers();
                this._mcpManagement?.refresh();
                this._syncConnectorStates();
                this._renderList();
            }

            this._onManagementChanged({ section });
        } catch (error) {
            logError(error, `Failed to refresh ${section} management`);
            this._onToast(
                error?.userMessage
                || error?.message
                || `Could not refresh ${section}.`,
            );
        } finally {
            this._refreshButton.set_sensitive(true);
        }
    }

    refreshSkills() {
        this._skillsManagement?.refresh();
    }

    _goaConnectorFor(plugin, connector) {
        if (connector?.type !== 'gnome-online-accounts')
            return null;

        const runtime = String(connector.runtime ?? '').trim();

        if (runtime && this._goaConnectors.has(runtime))
            return this._goaConnectors.get(runtime);
        if (this._goaConnectors.has(plugin?.name))
            return this._goaConnectors.get(plugin.name);
        if (connector.provider === 'google' && connector.service === 'mail')
            return this._gmailConnector ?? this._goaConnectors.get('gmail-goa') ?? null;

        return null;
    }

    async _refreshGoaAccounts(cancellable) {
        const connectors = [...new Set(this._plugins.flatMap((plugin) => (
            (plugin.connectors ?? [])
                .map((connector) => this._goaConnectorFor(plugin, connector))
                .filter(Boolean)
        )))];

        await Promise.all(connectors.map(async (connector) => {
            try {
                await connector.refreshAccounts?.({ cancellable });
            } catch (error) {
                if (!isCancelled(error) && !cancellable.is_cancelled())
                    logError(error, 'Failed to refresh GNOME Online Accounts');
            }
        }));
    }

    _syncConnectorStates() {
        const serversById = new Map(
            (this._mcpManager?.listServers?.() ?? []).map((server) => [server.id, server]),
        );

        for (const plugin of this._plugins) {
            for (const connector of plugin.connectors ?? []) {
                if (connector.type === 'gnome-online-accounts') {
                    const state = this._goaConnectorFor(plugin, connector)?.getStatus?.() ?? {
                        connected: false,
                        status: 'unconfigured',
                        message: 'This native online-account connector is unavailable.',
                    };
                    connector.connected = state.connected;
                    connector.status = state.status;
                    connector.statusMessage = state.message ?? '';
                    connector.account = state.account ?? null;
                    connector.serverKey = '';
                    continue;
                }

                const server = serversById.get(connector.id);
                connector.connected = server?.status?.state === 'connected';
                connector.status = server?.status?.state ?? (connector.server ? 'ready' : 'unconfigured');
                connector.serverKey = server?.key ?? '';
                connector.bearerTokenRequired = Boolean(
                    server?.bearerTokenEnvVar
                    && !server?.bearerTokenAvailable
                    && !server?.authenticated,
                );
            }
        }
    }

    _render() {
        this._renderList();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scroller?.get_vadjustment()?.set_value(0);
            this._searchEntry?.grab_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _visiblePlugins() {
        const query = this._searchEntry?.get_text().trim().toLowerCase() ?? '';

        return this._plugins.filter((plugin) => {
            if (this._filter === 'installed' && !plugin.installed)
                return false;
            if (this._filter === 'available' && plugin.installed)
                return false;
            return !query || pluginSearchText(plugin).includes(query);
        });
    }

    _showAllPlugins() {
        this._filter = 'all';
        this._allFilterButton?.set_active(true);
        this._searchEntry?.set_text('');
        this._renderList();
    }

    _renderList() {
        if (!this._pluginList)
            return;

        for (const row of this._pluginRows)
            this._pluginList.remove(row);

        const plugins = this._visiblePlugins();
        this._pluginRows = plugins.map((plugin) => this._createPluginRow(plugin));

        for (const row of this._pluginRows)
            this._pluginList.add(row);

        const hasActiveFilter = this._filter !== 'all'
            || Boolean(this._searchEntry?.get_text().trim());
        this._emptyState.set_title(hasActiveFilter ? 'No matching plugins' : 'No plugins available');
        this._emptyState.set_description(hasActiveFilter
            ? 'Try a different search or filter.'
            : 'No plugins are available in the configured Cusco marketplaces.');
        this._showAllButton.set_visible(hasActiveFilter);
        this._resultsStack.set_visible_child_name(plugins.length > 0 ? 'plugins' : 'empty');
        this._contentStack.set_visible_child_name('plugins');
    }

    _createPluginRow(plugin) {
        const busyAction = this._busyPluginActions.get(plugin.pluginId) ?? '';
        const row = new Adw.ActionRow({
            title: plugin.displayName,
            subtitle: GLib.markup_escape_text(pluginSubtitle(plugin), -1),
            subtitle_lines: 3,
            use_markup: false,
            activatable: true,
        });
        row.connect('activated', () => {
            this._presentPluginDetails(this._getParentWindow(), plugin);
        });
        row.add_prefix(createPluginAvatar(plugin));

        if (plugin.installed && !plugin.enabled) {
            const state = new Gtk.Label({
                label: 'Disabled',
                valign: Gtk.Align.CENTER,
            });
            state.add_css_class('caption');
            state.add_css_class('dim-label');
            row.add_suffix(state);
        }

        if (plugin.installed && plugin.connectors?.length) {
            const connected = plugin.connectors?.length > 0
                && plugin.connectors.every((connector) => connector.connected);
            const hasGoaConnector = plugin.connectors.some((connector) => (
                connector.type === 'gnome-online-accounts'
            ));
            const connectButton = new Gtk.Button({
                label: connected && hasGoaConnector ? 'Change account' : connected ? 'Connected' : 'Connect',
                tooltip_text: connected
                    ? hasGoaConnector
                        ? `Change the online account used by ${plugin.displayName}`
                        : `${plugin.displayName} is connected`
                    : `Connect ${plugin.displayName}`,
                valign: Gtk.Align.CENTER,
                sensitive: (!connected || hasGoaConnector) && !busyAction,
            });
            connectButton.add_css_class(connected ? 'flat' : 'suggested-action');

            if (busyAction === 'connect') {
                const spinner = new Gtk.Spinner({ spinning: true });
                spinner.set_size_request(18, 18);
                connectButton.set_child(spinner);
            }

            connectButton.connect('clicked', () => this._connectPlugin(plugin));
            row.add_suffix(connectButton);
        }

        const button = new Gtk.Button({
            label: plugin.installed ? 'Remove' : 'Install',
            valign: Gtk.Align.CENTER,
            sensitive: !busyAction
                && plugin.installPolicy === 'AVAILABLE',
        });

        if (plugin.installed)
            button.add_css_class('destructive-action');
        else
            button.add_css_class('suggested-action');

        if (busyAction && busyAction !== 'connect') {
            const spinner = new Gtk.Spinner({ spinning: true });
            spinner.set_size_request(18, 18);
            button.set_child(spinner);
        }

        button.connect('clicked', () => {
            if (plugin.installed)
                this._confirmUninstall(plugin);
            else
                this._runAction('install', plugin);
        });
        row.add_suffix(button);
        return row;
    }

    async _connectPlugin(plugin) {
        if (this._busyPluginActions.has(plugin.pluginId))
            return;

        this._busyPluginActions.set(plugin.pluginId, 'connect');
        this._renderList();

        try {
            this._syncConnectorStates();
            const connector = plugin.connectors?.find((candidate) => !candidate.connected)
                ?? plugin.connectors?.[0];

            if (!connector)
                throw new Error(`${plugin.displayName} does not declare a connector.`);

            if (connector.type === 'gnome-online-accounts') {
                await this._connectGoaPlugin(plugin, connector);
                return;
            }

            if (connector.connected) {
                this._onToast(`${plugin.displayName} is already connected`);
                return;
            }

            if (!this._mcpManager)
                throw new Error('MCP management is not available.');

            let server = this._mcpManager.listServers()
                .find((candidate) => candidate.id === connector.id);

            if (!server && pluginConnectorNeedsSetup(connector)) {
                this._presentConnectorSetup(plugin, connector);
                return;
            }

            if (!server) {
                const added = this._mcpManager.addWorkspaceServer(connector.server);
                server = this._mcpManager.listServers()
                    .find((candidate) => candidate.id === added.id);
            }

            server = await this._ensureMcpBearerCredential(plugin, connector, server);

            if (!server)
                return;

            await this._connectMcpServer(plugin, server);
        } catch (error) {
            logError(error, `Failed to connect ${plugin.pluginId}`);
            this._onToast(
                error?.userMessage
                || error?.message
                || `Could not connect ${plugin.displayName}`,
            );
        } finally {
            this._busyPluginActions.delete(plugin.pluginId);
            this._renderList();
        }
    }

    async _connectGoaPlugin(plugin, connector) {
        const goaConnector = this._goaConnectorFor(plugin, connector);

        if (!goaConnector)
            throw new Error('GNOME Online Accounts support is not available.');

        const accounts = await goaConnector.refreshAccounts();

        if (accounts.length === 0) {
            if (typeof goaConnector.noAccountsError === 'function')
                throw goaConnector.noAccountsError();

            const error = new Error(`No compatible account is available for ${plugin.displayName}.`);
            error.userMessage = `Add a compatible account in Settings → Online Accounts first.`;
            throw error;
        }

        const account = accounts.length === 1
            ? accounts[0]
            : await presentGoaAccountChooser(this._getParentWindow(), accounts, {
                heading: `Choose an account for ${plugin.displayName}`,
                body: `Select the account ${plugin.displayName} may read.`,
            });

        if (!account)
            return;

        const connected = await goaConnector.connect(account.id);
        this._syncConnectorStates();
        const identity = connected.gmailAddress
            || connected.mailAddress
            || connected.account?.emailAddress
            || connected.account?.presentationIdentity;
        this._onToast(`${plugin.displayName} connected${identity ? ` as ${identity}` : ''}`);
    }

    _presentConnectorSetup(plugin, connector) {
        const requiresClientId = connector.server?.oauth?.clientIdRequired === true;

        presentAddMcpServerDialog(
            this._getParentWindow(),
            this._mcpManager,
            (added) => this._connectAddedPluginServer(plugin, added.id),
            {
                heading: `Connect ${plugin.displayName}`,
                body: requiresClientId
                    ? `${plugin.displayName} requires a registered OAuth client. Enter its Client ID and, for a confidential client, the environment variable containing its client secret.`
                    : 'Add the connector’s MCP endpoint. Cusco will handle authentication and store OAuth tokens in Secret Service.',
                requireOauthClientId: requiresClientId,
                defaults: {
                    ...(connector.server ?? {}),
                    id: connector.id,
                    name: connector.name || plugin.displayName,
                    transport: connector.server?.transport || 'streamable-http',
                },
            },
        );
        this._onToast(requiresClientId
            ? `Enter the registered OAuth Client ID for ${plugin.displayName}`
            : `Enter the MCP endpoint for ${plugin.displayName}`);
    }

    async _connectAddedPluginServer(plugin, serverId) {
        if (this._busyPluginActions.has(plugin.pluginId))
            return;

        this._busyPluginActions.set(plugin.pluginId, 'connect');
        this._renderList();

        try {
            const server = this._mcpManager.listServers()
                .find((candidate) => candidate.id === serverId);
            await this._connectMcpServer(plugin, server);
        } catch (error) {
            logError(error, `Failed to connect ${plugin.pluginId}`);
            this._onToast(
                error?.userMessage
                || error?.message
                || `Could not connect ${plugin.displayName}`,
            );
        } finally {
            this._busyPluginActions.delete(plugin.pluginId);
            this._syncConnectorStates();
            this._renderList();
        }
    }

    async _ensureMcpBearerCredential(plugin, connector, server) {
        if (!server?.bearerTokenEnvVar
            || server.bearerTokenAvailable
            || server.authenticated) {
            return server;
        }

        if (typeof this._mcpManager?.storeServerBearerToken !== 'function')
            throw new Error('Secure bearer-token storage is not available.');

        const accessToken = await this._presentBearerCredential(
            this._getParentWindow(),
            plugin,
            {
                ...connector,
                bearerTokenEnvVar: server.bearerTokenEnvVar,
            },
        );

        if (!accessToken)
            return null;

        this._mcpManager.storeServerBearerToken(server.key, accessToken);
        return this._mcpManager.listServers()
            .find((candidate) => candidate.key === server.key) ?? server;
    }

    async _connectMcpServer(plugin, server) {
        if (!server)
            throw new Error(`Could not create the ${plugin.displayName} connector.`);

        if (!server.enabled) {
            this._mcpManager.setServerEnabled(server.key, true);
            server = this._mcpManager.listServers()
                .find((candidate) => candidate.id === server.id);
        }

        const connected = this._mcpManager.connectServer
            ? await this._mcpManager.connectServer(server.key)
            : await this._mcpManager.refreshServer(server.key);

        this._syncConnectorStates();
        this._mcpManagement?.refresh();
        this._onManagementChanged({ section: 'mcp' });

        if (connected?.status?.state === 'connected'
            || this._mcpManager.listServers().find((candidate) => candidate.id === server.id)
                ?.status?.state === 'connected') {
            this._onToast(`${plugin.displayName} connected`);
            return;
        }

        throw new Error(`${plugin.displayName} did not finish connecting.`);
    }

    _confirmUninstall(plugin) {
        const dialog = new Adw.AlertDialog({
            heading: `Remove ${plugin.displayName}?`,
            body: 'Cusco will remove this plugin and any Cusco-managed connector credentials.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('remove', 'Remove');
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(this._getParentWindow(), null, (_dialog, result) => {
            if (dialog.choose_finish(result) === 'remove')
                this._runAction('uninstall', plugin);
        });
    }

    async _runAction(action, plugin) {
        if (this._busyPluginActions.has(plugin.pluginId))
            return;

        this._busyPluginActions.set(plugin.pluginId, action);
        this._renderList();

        try {
            if (action === 'install')
                await this._client.install(plugin.pluginId);
            else {
                await this._client.uninstall(plugin.pluginId);
                for (const connector of plugin.connectors ?? []) {
                    if (connector.type === 'gnome-online-accounts') {
                        this._goaConnectorFor(plugin, connector)?.disconnect?.();
                        continue;
                    }

                    const server = this._mcpManager?.listServers?.()
                        .find((candidate) => candidate.id === connector.id);

                    if (server?.source === 'workspace')
                        this._mcpManager.deleteServer(server.key);
                }
            }

            const pastTense = action === 'install' ? 'Installed' : 'Removed';
            this._onToast(`${pastTense} ${plugin.displayName}`);
            this._onChanged({ action, plugin });
            await this.refresh();
        } catch (error) {
            logError(error, `Failed to ${action} ${plugin.pluginId}`);
            this._onToast(
                error?.userMessage
                || error?.message
                || `Could not ${action} ${plugin.displayName}`,
            );
        } finally {
            this._busyPluginActions.delete(plugin.pluginId);
            this._renderList();
        }
    }
}
