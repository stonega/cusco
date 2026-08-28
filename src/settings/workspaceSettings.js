import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { findPromptVariables, formatPromptVariables } from '../workspace/promptVariables.js';
import { createMcpConfigGroup } from './mcpSettings.js';
import { createComputerUseSettingsGroup } from './computerUseSettings.js';
import { createHooksConfigGroup } from './hooksSettings.js';
import { presentDetailDialog } from '../detailDialog.js';

const ADD_PROMPT_HELPER_TEXT = [
    'Write the reusable prompt here.',
    'Add variables by wrapping a name in double braces, for example {{topic}}, {{tone}}, or {{team-name}}.',
    'Variable names must start with a letter and can use letters, numbers, underscores, and hyphens.',
    'Cusco highlights variables here and asks for their values when you insert the prompt.',
].join(' ');

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

function createSwitch(active, tooltipText, onChanged) {
    const control = new Gtk.Switch({
        active,
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
    });

    control.connect('notify::active', () => onChanged(control.get_active()));
    return control;
}

function textFromBuffer(buffer) {
    const [start, end] = buffer.get_bounds();
    return buffer.get_text(start, end, true);
}

function textBufferOffsetForStringIndex(text, index) {
    return [...text.slice(0, index)].length;
}

function highlightPromptVariables(buffer, tag) {
    const [start, end] = buffer.get_bounds();
    const text = textFromBuffer(buffer);
    buffer.remove_tag(tag, start, end);

    for (const variable of findPromptVariables(text)) {
        buffer.apply_tag(
            tag,
            buffer.get_iter_at_offset(textBufferOffsetForStringIndex(text, variable.start)),
            buffer.get_iter_at_offset(textBufferOffsetForStringIndex(text, variable.end)),
        );
    }
}

function createTextInput(placeholder, options = {}) {
    if (!options.multiline) {
        const entry = new Gtk.Entry({
            placeholder_text: placeholder,
            text: String(options.initialText ?? ''),
            hexpand: true,
        });

        return {
            widget: entry,
            getText: () => entry.get_text(),
        };
    }

    const buffer = new Gtk.TextBuffer();

    if (options.highlightVariables) {
        const variableTag = new Gtk.TextTag({
            name: 'prompt-variable',
            background: '#d8ecff',
            foreground: '#1c71d8',
            weight: Pango.Weight.BOLD,
        });
        buffer.get_tag_table().add(variableTag);
        buffer.connect('changed', () => highlightPromptVariables(buffer, variableTag));
    }

    buffer.set_text(String(options.initialText ?? ''), -1);

    const textView = new Gtk.TextView({
        buffer,
        accepts_tab: false,
        hexpand: true,
        vexpand: true,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
    });
    textView.add_css_class('cusco-prompt-editor');

    const scroller = new Gtk.ScrolledWindow({
        child: textView,
        min_content_width: 560,
        min_content_height: 160,
        max_content_height: 280,
        propagate_natural_height: true,
    });

    return {
        widget: scroller,
        getText: () => textFromBuffer(buffer),
    };
}

function createTextInputContent(input, placeholder, options = {}) {
    if (!options.multiline)
        return input.widget;

    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        hexpand: true,
    });
    const helperText = new Gtk.Label({
        label: placeholder,
        wrap: true,
        xalign: 0,
    });
    helperText.add_css_class('cusco-prompt-help-text');
    content.append(helperText);
    content.append(input.widget);
    return content;
}

function promptForText(parent, heading, placeholder, onSave, options = {}) {
    const input = createTextInput(placeholder, options);
    const content = createTextInputContent(input, placeholder, options);
    const dialog = new Adw.AlertDialog({
        heading,
    });
    dialog.set_extra_child(content);
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('save', 'Save');
    dialog.set_default_response('save');
    dialog.set_close_response('cancel');
    dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
    dialog.choose(parent, null, (_dialog, result) => {
        if (dialog.choose_finish(result) !== 'save')
            return;

        onSave(input.getText());
    });
}

