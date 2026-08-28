import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import { createHooksConfigGroup } from '../src/settings/hooksSettings.js';
import { createWorkspaceSettingsPage } from '../src/settings/workspaceSettings.js';

function walkWidgets(widget, callback) {
    callback(widget);

    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        walkWidgets(child, callback);
}

function findByTitle(root, WidgetType, title) {
    let found = null;

    walkWidgets(root, (widget) => {
        if (!found && widget instanceof WidgetType && widget.get_title() === title)
            found = widget;
    });

    return found;
}

if (Gtk.init_check()) {
    Adw.init();
    const hookManager = {
        listHooks() {
            return {
                sources: [{
                    scope: 'user',
                    label: 'User hooks',
                    path: '/tmp/cusco-user-hooks.json',
                    exists: true,
                    errors: [],
                }],
                definitions: [],
            };
        },
    };
    const group = createHooksConfigGroup(hookManager);
    const configRow = findByTitle(group, Adw.ActionRow, 'hooks.json');

    if (configRow?.get_subtitle() !== '/tmp/cusco-user-hooks.json')
        throw new Error('Hooks config group did not show the user config file');

    if (findByTitle(group, Adw.SwitchRow, 'Enable trusted hooks')
        || findByTitle(group, Adw.ActionRow, 'Current chat')
        || findByTitle(group, Adw.ExpanderRow, 'PreToolUse')) {
        throw new Error('Hooks config group exposed settings other than config files');
    }

    const workspaceManager = {
        prompts: [],
    };
    const mcpManager = {
        configPath: '/tmp/cusco-mcp.json',
        configError: '',
        listServers() {
            return [];
        },
    };
    const page = createWorkspaceSettingsPage(
        null,
        workspaceManager,
        mcpManager,
        () => {},
        { hookManager },
    );
    const groupTitles = [];

    walkWidgets(page, (widget) => {
        if (widget instanceof Adw.PreferencesGroup)
            groupTitles.push(widget.get_title());
    });

    const mcpIndex = groupTitles.indexOf('MCP Servers');
    const hooksIndex = groupTitles.indexOf('Hooks Config File');

    if (mcpIndex < 0 || hooksIndex !== mcpIndex + 1)
        throw new Error('Workspace settings did not place the Hooks config file after MCP');
}

print('Cusco hooks settings smoke passed');
