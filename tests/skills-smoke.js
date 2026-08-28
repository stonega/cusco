import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { ConversationManager } from '../src/chat/conversation.js';
import {
    buildSkillContext,
    discoverInstalledSkills,
    discoverPluginSkills,
    getAlwaysAvailableSkills,
    loadSkillFromPath,
} from '../src/skills/skills.js';
import { WorkspaceFileStore } from '../src/storage/workspaceStore.js';
import { createSkillsSettingsPage } from '../src/settings/workspaceSettings.js';
import { WorkspaceManager } from '../src/workspace/workspace.js';

function writeSkill(path, contents) {
    GLib.mkdir_with_parents(path, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([path, 'SKILL.md']), contents);
}

function walkWidgets(widget, callback) {
    callback(widget);

    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        walkWidgets(child, callback);
}

function findActionRow(root, title) {
    let result = null;

    walkWidgets(root, (widget) => {
        if (!result && widget instanceof Adw.ActionRow && widget.get_title() === title)
            result = widget;
    });

    return result;
}

function actionRowHasSourceTag(row, label, cssClass) {
    let result = false;

    walkWidgets(row, (widget) => {
        if (widget instanceof Gtk.Label
            && widget.get_text() === label
            && widget.has_css_class(cssClass)) {
            result = true;
        }
    });

    return result;
}

const rootPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-skills-${GLib.uuid_string_random()}`,
]);
const reviewSkillPath = GLib.build_filenamev([rootPath, 'review']);
const customSkillPath = GLib.build_filenamev([rootPath, 'custom-skill']);
const cuscoSkillsPath = GLib.build_filenamev([rootPath, 'cusco-skills']);
const cuscoSkillPath = GLib.build_filenamev([cuscoSkillsPath, 'repo-workflow']);
const cuscoPluginsPath = GLib.build_filenamev([rootPath, 'plugins']);
const pluginSkillPath = GLib.build_filenamev([
    cuscoPluginsPath,
    'design-tools',
    'skills',
    'plugin-workflow',
]);
const browserSkillPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-browser-skill-${GLib.uuid_string_random()}`,
]);

writeSkill(reviewSkillPath, [
    '---',
    'name: careful-review',
    'description: Review answers for correctness and missing evidence.',
    '---',
    '',
    '# Careful Review',
    '',
    'Check claims against the available context before answering.',
].join('\n'));
writeSkill(customSkillPath, [
    '# Custom Skill',
    '',
    'Prefer concise implementation notes.',
].join('\n'));
const customSkillReferencePath = GLib.build_filenamev([customSkillPath, 'references', 'notes.md']);
GLib.mkdir_with_parents(GLib.path_get_dirname(customSkillReferencePath), 0o700);
GLib.file_set_contents(customSkillReferencePath, 'Imported with the complete skill folder.\n');
writeSkill(cuscoSkillPath, [
    '---',
    'name: repo-workflow',
    'description: A repository-owned Cusco skill.',
    '---',
    '',
    '# Repo Workflow',
].join('\n'));
writeSkill(pluginSkillPath, [
    '---',
    'name: plugin-workflow',
    'description: A skill bundled with a Cusco plugin.',
    '---',
    '',
    '# Plugin Workflow',
].join('\n'));
writeSkill(browserSkillPath, [
    '---',
    'name: browser-skill',
    'description: |',
    '  Use when the user asks to perform browser automation tasks against their',
    '  logged-in browser: visit and read pages, fill forms, scrape data, click',
    '  through a flow, regression-test a PR\'s UI, validate a deployed page.',
    '  Requires the bsk CLI installed and the browser-skill extension loaded.',
    '---',
    '',
    '# Browser Skill',
    '',
    'Automate browser workflows.',
].join('\n'));

const discovered = discoverInstalledSkills({ rootPath });
const discoveredIds = discovered.map((skill) => skill.id).sort();

if (discoveredIds.length !== 2 || discoveredIds[0] !== 'custom-skill' || discoveredIds[1] !== 'review')
    throw new Error(`Installed skills were not discovered deterministically: ${discovered.map((skill) => skill.id).join(', ')}`);

const discoveredPluginSkills = discoverPluginSkills({ pluginsRootPath: cuscoPluginsPath });

if (discoveredPluginSkills.length !== 1 || discoveredPluginSkills[0].source !== 'plugin')
    throw new Error('Plugin-bundled skills were not discovered from the Cusco repository');

const loaded = loadSkillFromPath(reviewSkillPath, { source: 'global', id: 'review' });

if (loaded.name !== 'careful-review' || !loaded.description.includes('correctness'))
    throw new Error('Skill front matter was not parsed');

const browserSkill = loadSkillFromPath(browserSkillPath, { source: 'global', id: 'browser-skill' });
const expectedBrowserDescription = 'Use when the user asks to perform browser automation tasks against their logged-in browser: visit and read pages, fill forms, scrape data, click through a flow, regression-test a PR\'s UI, validate a deployed page. Requires the bsk CLI installed and the browser-skill extension loaded.';

if (browserSkill.description !== expectedBrowserDescription)
    throw new Error(`Skill block front matter description was not parsed: ${browserSkill.description}`);

const alwaysAvailableSkills = getAlwaysAvailableSkills();

if (!alwaysAvailableSkills.find((skill) => skill.id === 'cusco-mcp-setup'))
    throw new Error('Cusco MCP setup skill was not registered as always available');

if (!buildSkillContext([]).includes('~/.config/io.github.stonega.Cusco/mcp.json'))
    throw new Error('Always-available Cusco MCP setup skill was not added to skill context');

