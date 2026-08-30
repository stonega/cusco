import GLib from 'gi://GLib?version=2.0';

import { CuscoPluginClient } from '../src/plugins/client.js';
import { discoverPluginSkills, loadSkillFromPath } from '../src/skills/skills.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const repositoryRoot = GLib.get_current_dir();
const pluginRoot = GLib.build_filenamev([
    repositoryRoot,
    'plugins',
    'gnome-shell-extension-development',
]);
const skillRoot = GLib.build_filenamev([
    pluginRoot,
    'skills',
    'gnome-shell-extension-development',
]);

const catalog = await new CuscoPluginClient({ repositoryRoot }).listPlugins();
const plugin = catalog.find((entry) => entry.name === 'gnome-shell-extension-development');

assert(plugin, 'GNOME Extension Developer was missing from the bundled marketplace');
assert(
    plugin.displayName === 'GNOME Extension Developer'
    && plugin.category === 'Developer Tools'
    && plugin.hasSkills
    && !plugin.hasApps
    && !plugin.hasMcpServers
    && plugin.connectors.length === 0,
    'GNOME Extension Developer was not normalized as a skill-only plugin',
);

const skill = loadSkillFromPath(skillRoot, { source: 'plugin', enabled: true });
assert(!skill.loadError, `GNOME extension skill did not load: ${skill.loadError}`);
assert(
    skill.name === 'gnome-shell-extension-development'
    && skill.description.includes('GNOME Shell extensions')
    && skill.description.includes('extension.js')
    && skill.description.includes('prefs.js')
    && skill.description.includes('metadata.json'),
    'GNOME extension skill metadata does not cover its intended trigger surface',
);
assert(
    skill.content.includes('GNOME Shell 45 and later use ECMAScript modules'),
    'GNOME extension skill omitted the modern ESM version boundary',
);
assert(
    skill.content.includes('Create dynamic resources in `enable()`')
    && skill.content.includes('release all of them in `disable()`'),
    'GNOME extension skill omitted symmetric lifecycle guidance',
);
assert(
    skill.content.includes('Do not claim that `gjs -m extension.js` is a complete Shell test'),
    'GNOME extension skill omitted Shell-aware validation guidance',
);
assert(
    skill.content.includes("Installing, enabling, disabling, or replacing an extension changes the user's")
    && skill.content.includes('desktop session. Do those actions only when the user requested runtime testing'),
    'GNOME extension skill omitted desktop-session mutation safety',
);

const discovered = discoverPluginSkills({
    pluginsRootPath: GLib.build_filenamev([repositoryRoot, 'plugins']),
});
assert(
    discovered.some((entry) => (
        entry.name === skill.name
        && entry.source === 'plugin'
        && entry.path === skillRoot
    )),
    'GNOME extension skill was not found through plugin skill discovery',
);

const template = new TextDecoder().decode(GLib.file_get_contents(
    GLib.build_filenamev([skillRoot, 'references', 'project-templates.md']),
)[1]);
assert(
    template.includes("import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';")
    && template.includes('export default class ExampleExtension extends Extension')
    && template.includes('this._indicator?.destroy()')
    && template.includes('fillPreferencesWindow(window)')
    && !template.includes('const Main = imports.ui.main'),
    'GNOME extension templates are not modern ESM with symmetric cleanup',
);

const reviewChecklist = new TextDecoder().decode(GLib.file_get_contents(
    GLib.build_filenamev([skillRoot, 'references', 'review-release-checklist.md']),
)[1]);
assert(
    reviewChecklist.includes('Import time and constructors create no GObjects')
    && reviewChecklist.includes('Shell code does not import GTK')
    && reviewChecklist.includes('The extension contains no telemetry'),
    'GNOME extension review checklist omitted core EGO constraints',
);

const evals = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(
    GLib.build_filenamev([skillRoot, 'evals', 'evals.json']),
)[1]));
assert(
    evals.skill_name === skill.name
    && evals.evals.length === 3
    && evals.evals.every((entry) => (
        entry.prompt
        && entry.expected_output
        && entry.expectations.length >= 5
    )),
    'GNOME extension skill evaluations were incomplete',
);

print('Cusco GNOME extension plugin smoke passed');
