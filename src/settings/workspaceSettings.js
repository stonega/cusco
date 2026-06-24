import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import { formatPromptVariables } from '../workspace/promptVariables.js';

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

function promptForText(parent, heading, placeholder, onSave) {
    const entry = new Gtk.Entry({
        placeholder_text: placeholder,
        hexpand: true,
    });
    const dialog = new Adw.AlertDialog({
        heading,
    });
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

function addRecordRows(group, records, collectionName, workspaceManager, refresh) {
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
        `${skill.source === 'global' ? 'Installed' : 'Custom'}: ${skill.path}`,
    ].filter(Boolean).join('\n');
}

function addSkillRows(group, workspaceManager, refresh) {
    const rows = [];

    for (const skill of workspaceManager.skills) {
        const row = new Adw.ActionRow({
            title: skill.name,
            subtitle: skillSubtitle(skill),
        });
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

        if (skill.source !== 'global') {
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

export function createWorkspaceSettingsPage(parent, workspaceManager, onChanged = () => {}) {
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
        promptForText(parent, 'Add Prompt', 'Prompt text', (content) => {
            workspaceManager.createPrompt({
                title: content.slice(0, 48) || 'Untitled Prompt',
                content,
            });
            refresh();
        });
    }));
    promptsGroup.add(addPromptRow);
    let promptRows = [];
    const renderPrompts = () => {
        for (const row of promptRows)
            promptsGroup.remove(row);

        promptRows = addRecordRows(promptsGroup, workspaceManager.prompts, 'prompts', workspaceManager, refresh);
    };
    refreshers.push(renderPrompts);
    renderPrompts();

    const profilesGroup = new Adw.PreferencesGroup({
        title: 'Agent Profiles',
    });
    const addProfileRow = new Adw.ActionRow({
        title: 'Add profile',
        subtitle: 'Create a reusable agent system prompt.',
    });
    addProfileRow.add_suffix(createActionButton('list-add-symbolic', 'Add profile', () => {
        promptForText(parent, 'Add Agent Profile', 'System prompt', (systemPrompt) => {
            workspaceManager.createProfile({
                name: systemPrompt.slice(0, 48) || 'Agent Profile',
                systemPrompt,
            });
            refresh();
        });
    }));
    profilesGroup.add(addProfileRow);
    let profileRows = [];
    const renderProfiles = () => {
        for (const row of profileRows)
            profilesGroup.remove(row);

        profileRows = addRecordRows(profilesGroup, workspaceManager.profiles, 'profiles', workspaceManager, refresh);
    };
    refreshers.push(renderProfiles);
    renderProfiles();

    page.add(promptsGroup);
    page.add(profilesGroup);
    return page;
}

export function createSkillsSettingsPage(parent, workspaceManager, onChanged = () => {}) {
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
    const refreshSkillsRow = new Adw.ActionRow({
        title: 'Refresh installed skills',
        subtitle: 'Scans ~/.agents/skills for skill folders.',
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
        subtitle: 'Register another folder containing SKILL.md.',
    });
    addSkillRow.add_suffix(createActionButton('list-add-symbolic', 'Add skill folder', () => {
        promptForText(parent, 'Add Skill Folder', '~/path/to/skill', (path) => {
            try {
                workspaceManager.addSkillPath(path, { enabled: true });
                refresh();
            } catch (error) {
                logError(error, 'Failed to add skill folder');
            }
        });
    }));
    skillsGroup.add(addSkillRow);

    let skillRows = [];
    const renderSkills = () => {
        for (const row of skillRows)
            skillsGroup.remove(row);

        skillRows = addSkillRows(skillsGroup, workspaceManager, refresh);
    };
    refreshers.push(renderSkills);
    renderSkills();

    page.add(skillsGroup);
    return page;
}
