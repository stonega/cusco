import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
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

function stateLabel(definition) {
    if (!definition.supported)
        return 'Unsupported';
    if (!definition.trusted)
        return 'Review required';
    if (definition.disabled)
        return 'Disabled';
    return 'Trusted';
}

function matcherLabel(definition) {
    return definition.matcher && definition.matcher !== '*'
        ? definition.matcher
        : 'all';
}

function presentTrustDialog(parent, hookManager, definition, refresh) {
    const dialog = new Adw.AlertDialog({
        heading: 'Trust this hook?',
        body: [
            `${definition.eventName} · matcher: ${matcherLabel(definition)}`,
            definition.command,
            '',
            `Source: ${definition.sourcePath}`,
            '',
            'This command runs with your user account and can read prompts, tool inputs, local files, and network resources.',
        ].join('\n'),
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('trust', 'Trust Hook');
    dialog.set_close_response('cancel');
    dialog.set_default_response('cancel');
    dialog.set_response_appearance('trust', Adw.ResponseAppearance.SUGGESTED);
    dialog.choose(parent, null, (_dialog, result) => {
        if (dialog.choose_finish(result) !== 'trust')
            return;

        hookManager.trust(definition.fingerprint);
        refresh();
    });
}

function createDefinitionRow(parent, hookManager, definition, refresh) {
    const subtitle = [
        `${definition.sourceLabel} · matcher: ${matcherLabel(definition)}`,
        stateLabel(definition),
    ].join(' · ');
    const row = new Adw.ExpanderRow({
        title: definition.eventName,
        subtitle,
    });

    if (definition.supported) {
        const controls = new Gtk.Box({
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        const enabledSwitch = new Gtk.Switch({
            active: definition.trusted && !definition.disabled,
            sensitive: definition.trusted,
            tooltip_text: definition.trusted ? 'Enable this hook' : 'Trust this hook before enabling it',
            valign: Gtk.Align.CENTER,
        });
        enabledSwitch.connect('notify::active', () => {
            if (!definition.trusted)
                return;

            hookManager.setDisabled(definition.fingerprint, !enabledSwitch.get_active());
            refresh();
        });
        controls.append(enabledSwitch);

        if (definition.trusted) {
            controls.append(createActionButton('edit-delete-symbolic', 'Revoke hook trust', () => {
                hookManager.revoke(definition.fingerprint);
                refresh();
            }));
        } else {
            controls.append(createActionButton('security-high-symbolic', 'Review and trust hook', () => {
                presentTrustDialog(parent, hookManager, definition, refresh);
            }));
        }

        row.add_suffix(controls);
    }

    const commandRow = new Adw.ActionRow({
        title: 'Command',
        subtitle: definition.command || 'No command',
    });
    row.add_row(commandRow);
    row.add_row(new Adw.ActionRow({
        title: 'Source',
        subtitle: definition.sourcePath,
    }));
    row.add_row(new Adw.ActionRow({
        title: 'Timeout',
        subtitle: `${definition.timeout} seconds`,
    }));

    if (definition.statusMessage) {
        row.add_row(new Adw.ActionRow({
            title: 'Status message',
            subtitle: definition.statusMessage,
        }));
    }

    for (const error of definition.errors) {
        row.add_row(new Adw.ActionRow({
            title: 'Configuration issue',
            subtitle: error,
        }));
    }

    if (definition.lastRun) {
        row.add_row(new Adw.ActionRow({
            title: 'Last run',
            subtitle: definition.lastRun.error
                || `Exit ${definition.lastRun.exitStatus} · ${definition.lastRun.durationMs} ms`,
        }));

        if (definition.lastRun.outputPath) {
            row.add_row(new Adw.ActionRow({
                title: 'Full output',
                subtitle: definition.lastRun.outputPath,
            }));
        }
    }

    return row;
}

export function createHooksSettingsPage(
    parent,
    hookManager,
    appSettings,
    conversation,
    conversationManager,
    onChanged = () => {},
    options = {},
) {
    const page = new Adw.PreferencesPage({
        title: 'Hooks',
        icon_name: 'application-x-executable-symbolic',
    });
    const behaviorGroup = new Adw.PreferencesGroup({
        title: 'Lifecycle Hooks',
        description: 'Run reviewed local commands around prompts, tools, permissions, compaction, and turn completion.',
    });
    const enabledRow = new Adw.SwitchRow({
        title: 'Enable trusted hooks',
        subtitle: 'Unreviewed or changed hook definitions are always skipped.',
        active: appSettings.hooksEnabled,
    });
    enabledRow.connect('notify::active', () => {
        appSettings.setHooksEnabled(enabledRow.get_active());
        if (enabledRow.get_active())
            hookManager.resetAllSessions();
        onChanged();
    });
    behaviorGroup.add(enabledRow);
    page.add(behaviorGroup);

    const workingDirectoryGroup = new Adw.PreferencesGroup({
        title: 'Working Directory',
        description: "Workspace hooks are loaded only from the selected directory's .cusco/hooks.json.",
    });
    const workingDirectoryRow = new Adw.ActionRow({
        title: 'Current chat',
        subtitle: conversation?.workingDirectory || 'Not set; only user hooks are discovered.',
    });
    const clearWorkingDirectoryButton = createActionButton(
        'edit-clear-symbolic',
        'Clear working directory',
        () => {
            if (!conversation)
                return;

            const previous = conversation.workingDirectory;
            conversationManager.setWorkingDirectory(conversation.id, '');
            hookManager.resetSession(conversation.id, previous);
            hookManager.resetSession(conversation.id, '');
            options.onWorkingDirectoryChanged?.(conversation, previous, '');
            workingDirectoryRow.set_subtitle('Not set; only user hooks are discovered.');
            clearWorkingDirectoryButton.set_sensitive(false);
            onChanged();
            refresh();
        },
    );
    clearWorkingDirectoryButton.set_sensitive(Boolean(conversation?.workingDirectory));
    workingDirectoryRow.add_suffix(clearWorkingDirectoryButton);
    workingDirectoryRow.add_suffix(createActionButton(
        'folder-open-symbolic',
        'Choose working directory',
        () => {
            const dialog = new Gtk.FileDialog({
                title: 'Choose Chat Working Directory',
            });
            dialog.select_folder(parent, null, (_dialog, result) => {
                try {
                    const folder = dialog.select_folder_finish(result);
                    const path = folder?.get_path();

                    if (!path || !conversation)
                        return;

                    const previous = conversation.workingDirectory;
                    conversationManager.setWorkingDirectory(conversation.id, path);
                    hookManager.resetSession(conversation.id, previous);
                    hookManager.resetSession(conversation.id, path);
                    options.onWorkingDirectoryChanged?.(conversation, previous, path);
                    workingDirectoryRow.set_subtitle(path);
                    clearWorkingDirectoryButton.set_sensitive(true);
                    onChanged();
                    refresh();
                } catch (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(error, 'Failed to choose hook working directory');
                }
            });
        },
    ));
    workingDirectoryGroup.add(workingDirectoryRow);
    page.add(workingDirectoryGroup);

    const sourcesGroup = new Adw.PreferencesGroup({
        title: 'Configuration Sources',
    });
    const hooksGroup = new Adw.PreferencesGroup({
        title: 'Discovered Hooks',
        description: 'All matching trusted hooks run. Commands for one event start concurrently.',
    });
    let sourceRows = [];
    let hookRows = [];

    const refresh = () => {
        for (const row of sourceRows)
            sourcesGroup.remove(row);
        for (const row of hookRows)
            hooksGroup.remove(row);

        const listing = hookManager.listHooks({
            workingDirectory: conversation?.workingDirectory ?? '',
        });
        sourceRows = listing.sources.map((source) => {
            const subtitle = source.errors.length > 0
                ? source.errors.join(' ')
                : source.exists ? source.path : `${source.path} — not found`;
            const row = new Adw.ActionRow({
                title: source.label,
                subtitle,
            });
            sourcesGroup.add(row);
            return row;
        });
        hookRows = listing.definitions.map((definition) => {
            const row = createDefinitionRow(parent, hookManager, definition, refresh);
            hooksGroup.add(row);
            return row;
        });

        if (hookRows.length === 0) {
            const row = new Adw.ActionRow({
                title: 'No hooks discovered',
                subtitle: 'Create a hooks.json file in one of the paths shown above.',
            });
            hooksGroup.add(row);
            hookRows.push(row);
        }
    };

    const reloadRow = new Adw.ActionRow({
        title: 'Reload hook files',
        subtitle: 'Changed definitions require review before they run again.',
    });
    reloadRow.add_suffix(createActionButton('view-refresh-symbolic', 'Reload hook files', refresh));
    sourcesGroup.add(reloadRow);
    refresh();
    page.add(sourcesGroup);
    page.add(hooksGroup);
    return page;
}
