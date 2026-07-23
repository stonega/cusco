import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import { createHooksSettingsPage } from '../src/settings/hooksSettings.js';

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
    const appSettings = {
        hooksEnabled: true,
        setHooksEnabled(value) {
            this.hooksEnabled = Boolean(value);
        },
    };
    const conversation = {
        id: 'chat-1',
        workingDirectory: '/tmp/cusco-hooks-workspace',
    };
    const conversationManager = {
        setWorkingDirectory(_conversationId, path) {
            conversation.workingDirectory = path;
        },
    };
    const hookManager = {
        listHooks() {
            return {
                sources: [{
                    label: 'User hooks',
                    path: '/tmp/cusco-user-hooks.json',
                    exists: true,
                    errors: [],
                }],
                definitions: [{
                    sourceLabel: 'User hooks',
                    sourcePath: '/tmp/cusco-user-hooks.json',
                    eventName: 'PreToolUse',
                    matcher: '^Bash$',
                    command: 'check-command',
                    timeout: 30,
                    statusMessage: 'Checking command',
                    fingerprint: 'fingerprint',
                    trusted: false,
                    disabled: false,
                    supported: true,
                    errors: [],
                    lastRun: null,
                }],
            };
        },
        trust() {},
        revoke() {},
        setDisabled() {},
        resetAllSessions() {},
        resetSession() {},
    };
    const page = createHooksSettingsPage(
        null,
        hookManager,
        appSettings,
        conversation,
        conversationManager,
    );

    if (!findByTitle(page, Adw.SwitchRow, 'Enable trusted hooks'))
        throw new Error('Hooks settings did not expose the global enable control');

    const workingDirectoryRow = findByTitle(page, Adw.ActionRow, 'Current chat');

    if (workingDirectoryRow?.get_subtitle() !== conversation.workingDirectory)
        throw new Error('Hooks settings did not show the chat working directory');

    const definitionRow = findByTitle(page, Adw.ExpanderRow, 'PreToolUse');

    if (!definitionRow || !definitionRow.get_subtitle().includes('Review required'))
        throw new Error('Hooks settings did not show untrusted definitions');

    if (definitionRow.get_subtitle().includes('.codex'))
        throw new Error('Hooks settings exposed an unsupported Codex source');
}

print('Cusco hooks settings smoke passed');