function addRecordRows(group, records, collectionName, workspaceManager, refresh, options = {}) {
    const rows = [];

    for (const record of records) {
        const subtitle = [
            record.content ?? record.systemPrompt ?? record.command ?? record.color ?? '',
            collectionName === 'prompts' ? formatPromptVariables(record.content) : '',
        ].filter(Boolean).join('\n');
        const row = new Adw.ActionRow({
            title: record.title ?? record.name ?? record.key ?? 'Record',
            subtitle,
        });
        if (options.onEdit) {
            row.add_suffix(createActionButton('document-edit-symbolic', 'Edit prompt', () => {
                options.onEdit(record);
            }));
        }
        row.add_suffix(createActionButton('user-trash-symbolic', 'Delete', () => {
            try {
                workspaceManager.deleteRecord(collectionName, record.id);
                refresh();
            } catch (error) {
                logError(error, 'Failed to delete workspace record');
            }
        }));
        group.add(row);
        rows.push(row);
    }

    return rows;
}

function skillSubtitle(skill) {
    return [
        skill.loadError ? `Error: ${skill.loadError}` : skill.description,
        skill.path,
    ].filter(Boolean).join('\n');
}

function displayUserPath(path) {
    const value = String(path ?? '');
    const homePath = GLib.get_home_dir();

    if (value === homePath)
        return '~';

    return value.startsWith(`${homePath}/`)
        ? `~${value.slice(homePath.length)}`
        : value;
}

function createSkillSourceTag(skill) {
    const isGlobal = skill.source === 'global';
    const tag = new Gtk.Label({
        label: isGlobal ? 'Global' : 'Cusco',
        tooltip_text: isGlobal
            ? 'Discovered from ~/.agents/skills'
            : 'Managed by this Cusco repository',
        valign: Gtk.Align.CENTER,
    });
    tag.add_css_class('caption');
    tag.add_css_class('cusco-skill-source-tag');
    tag.add_css_class(isGlobal
        ? 'cusco-skill-source-global'
        : 'cusco-skill-source-local');
    return tag;
}

function showSkillImportError(parent, error) {
    const dialog = new Adw.AlertDialog({
        heading: 'Could Not Add Skill',
        body: error.message || 'The selected folder could not be imported.',
    });
    dialog.add_response('close', 'Close');
    dialog.set_close_response('close');
    dialog.present(parent);
}

function skillSourceLabel(skill) {
    switch (skill.source) {
    case 'global':
        return 'Global skill';
    case 'plugin':
        return 'Installed plugin';
    case 'cusco':
        return 'Cusco repository';
    case 'custom':
        return 'Custom location';
    case 'builtin':
        return 'Built into Cusco';
    default:
        return skill.source || 'Local skill';
    }
}

function skillContent(skill) {
    return String(skill.content ?? '').trim();
}

function skillDetailRow(title, value) {
    return new Adw.ActionRow({
        title,
        subtitle: String(value ?? ''),
        subtitle_lines: 3,
    });
}

export function presentSkillDetailsDialog(parent, skill) {
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        margin_top: 12,
        margin_bottom: 24,
        margin_start: 24,
        margin_end: 24,
    });
    const description = new Gtk.Label({
        label: skill.loadError
            ? `This skill could not be loaded: ${skill.loadError}`
            : skill.description || 'No description provided.',
        xalign: 0,
        wrap: true,
        selectable: true,
        max_width_chars: 62,
        hexpand: true,
        valign: Gtk.Align.CENTER,
    });
    description.add_css_class('cusco-detail-description');
    description.add_css_class('cusco-detail-hero');
    content.append(description);

    const details = new Adw.PreferencesGroup({ title: 'Details' });
    details.add(skillDetailRow(
        'Status',
        skill.loadError ? 'Unavailable' : (skill.enabled ? 'Enabled' : 'Disabled'),
    ));
    details.add(skillDetailRow('Source', skillSourceLabel(skill)));
    details.add(skillDetailRow('Identifier', skill.id || skill.name));
    if (skill.path)
        details.add(skillDetailRow('Location', displayUserPath(skill.path)));
    content.append(details);

    const skillText = skillContent(skill);
    if (skillText) {
        const contentGroup = new Adw.PreferencesGroup({ title: 'Skill content' });
        const contentLabel = new Gtk.Label({
            label: skillText,
            xalign: 0,
            yalign: 0,
            wrap: true,
            selectable: true,
            max_width_chars: 72,
        });
        contentLabel.add_css_class('cusco-detail-skill-content');
        contentGroup.add(contentLabel);
        content.append(contentGroup);
    }

    const scroller = new Gtk.ScrolledWindow({
        child: content,
        min_content_height: 280,
        max_content_height: 560,
        propagate_natural_height: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        window_placement: Gtk.CornerType.TOP_LEFT,
        vexpand: true,
    });
    return presentDetailDialog(parent, {
        title: skill.name || 'Skill details',
        child: scroller,
    });
}

