import GLib from 'gi://GLib?version=2.0';

import { ConversationManager } from '../src/chat/conversation.js';
import {
    buildSkillContext,
    discoverInstalledSkills,
    getAlwaysAvailableSkills,
    loadSkillFromPath,
} from '../src/skills/skills.js';
import { WorkspaceFileStore } from '../src/storage/workspaceStore.js';
import { WorkspaceManager } from '../src/workspace/workspace.js';

function writeSkill(path, contents) {
    GLib.mkdir_with_parents(path, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([path, 'SKILL.md']), contents);
}

const rootPath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-skills-${GLib.uuid_string_random()}`,
]);
const reviewSkillPath = GLib.build_filenamev([rootPath, 'review']);
const customSkillPath = GLib.build_filenamev([rootPath, 'custom-skill']);

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

const discovered = discoverInstalledSkills({ rootPath });
const discoveredIds = discovered.map((skill) => skill.id).sort();

if (discoveredIds.length !== 2 || discoveredIds[0] !== 'custom-skill' || discoveredIds[1] !== 'review')
    throw new Error(`Installed skills were not discovered deterministically: ${discovered.map((skill) => skill.id).join(', ')}`);

const loaded = loadSkillFromPath(reviewSkillPath, { source: 'global', id: 'review' });

if (loaded.name !== 'careful-review' || !loaded.description.includes('correctness'))
    throw new Error('Skill front matter was not parsed');

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
});

if (workspace.skills.length !== 2)
    throw new Error('Workspace did not discover installed skills');

workspace.setSkillEnabled('review', true);
const customSkill = workspace.addSkillPath(customSkillPath, { enabled: true });

const conversations = new ConversationManager({
    providerId: 'openai',
    modelId: 'gpt-5.5',
});
const conversation = conversations.createConversation({
    skillIds: ['review', customSkill.id],
});
const activeSkills = workspace.getSkillsForConversation(conversation);

if (activeSkills.length !== 2 || activeSkills[0].id !== 'review')
    throw new Error('Workspace did not resolve selected conversation skills');

if (!workspace.buildSkillContextForConversation(conversation).includes('Prefer concise implementation notes'))
    throw new Error('Workspace did not build selected skill context');

if (!workspace.buildSkillContextForConversation(conversation).includes('Cusco MCP Setup'))
    throw new Error('Workspace did not include always-available skills in conversation context');

const reloaded = new WorkspaceManager({
    store: new WorkspaceFileStore({ path: workspacePath }),
    globalSkillsPath: rootPath,
});

if (!reloaded.getSkill('review')?.enabled)
    throw new Error('Skill enabled state was not persisted');

print('Cusco skills smoke passed');
