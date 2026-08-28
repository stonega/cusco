import { CuscoWindow, formatUsageNumberMarkup } from '../src/window.js';

const numberMarkup = formatUsageNumberMarkup('1,234.5%');
if (numberMarkup !== '<span font_family="monospace">1</span>,'
    + '<span font_family="monospace">234</span>.'
    + '<span font_family="monospace">5</span>%') {
    throw new Error(`Usage number punctuation should remain proportional: ${numberMarkup}`);
}

const calls = {
    artifactClosed: 0,
    refreshed: 0,
    pluginsCancelled: 0,
    pluginsRefreshed: 0,
    pluginsSurfaceEnsured: 0,
    surfaceEnsured: 0,
    stackPage: '',
    unselected: 0,
};
const harness = {
    _artifactSplitView: {
        get_show_sidebar: () => true,
    },
    _closeArtifactWorkspace() {
        calls.artifactClosed += 1;
    },
    _primaryStack: {
        get_visible_child_name() {
            return calls.stackPage || 'chat';
        },
        set_visible_child_name(name) {
            calls.stackPage = name;
        },
    },
    _pluginsPage: {
        cancelRefresh() {
            calls.pluginsCancelled += 1;
        },
    },
    _usagePage: {
        cancelRefresh() {
            calls.usageCancelled = (calls.usageCancelled ?? 0) + 1;
        },
    },
    _conversationSelectionModel: {
        unselect_all() {
            calls.unselected += 1;
        },
    },
    _refreshUsageDashboard() {
        calls.refreshed += 1;
    },
    _ensureUsageSurface() {
        calls.surfaceEnsured += 1;
    },
    _ensurePluginsSurface() {
        calls.pluginsSurfaceEnsured += 1;
    },
    _refreshPlugins() {
        calls.pluginsRefreshed += 1;
    },
};

CuscoWindow.prototype._showUsagePage.call(harness);

if (calls.stackPage !== 'usage'
    || calls.pluginsCancelled !== 1
    || calls.unselected !== 1
    || calls.artifactClosed !== 1
    || calls.refreshed !== 1
    || calls.surfaceEnsured !== 1) {
    throw new Error(`Usage navigation did not activate the dashboard: ${JSON.stringify(calls)}`);
}

calls.stackPage = 'chat';
calls.artifactClosed = 0;
calls.unselected = 0;
CuscoWindow.prototype._showPluginsPage.call(harness);

if (calls.stackPage !== 'plugins'
    || calls.unselected !== 1
    || calls.artifactClosed !== 1
    || calls.pluginsRefreshed !== 1
    || calls.pluginsSurfaceEnsured !== 1
    || calls.usageCancelled !== 1) {
    throw new Error(`Plugin navigation did not activate the catalog: ${JSON.stringify(calls)}`);
}

CuscoWindow.prototype._showChatPage.call(harness);

if (calls.stackPage !== 'chat')
    throw new Error(`Chat navigation did not restore the chat surface: ${JSON.stringify(calls)}`);

print('Cusco usage page smoke passed');
