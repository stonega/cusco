import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    PluginsPage,
    presentPluginDetailsDialog,
} from '../src/chat/pluginsPage.js';
import { presentAddMcpServerDialog } from '../src/settings/mcpSettings.js';
import { presentSkillDetailsDialog } from '../src/settings/workspaceSettings.js';
import {
    CuscoPluginClient,
    loadPluginManifest,
    normalizePluginEntry,
    parsePluginMarketplaceJson,
    validatePluginSelector,
} from '../src/plugins/client.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function walkWidgets(widget, callback) {
    if (!widget)
        return;

    callback(widget);
    for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling())
        walkWidgets(child, callback);
}

function writeJson(path, value) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, `${JSON.stringify(value, null, 2)}\n`);
}

const fixtureRoot = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-plugin-source-${GLib.uuid_string_random()}`,
]);
const manifestDirectory = GLib.build_filenamev([fixtureRoot, '.cusco-plugin']);
const fixtureSkillDirectory = GLib.build_filenamev([fixtureRoot, 'skills', 'design-review']);
GLib.mkdir_with_parents(manifestDirectory, 0o700);
GLib.mkdir_with_parents(fixtureSkillDirectory, 0o700);
writeJson(GLib.build_filenamev([manifestDirectory, 'plugin.json']), {
    name: 'design-tools',
    version: '1.2.3',
    description: 'Fallback plugin description',
    skills: './skills/',
    apps: './.app.json',
    author: { name: 'Cusco Labs' },
    interface: {
        displayName: 'Design Tools',
        shortDescription: 'Design and inspect native interfaces',
        category: 'Creativity',
        capabilities: ['Read', 'Write'],
    },
});
writeJson(GLib.build_filenamev([fixtureRoot, '.app.json']), {
    apps: {
        design: { id: 'legacy_host_connector_id' },
    },
});
writeJson(GLib.build_filenamev([fixtureRoot, '.mcp.json']), {
    mcpServers: {
        design: {
            type: 'http',
            url: 'https://mcp.example.test/mcp',
            bearer_token_env_var: 'DESIGN_MCP_TOKEN',
            oauth_resource: 'https://mcp.example.test/mcp',
        },
    },
});
GLib.file_set_contents(GLib.build_filenamev([fixtureSkillDirectory, 'SKILL.md']), [
    '---',
    'name: design-review',
    'description: Review native interface details.',
    '---',
    '',
    '# Design Review',
].join('\n'));

const manifest = loadPluginManifest(fixtureRoot);
assert(manifest?.name === 'design-tools', 'Plugin manifest was not loaded');

const marketplace = {
    name: 'test-market',
    plugins: [{
        name: 'design-tools',
        source: { source: 'local', path: fixtureRoot },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
        category: 'Creativity',
    }, {
        name: 'notes',
        source: { source: 'local', path: '/missing/plugin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    }, ...[
        'browser',
        'build-ios-apps',
        'build-macos-apps',
        'build-web-apps',
        'codex-app-tools',
        'chrome',
    ].map((name) => ({
        name,
        source: { source: 'local', path: `/missing/${name}` },
    }))],
};
const parsed = parsePluginMarketplaceJson(JSON.stringify(marketplace), {
    installedPluginNames: new Set(['design-tools']),
});

assert(parsed.length === 2, 'Plugin list did not include only Cusco marketplace entries');
assert(parsed[0].pluginId === 'design-tools@test-market', 'Installed plugins were not sorted first');
assert(parsed[0].displayName === 'Design Tools', 'Manifest display metadata was not applied');
assert(parsed[0].version === '1.2.3', 'Manifest version was not applied');
assert(
    parsed[0].hasSkills && parsed[0].hasMcpServers && parsed[0].hasApps,
    'Plugin parts were not detected',
);
assert(parsed[0].connectors.length === 1, 'Plugin connector declaration was not loaded');
assert(
    parsed[0].connectors[0].id === 'plugin_design_tools_design',
    'Cusco did not create its own stable connector id',
);
assert(
    parsed[0].connectors[0].server?.url === 'https://mcp.example.test/mcp',
    'Plugin connector did not use its native MCP endpoint',
);
assert(
    parsed[0].connectors[0].server?.bearerTokenEnvVar === 'DESIGN_MCP_TOKEN',
    'Plugin connector did not retain its bearer-token environment hint',
);
assert(
    parsed[0].connectors[0].server?.oauth?.resource === 'https://mcp.example.test/mcp',
    'Plugin connector did not retain its MCP OAuth resource',
);
assert(
    !JSON.stringify(parsed[0].connectors).includes('legacy_host_connector_id'),
    'Legacy hosted connector ids leaked into Cusco connection metadata',
);
assert(parsed[1].displayName === 'Notes', 'Fallback plugin display name was not generated');
const appOnlyPlugin = normalizePluginEntry({
    name: 'mail',
    source: { path: GLib.build_filenamev([fixtureRoot, 'manifest-only']) },
}, {
    name: 'mail',
    apps: {
        apps: {
            gmail: { id: 'legacy_mail_connector_id' },
        },
    },
});
assert(
    appOnlyPlugin.connectors[0]?.id === 'plugin_mail_gmail'
    && appOnlyPlugin.connectors[0]?.server === null,
    'App-only ports did not produce a native MCP setup action',
);
const goaGmailPlugin = normalizePluginEntry({
    name: 'gmail',
    source: { path: GLib.build_filenamev([fixtureRoot, 'manifest-only']) },
}, {
    name: 'gmail',
    apps: {
        apps: {
            gmail: { id: 'legacy_mail_connector_id' },
        },
    },
    cusco: {
        connectors: [{
            id: 'gmail',
            name: 'gmail',
            type: 'gnome-online-accounts',
            runtime: 'gmail-goa',
            provider: 'google',
            service: 'mail',
        }],
    },
});
assert(
    goaGmailPlugin.connectors[0]?.type === 'gnome-online-accounts'
    && goaGmailPlugin.connectors[0]?.runtime === 'gmail-goa'
    && goaGmailPlugin.connectors[0]?.provider === 'google'
    && goaGmailPlugin.connectors[0]?.service === 'mail'
    && goaGmailPlugin.connectors[0]?.server === null,
    'Plugin-native GNOME Online Accounts metadata was not preserved',
);

const bundledCatalog = await new CuscoPluginClient({
    repositoryRoot: GLib.get_current_dir(),
}).listPlugins();
const bundledMail = bundledCatalog.find((plugin) => plugin.name === 'mail');
const bundledGithub = bundledCatalog.find((plugin) => plugin.name === 'github');
assert(
    bundledMail
    && bundledMail.connectors[0]?.runtime === 'mail-goa'
    && bundledMail.connectors[0]?.provider === 'any-non-google'
    && bundledMail.hasSkills
    && bundledMail.hasApps,
    'Bundled Mail plugin was not discoverable with its native GOA runtime',
);
assert(
    bundledGithub
    && bundledGithub.hasApps
    && bundledGithub.hasMcpServers
    && bundledGithub.connectors.length === 1
    && bundledGithub.connectors[0]?.server?.url === 'https://api.githubcopilot.com/mcp/'
    && bundledGithub.connectors[0]?.server?.bearerTokenEnvVar === 'GITHUB_PAT_TOKEN',
    'Bundled GitHub plugin was not discoverable with its MCP bearer-token connector',
);

const repositoryRoot = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-plugin-repository-${GLib.uuid_string_random()}`,
]);
const marketplacePath = GLib.build_filenamev([
    repositoryRoot,
    '.agents',
    'plugins',
    'marketplace.json',
]);
writeJson(marketplacePath, {
    name: 'test-market',
    plugins: [marketplace.plugins[0]],
});
const client = new CuscoPluginClient({ repositoryRoot });
const initialCatalog = await client.listPlugins();
assert(initialCatalog.length === 1, 'Cusco marketplace catalog was not loaded');
assert(!initialCatalog[0].installed, 'Catalog source was incorrectly reported as installed');