if (buildSkillContext([], { includeAlwaysAvailable: false }) !== '')
    throw new Error('Always-available skills could not be omitted for focused contexts');

if (!buildSkillContext([loaded]).includes('Check claims against the available context'))
    throw new Error('Skill context was not built from SKILL.md content');

const workspacePath = GLib.build_filenamev([rootPath, 'workspace.json']);
const workspace = new WorkspaceManager({
    store: new WorkspaceFileStore({ path: workspacePath }),
    globalSkillsPath: rootPath,
    cuscoSkillsPath,
    cuscoPluginsPath,
});

if (workspace.skills.length !== 4)
    throw new Error('Workspace did not discover global, Cusco, and plugin skills');

if (!workspace.skills.find((skill) => skill.source === 'cusco' && skill.name === 'repo-workflow'))
    throw new Error('Workspace did not discover the Cusco custom skill folder');

if (!workspace.enabledSkills.find((skill) => skill.source === 'plugin'))
    throw new Error('Newly installed plugin skills were not enabled');

workspace.setSkillEnabled('review', true);
const customSkill = workspace.importSkillFolder(customSkillPath, { enabled: true });
const importedSkillPath = GLib.build_filenamev([cuscoSkillsPath, 'custom-skill']);

if (customSkill.source !== 'cusco' || customSkill.path !== importedSkillPath)
    throw new Error('Added skill was not registered from the Cusco custom skill folder');

if (!GLib.file_test(
    GLib.build_filenamev([importedSkillPath, 'references', 'notes.md']),
    GLib.FileTest.IS_REGULAR,
)) {
    throw new Error('Added skill did not copy its complete folder into Cusco storage');
}

try {
    workspace.importSkillFolder(customSkillPath, { enabled: true });
    throw new Error('Duplicate Cusco skill import unexpectedly succeeded');
} catch (error) {
    if (!error.message.includes('already exists'))
        throw error;
}

if (Gtk.init_check()) {
    Adw.init();
    let openedSkillId = '';
    const settingsPage = createSkillsSettingsPage(null, workspace, () => {}, {
        onShowDetails: (skill) => openedSkillId = skill.id,
    });
    const refreshRow = findActionRow(settingsPage, 'Refresh installed skills');
    const addRow = findActionRow(settingsPage, 'Add skill folder');
    const globalRow = findActionRow(settingsPage, 'careful-review');
    const cuscoRow = findActionRow(settingsPage, 'repo-workflow');

    if (!refreshRow?.get_subtitle().includes('~/.agents/skills')
        || !refreshRow.get_subtitle().includes(cuscoSkillsPath)
        || !addRow?.get_subtitle().includes(cuscoSkillsPath)) {
        throw new Error('Skills settings did not show global and Cusco custom folder locations');
    }

    if (!actionRowHasSourceTag(globalRow, 'Global', 'cusco-skill-source-global')
        || !actionRowHasSourceTag(cuscoRow, 'Cusco', 'cusco-skill-source-local')) {
        throw new Error('Skills settings did not label global and Cusco skill sources');
    }

    globalRow.emit('activated');
    if (openedSkillId !== 'review')
        throw new Error('Activating a skill row did not request its detail dialog');
}

const conversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
});
const conversation = conversations.createConversation({
    skillIds: ['review', customSkill.id],
});
const activeSkills = workspace.getSkillsForConversation(conversation);

if (activeSkills.length !== 3 || activeSkills[0].id !== 'review')
    throw new Error('Workspace did not resolve selected conversation skills');

const staleConversation = conversations.createConversation({
    skillIds: ['review'],
});
const refreshedActiveSkills = workspace.getSkillsForConversation(staleConversation);

if (!refreshedActiveSkills.find((skill) => skill.id === customSkill.id))
    throw new Error('Workspace did not include newly enabled skills for an active skill conversation');

if (!workspace.buildSkillContextForConversation(conversation).includes('Prefer concise implementation notes'))
    throw new Error('Workspace did not build selected skill context');

if (!workspace.buildSkillContextForConversation(conversation).includes('Cusco MCP Setup'))
    throw new Error('Workspace did not include always-available skills in conversation context');

const removedGlobalSkillPath = GLib.build_filenamev([rootPath, 'removed-global']);
writeSkill(removedGlobalSkillPath, '# Removed Global Skill');
workspace.refreshInstalledSkills({ persist: false });

if (!workspace.getSkill('removed-global'))
    throw new Error('New global skill was not discovered before removal');

for (const path of [
    GLib.build_filenamev([removedGlobalSkillPath, 'SKILL.md']),
    removedGlobalSkillPath,
])
    Gio.File.new_for_path(path).delete(null);

workspace.refreshInstalledSkills({ persist: false });

if (workspace.getSkill('removed-global'))
    throw new Error('Removed global skill remained in the Cusco skill index');

for (const path of [
    GLib.build_filenamev([pluginSkillPath, 'SKILL.md']),
    pluginSkillPath,
    GLib.build_filenamev([cuscoPluginsPath, 'design-tools', 'skills']),
    GLib.build_filenamev([cuscoPluginsPath, 'design-tools']),
])
    Gio.File.new_for_path(path).delete(null);

workspace.refreshInstalledSkills({ persist: false });

if (workspace.skills.some((skill) => skill.source === 'plugin'))
    throw new Error('Removed plugin skills remained in the Cusco skill index');

const reloaded = new WorkspaceManager({
    store: new WorkspaceFileStore({ path: workspacePath }),
    globalSkillsPath: rootPath,
});

if (!reloaded.getSkill('review')?.enabled)
    throw new Error('Skill enabled state was not persisted');

print('Cusco skills smoke passed');
