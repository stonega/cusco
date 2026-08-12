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
    surfaceEnsured: 0,
    stackPage: '',
    toggleActive: null,
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
    _usageNavigationButton: {
        set_active(active) {
            calls.toggleActive = active;
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
};

CuscoWindow.prototype._showUsagePage.call(harness);

if (calls.stackPage !== 'usage'
    || calls.toggleActive !== true
    || calls.unselected !== 1
    || calls.artifactClosed !== 1
    || calls.refreshed !== 1
    || calls.surfaceEnsured !== 1) {
    throw new Error(`Usage navigation did not activate the dashboard: ${JSON.stringify(calls)}`);
}

CuscoWindow.prototype._showChatPage.call(harness);

if (calls.stackPage !== 'chat' || calls.toggleActive !== false)
    throw new Error(`Chat navigation did not restore the chat surface: ${JSON.stringify(calls)}`);

print('Cusco usage page smoke passed');