await client.install('design-tools@test-market');

const installedPluginPath = GLib.build_filenamev([repositoryRoot, 'plugins', 'design-tools']);
const installedSkillPath = GLib.build_filenamev([
    installedPluginPath,
    'skills',
    'design-review',
    'SKILL.md',
]);
assert(
    GLib.file_test(installedSkillPath, GLib.FileTest.IS_REGULAR),
    'Cusco did not copy the complete plugin into the repository',
);
const installedCatalog = await client.listPlugins();
assert(installedCatalog[0].installed, 'Repository plugin was not reported as installed');
const persistedMarketplace = JSON.parse(
    new TextDecoder().decode(GLib.file_get_contents(marketplacePath)[1]),
);
assert(
    persistedMarketplace.plugins[0]?.source?.path === fixtureRoot,
    'Plugin installation rewrote the standalone marketplace source',
);

await client.uninstall('design-tools@test-market');
assert(
    !GLib.file_test(installedPluginPath, GLib.FileTest.EXISTS),
    'Cusco repository plugin was not removed',
);
const availableAgain = await client.listPlugins();
assert(!availableAgain[0].installed, 'Removed plugin did not remain available in the catalog');

let unsafeSelectorRejected = false;

try {
    validatePluginSelector('--config');
} catch (_error) {
    unsafeSelectorRejected = true;
}