function normalizeSkillIdentity(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSkillVisibleInSettings(skill) {
    return ![
        skill.id,
        skill.name,
        skill.path,
    ].some((value) => normalizeSkillIdentity(value).includes('codexcli'));
}

function loadSkillDetails(workspaceManager, skill) {
    try {
        return workspaceManager.loadSkill?.(skill.id) ?? skill;
    } catch (error) {
        logError(error, `Failed to load skill details for ${skill.id}`);
        return {
            ...skill,
            loadError: error?.message || 'The skill content could not be loaded.',
        };
    }
}

function addSkillRows(group, workspaceManager, refresh, options = {}) {
    const rows = [];

    for (const skill of workspaceManager.skills.filter(isSkillVisibleInSettings)) {
        const row = new Adw.ActionRow({
            title: skill.name,
            subtitle: skillSubtitle(skill),
            subtitle_lines: 2,
            activatable: true,
        });
        row.connect('activated', () => {
            options.onShowDetails?.(loadSkillDetails(workspaceManager, skill));
        });
        row.add_suffix(createSkillSourceTag(skill));
        row.add_suffix(createSwitch(skill.enabled, 'Enable skill', (enabled) => {
            try {
                workspaceManager.setSkillEnabled(skill.id, enabled);
                refresh();
            } catch (error) {
                logError(error, 'Failed to update skill enabled state');
            }
        }));
        row.add_suffix(createActionButton('view-refresh-symbolic', 'Refresh skill', () => {
            try {
                workspaceManager.refreshSkill(skill.id);
                refresh();
            } catch (error) {
                logError(error, 'Failed to refresh skill');
            }
        }));

        if (skill.source === 'custom') {
            row.add_suffix(createActionButton('user-trash-symbolic', 'Delete skill', () => {
                try {
                    workspaceManager.deleteRecord('skills', skill.id);
                    refresh();
                } catch (error) {
                    logError(error, 'Failed to delete skill');
                }
            }));
        }

        group.add(row);
        rows.push(row);
    }

    return rows;
}

export function createWorkspaceSettingsPage(
    parent,
    workspaceManager,
    mcpManagerOrOnChanged = null,
    maybeOnChanged = null,
    options = {},
) {
    const mcpManager = typeof mcpManagerOrOnChanged === 'function'
        ? null
        : mcpManagerOrOnChanged;
    const onChanged = typeof mcpManagerOrOnChanged === 'function'
        ? mcpManagerOrOnChanged
        : maybeOnChanged ?? (() => {});
    const page = new Adw.PreferencesPage({
        title: 'Workspace',
        icon_name: 'folder-documents-symbolic',
    });
    const refreshers = [];
    const refresh = () => {
        for (const refresher of refreshers)
            refresher();

        onChanged();
    };

    const promptsGroup = new Adw.PreferencesGroup({
        title: 'Prompt Library',
    });
    const addPromptRow = new Adw.ActionRow({
        title: 'Add prompt',
        subtitle: 'Create a reusable prompt snippet.',
    });
    addPromptRow.add_suffix(createActionButton('list-add-symbolic', 'Add prompt', () => {
        promptForText(
            parent,
            'Add Prompt',
            ADD_PROMPT_HELPER_TEXT,
            (content) => {
                workspaceManager.createPrompt({
                    title: content.slice(0, 48) || 'Untitled Prompt',
                    content,
                });
                refresh();
            },
            { multiline: true, highlightVariables: true },
        );
    }));
    promptsGroup.add(addPromptRow);
    let promptRows = [];
    const renderPrompts = () => {
        for (const row of promptRows)
            promptsGroup.remove(row);

        promptRows = addRecordRows(
            promptsGroup,
            workspaceManager.prompts,
            'prompts',
            workspaceManager,
            refresh,
            {
                onEdit: (prompt) => {
                    promptForText(
                        parent,
                        'Edit Prompt',
                        ADD_PROMPT_HELPER_TEXT,
                        (content) => {
                            try {
                                workspaceManager.updatePrompt(prompt.id, {
                                    title: content.slice(0, 48) || 'Untitled Prompt',
                                    content,
                                });
                                refresh();
                            } catch (error) {
                                logError(error, 'Failed to edit prompt');
                            }
                        },
                        {
                            multiline: true,
                            highlightVariables: true,
                            initialText: prompt.content,
                        },
                    );
                },
            },
        );
    };
    refreshers.push(renderPrompts);
    renderPrompts();

    page.add(promptsGroup);

    if (mcpManager)
        page.add(createMcpConfigGroup(parent, mcpManager, onChanged));

    if (options.hookManager) {
        page.add(createHooksConfigGroup(options.hookManager));
    }

    if (options.appSettings) {
        page.add(createComputerUseSettingsGroup(
            options.appSettings,
            options.computerUse ?? null,
            onChanged,
        ));
    }

    return page;
}

export function createSkillsManagementPage(
    parent,
    workspaceManager,
    onChanged = () => {},
    options = {},
) {
    const page = new Adw.PreferencesPage({
        title: 'Skills',
        icon_name: 'emblem-system-symbolic',
    });
    const refreshers = [];
    const refresh = () => {
        for (const refresher of refreshers)
            refresher();

        onChanged();
    };

    const skillsGroup = new Adw.PreferencesGroup({
        title: 'Skills',
        description: 'Use installed local SKILL.md instructions as optional chat context.',
    });
    const cuscoSkillsPath = displayUserPath(workspaceManager.cuscoSkillsPath);
    const refreshSkillsRow = new Adw.ActionRow({
        title: 'Refresh installed skills',
        subtitle: `Scans ~/.agents/skills and ${cuscoSkillsPath}; installed plugin skills are included.`,
    });
    refreshSkillsRow.add_suffix(createActionButton('view-refresh-symbolic', 'Refresh installed skills', () => {
        try {
            workspaceManager.refreshInstalledSkills();
            refresh();
        } catch (error) {
            logError(error, 'Failed to refresh installed skills');
        }
    }));
    skillsGroup.add(refreshSkillsRow);

    const addSkillRow = new Adw.ActionRow({
        title: 'Add skill folder',
        subtitle: `Copy a folder containing SKILL.md into ${cuscoSkillsPath}.`,
    });
    addSkillRow.add_suffix(createActionButton('list-add-symbolic', 'Add skill folder', () => {
        const dialog = new Gtk.FileDialog({
            title: 'Add Skill Folder',
        });
        dialog.select_folder(parent, null, (_dialog, result) => {
            try {
                const path = dialog.select_folder_finish(result)?.get_path();

                if (!path)
                    throw new Error('Only local skill folders are supported.');

                workspaceManager.importSkillFolder(path, { enabled: true });
                refresh();
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;

                logError(error, 'Failed to add skill folder');
                showSkillImportError(parent, error);
            }
        });
    }));
    skillsGroup.add(addSkillRow);

    let skillRows = [];
    const renderSkills = () => {
        for (const row of skillRows)
            skillsGroup.remove(row);

        skillRows = addSkillRows(skillsGroup, workspaceManager, refresh, {
            onShowDetails: options.onShowDetails
                ?? ((skill) => presentSkillDetailsDialog(parent, skill)),
        });
    };
    refreshers.push(renderSkills);
    renderSkills();

    page.add(skillsGroup);
    return {
        widget: page,
        refresh: renderSkills,
    };
}

export function createSkillsSettingsPage(
    parent,
    workspaceManager,
    onChanged = () => {},
    options = {},
) {
    return createSkillsManagementPage(parent, workspaceManager, onChanged, options).widget;
}