assert(unsafeSelectorRejected, 'Unsafe plugin selectors must be rejected');

if (Gtk.init_check()) {
    let backCount = 0;
    let mcpRefreshCount = 0;
    let skillsRefreshCount = 0;
    let connectorConnectCount = 0;
    let shownPluginId = '';
    let shownSkillId = '';
    let shownSkillContent = '';
    let storedBearerToken = '';
    let presentedBearerEnvironment = '';
    const mailConnectorMarker = {};
    const toasts = [];
    const servers = [];
    const mcpManager = {
        configPath: GLib.build_filenamev([fixtureRoot, 'mcp.json']),
        configError: '',
        listServers: () => servers.map((server) => ({
            ...server,
            status: { ...server.status },
        })),
        addWorkspaceServer(server) {
            const added = {
                ...server,
                key: `workspace:${server.id}`,
                source: 'workspace',
                status: { state: 'idle', message: 'Not connected.' },
            };
            servers.push(added);
            return { ...added };
        },
        async connectServer(key) {
            connectorConnectCount += 1;
            const server = servers.find((candidate) => candidate.key === key);
            server.status = { state: 'connected', message: 'Connected.' };
            return { ...server, status: { ...server.status } };
        },
        storeServerBearerToken(key, token) {
            const server = servers.find((candidate) => candidate.key === key);
            storedBearerToken = token;
            server.authenticated = true;
            server.bearerTokenAvailable = true;
            return { ...server, status: { ...server.status } };
        },
        async refreshServers() {
            mcpRefreshCount += 1;
        },
        setServerEnabled() {},
        deleteServer() {},
    };
    const page = new PluginsPage({
        client: {
            async listPlugins() {
                return parsed;
            },
        },
        goaConnectors: new Map([['mail-goa', mailConnectorMarker]]),
        mcpManager,
        onBack: () => backCount += 1,
        onToast: (message) => toasts.push(message),
        presentBearerCredential: async (_parent, _plugin, connector) => {
            presentedBearerEnvironment = connector.bearerTokenEnvVar;
            return 'stored-design-token';
        },
        presentPluginDetails: (_parent, plugin) => shownPluginId = plugin.pluginId,
        presentSkillDetails: (_parent, skill) => {
            shownSkillId = skill.id;
            shownSkillContent = skill.content;
        },
        workspaceManager: {
            cuscoSkillsPath: fixtureSkillDirectory,
            skills: [{
                id: 'detail-skill',
                name: 'Detail skill',
                description: 'A skill with details.',
                path: fixtureSkillDirectory,
                source: 'cusco',
                enabled: true,
                loadError: '',
            }],
            loadSkill(skillId) {
                assert(skillId === 'detail-skill', 'Unexpected skill detail load');
                return {
                    id: 'detail-skill',
                    name: 'Detail skill',
                    description: 'A skill with details.',
                    path: fixtureSkillDirectory,
                    source: 'cusco',
                    enabled: true,
                    content: '# Detail skill\n\nUse these instructions.',
                    loadError: '',
                };
            },
            refreshInstalledSkills() {
                skillsRefreshCount += 1;
            },
        },
    });
    assert(
        page._goaConnectorFor(bundledMail, bundledMail.connectors[0]) === mailConnectorMarker,
        'Plugins page did not route Mail to its declared native GOA runtime',
    );
    assert(page.widget, 'Plugins page widget was not created');
    await page.refresh();
    const [, pluginListNaturalHeight] = page._pluginList.measure(
        Gtk.Orientation.VERTICAL,
        -1,
    );
    const [, resultsNaturalHeight] = page._resultsStack.measure(
        Gtk.Orientation.VERTICAL,
        -1,
    );
    assert(
        page._pluginList instanceof Adw.PreferencesGroup
        && page._catalogClamp.get_maximum_size() === 600
        && page._catalogClamp.get_child().get_margin_start() === 12
        && page._catalogClamp.get_child().get_margin_end() === 12,
        'Plugin catalog did not use the Skills card layout',
    );
    assert(
        !page._resultsStack.get_vexpand()
        && !page._resultsStack.get_vhomogeneous()
        && resultsNaturalHeight === pluginListNaturalHeight,
        'Plugin catalog card did not fit its visible row content',
    );
    const pluginDetailsDialog = presentPluginDetailsDialog(page.widget, parsed[0]);
    assert(
        pluginDetailsDialog instanceof Adw.Dialog
        && !(pluginDetailsDialog instanceof Adw.AlertDialog)
        && pluginDetailsDialog.get_content_width() === 720,
        'Plugin details did not use the wide custom dialog',
    );
    let pluginDetailHeaderBar = null;
    let pluginDetailCloseButton = null;
    const pluginDetailLabels = [];
    walkWidgets(pluginDetailsDialog.get_child(), (widget) => {
        if (widget instanceof Adw.HeaderBar)
            pluginDetailHeaderBar = widget;
        if (widget instanceof Gtk.Button && widget.get_tooltip_text() === 'Close')
            pluginDetailCloseButton = widget;
        if (widget instanceof Gtk.Label)
            pluginDetailLabels.push(widget.get_label());
    });
    assert(
        pluginDetailHeaderBar
        && !pluginDetailHeaderBar.get_show_end_title_buttons()
        && !pluginDetailHeaderBar.get_show_start_title_buttons()
        && pluginDetailCloseButton
        && pluginDetailsDialog.get_focus() === pluginDetailCloseButton,
        'Plugin details did not focus the top-right close control',
    );
    assert(
        !pluginDetailLabels.some((label) => label.includes('Ported from OpenAI')),
        'Plugin details still showed the removed OpenAI porting notice',
    );
    assert(
        pluginDetailLabels.includes('Developer')
        && pluginDetailLabels.includes('Cusco'),
        'Plugin details did not identify Cusco as the developer',
    );
    pluginDetailsDialog.close();
    const skillDetailsDialog = presentSkillDetailsDialog(page.widget, {
        id: 'detail-skill',
        name: 'Detail skill',
        description: 'A skill with details.',
        path: fixtureSkillDirectory,
        source: 'cusco',
        enabled: true,
        content: '# Detail skill\n\nUse these instructions.',
        loadError: '',
    });
    assert(
        skillDetailsDialog instanceof Adw.Dialog
        && !(skillDetailsDialog instanceof Adw.AlertDialog)
        && skillDetailsDialog.get_content_width() === 720,
        'Skill details did not use the wide custom dialog',
    );
    let skillDetailHasIcon = false;
    let skillContentLabel = null;
    let skillDetailScroller = null;
    walkWidgets(skillDetailsDialog.get_child(), (widget) => {
        if (widget.has_css_class?.('cusco-detail-skill-icon'))
            skillDetailHasIcon = true;
        if (widget.has_css_class?.('cusco-detail-skill-content'))
            skillContentLabel = widget;
        if (widget instanceof Gtk.ScrolledWindow
            && widget.get_min_content_height() === 280) {
            skillDetailScroller = widget;
        }
    });
    const skillScrollerChild = skillDetailScroller?.get_child();
    const skillDetailContent = skillScrollerChild instanceof Gtk.Viewport
        ? skillScrollerChild.get_child()
        : skillScrollerChild;
    assert(!skillDetailHasIcon, 'Skill details still showed a decorative icon');
    assert(
        skillContentLabel?.get_label() === '# Detail skill\n\nUse these instructions.',
        'Skill details did not show the full monospaced skill content',
    );
    assert(
        skillDetailScroller?.get_placement() === Gtk.CornerType.TOP_LEFT
        && skillDetailScroller.get_margin_start() === 0
        && skillDetailScroller.get_margin_end() === 0
        && skillDetailContent?.get_margin_start() === 24
        && skillDetailContent.get_margin_end() === 24,
        'Skill details scrollbar was not flush-right with the content inset kept inside the scroller',
    );
    skillDetailsDialog.close();
    assert(
        page._viewSwitcher.get_stack() === page._sectionStack
        && page._sectionStack.get_child_by_name('plugins')
        && page._sectionStack.get_child_by_name('skills')
        && page._sectionStack.get_child_by_name('mcp'),
        'Plugins page did not expose Plugins, Skills, and MCP header tabs',
    );
    assert(
        page._mcpManagement.addButton.get_label() === 'Add MCP Server',
        'MCP management did not expose an Add MCP Server button',
    );
    const addMcpDialog = presentAddMcpServerDialog(page.widget, mcpManager);
    assert(addMcpDialog, 'Add MCP Server dialog was not created');
    assert(
        addMcpDialog instanceof Adw.Dialog
        && !(addMcpDialog instanceof Adw.AlertDialog)
        && addMcpDialog.get_content_width() === 720,
        'Add MCP Server did not use the wide dialog layout',
    );
    let mcpFormScroller = null;
    let mcpTypeButtons = null;
    let mcpKeyValueRow = null;
    walkWidgets(addMcpDialog.get_child(), (widget) => {
        if (widget instanceof Gtk.ScrolledWindow
            && widget.get_min_content_height() === 430) {
            mcpFormScroller = widget;
        }
        if (widget instanceof Gtk.Box && widget.has_css_class?.('linked'))
            mcpTypeButtons = widget;
        if (widget.has_css_class?.('cusco-mcp-key-value-row'))
            mcpKeyValueRow = widget;
    });
    const mcpPairEntries = [];
    walkWidgets(mcpKeyValueRow, (widget) => {
        if (widget instanceof Gtk.Entry)
            mcpPairEntries.push(widget);
    });
    const mcpScrollerChild = mcpFormScroller?.get_child();
    const mcpForm = mcpScrollerChild instanceof Gtk.Viewport
        ? mcpScrollerChild.get_child()
        : mcpScrollerChild;
    assert(
        mcpTypeButtons?.get_homogeneous()
        && mcpTypeButtons.get_valign() === Gtk.Align.CENTER,
        'MCP transport choices were not presented as balanced, vertically centered segments',
    );
    assert(
        mcpPairEntries.length === 2
        && mcpPairEntries.every((entry) => !entry.get_has_frame()),
        'MCP key/value inputs still rendered nested entry bars',
    );
    assert(
        mcpFormScroller?.get_placement() === Gtk.CornerType.TOP_LEFT
        && mcpFormScroller.get_margin_start() === 0
        && mcpFormScroller.get_margin_end() === 0
        && mcpForm?.get_margin_start() === 24
        && mcpForm.get_margin_end() === 24,
        'MCP form scrollbar was not flush-right with the content inset kept inside the scroller',
    );
    addMcpDialog.close();
    let savedDialogServer = null;
    let addedDialogServer = null;
    const actionableAddMcpDialog = presentAddMcpServerDialog(
        page.widget,
        {
            addWorkspaceServer(server) {
                savedDialogServer = server;
                return { ...server, id: 'dialog-server' };
            },
        },
        (server) => addedDialogServer = server,
        {
            defaults: {
                name: 'Dialog server',
                command: 'dialog-server',
            },
        },
    );
    let addServerButton = null;
    walkWidgets(actionableAddMcpDialog.get_child(), (widget) => {
        if (widget instanceof Gtk.Button && widget.get_label() === 'Add Server')
            addServerButton = widget;
    });
    assert(
        addServerButton?.get_sensitive()
        && actionableAddMcpDialog.get_default_widget() === addServerButton,
        'Wide Add MCP Server dialog did not preserve its primary action',
    );
    addServerButton.emit('clicked');
    assert(
        savedDialogServer?.command === 'dialog-server'
        && addedDialogServer?.id === 'dialog-server',
        'Wide Add MCP Server dialog did not save its validated form',
    );
    page._sectionStack.set_visible_child_name('skills');
    await page._refreshActiveSection();
    assert(skillsRefreshCount === 1, 'Skills tab did not refresh installed skills');
    page._sectionStack.set_visible_child_name('mcp');
    await page._refreshActiveSection();
    assert(mcpRefreshCount === 1, 'MCP tab did not refresh configured servers');
    page._sectionStack.set_visible_child_name('plugins');
    const catalogLabels = [];
    walkWidgets(page.widget, (widget) => {
        if (widget instanceof Gtk.Label)
            catalogLabels.push(widget.get_label());
    });
    assert(
        !catalogLabels.some((label) => label.includes('ported from OpenAI')),
        'Plugins page still showed the removed OpenAI porting notice',
    );
    assert(
        catalogLabels.some((label) => label.includes('Cusco · Creativity')),
        'Plugin catalog rows did not identify Cusco as the developer',
    );
    page._backButton.emit('clicked');
    assert(backCount === 1, 'Plugins page back button did not return to chat');
    const installedConnector = parsed.find((plugin) => plugin.installed && plugin.hasApps);
    const connectorRow = page._createPluginRow(installedConnector);
    const connectorButtonLabels = [];
    const connectorLabelTexts = [];
    let removeButton = null;
    walkWidgets(connectorRow, (widget) => {
        if (widget instanceof Gtk.Button) {
            connectorButtonLabels.push(widget.get_label());
            if (widget.get_label() === 'Remove')
                removeButton = widget;
        }
        if (widget instanceof Gtk.Label)
            connectorLabelTexts.push(widget.get_label());
    });
    assert(
        connectorButtonLabels.includes('Connect'),
        'Installed connector-backed plugin did not expose a Connect button',
    );
    assert(
        !connectorLabelTexts.includes('Installed'),
        'Installed plugin row showed a redundant Installed status label',
    );
    assert(
        removeButton?.has_css_class('destructive-action')
        && !removeButton.has_css_class('flat'),
        'Remove plugin button did not use the destructive action style',
    );
    connectorRow.emit('activated');
    assert(
        shownPluginId === installedConnector.pluginId,
        'Activating a plugin row did not open its detail dialog',
    );
    let skillRow = null;
    walkWidgets(page._skillsManagement.widget, (widget) => {
        if (widget instanceof Adw.ActionRow && widget.get_title() === 'Detail skill')
            skillRow = widget;
    });
    skillRow?.emit('activated');
    assert(
        shownSkillId === 'detail-skill'
        && shownSkillContent === '# Detail skill\n\nUse these instructions.',
        'Activating a skill row did not load its SKILL.md content for details',
    );
    await page._connectPlugin(installedConnector);
    assert(
        servers[0]?.url === 'https://mcp.example.test/mcp'
        && storedBearerToken === 'stored-design-token'
        && presentedBearerEnvironment === 'DESIGN_MCP_TOKEN'
        && connectorConnectCount === 1
        && toasts.at(-1) === 'Design Tools connected',
        'Plugin Connect did not securely configure and verify a native Cusco MCP connection',
    );
    assert(
        installedConnector.connectors[0].connected,
        'Verified MCP state was not reflected as a connected plugin',
    );

    page._plugins = parsed.filter((plugin) => !plugin.installed);
    page._filter = 'installed';
    page._renderList();
    assert(
        page._contentStack.get_visible_child_name() === 'plugins',
        'An empty plugin filter hid the marketplace controls',
    );
    assert(
        page._resultsStack.get_visible_child_name() === 'empty',
        'An empty plugin filter did not show its result-level empty state',
    );
    page._showAllPlugins();
    assert(page._filter === 'all', 'Show All Plugins did not reset the plugin filter');
    assert(
        page._resultsStack.get_visible_child_name() === 'plugins',
        'Show All Plugins did not restore the marketplace list',
    );
    page.dispose();
}

print('Cusco plugins smoke passed');
