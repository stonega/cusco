import GLib from 'gi://GLib?version=2.0';

import { pluginConnectorNeedsSetup } from '../src/chat/pluginsPage.js';
import { CuscoPluginClient } from '../src/plugins/client.js';
import { discoverPluginSkills, loadSkillFromPath } from '../src/skills/skills.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function readText(path) {
    return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
}

const repositoryRoot = GLib.get_current_dir();
const pluginRoot = GLib.build_filenamev([repositoryRoot, 'plugins', 'linear']);
const skillRoot = GLib.build_filenamev([pluginRoot, 'skills', 'linear']);

const catalog = await new CuscoPluginClient({ repositoryRoot }).listPlugins();
const plugin = catalog.find((entry) => entry.name === 'linear');

assert(plugin, 'Linear was missing from the bundled marketplace');
assert(
    plugin.displayName === 'Linear'
    && plugin.category === 'Productivity'
    && plugin.hasSkills
    && plugin.hasMcpServers
    && !plugin.hasApps
    && plugin.connectors.length === 1,
    'Linear was not normalized as a skill and MCP plugin',
);
assert(
    plugin.logoPath?.endsWith('/plugins/linear/assets/linear.svg')
    && GLib.file_test(plugin.logoPath, GLib.FileTest.IS_REGULAR)
    && plugin.manifest.interface.composerIcon === './assets/linear.svg'
    && plugin.manifest.interface.logoDark === './assets/linear.svg',
    'Linear did not expose its bundled official brand icon',
);

const connector = plugin.connectors[0];
assert(
    connector.type === 'mcp'
    && connector.name === 'Linear'
    && connector.server?.namespace === 'linear'
    && connector.server?.transport === 'streamable-http',
    'Linear did not expose one namespaced Streamable HTTP connector',
);
assert(
    connector.server?.url === 'https://mcp.linear.app/mcp'
    && connector.server?.oauth?.resource === 'https://mcp.linear.app/mcp'
    && !connector.server?.oauth?.clientIdRequired,
    'Linear did not use its official dynamic-registration MCP endpoint',
);
assert(
    !pluginConnectorNeedsSetup(connector),
    'Linear incorrectly required manual OAuth client setup despite dynamic registration',
);
assert(
    connector.server?.permissionPolicy === 'ask',
    'Linear MCP calls were not configured to request permission',
);

const mcpText = readText(GLib.build_filenamev([pluginRoot, '.mcp.json']));
assert(
    !/(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|bearer)/i.test(mcpText),
    'Linear MCP configuration must not embed credentials',
);

const skill = loadSkillFromPath(skillRoot, { source: 'plugin', enabled: true });
assert(!skill.loadError, `Linear skill did not load: ${skill.loadError}`);
assert(
    skill.name === 'linear'
    && skill.description.includes('Linear issues')
    && skill.description.includes("Linear's official MCP server"),
    'Linear skill metadata does not cover its intended trigger surface',
);
assert(
    skill.content.includes('mcp__linear__')
    && skill.content.includes('Never use shell commands, browser automation, web search')
    && skill.content.includes('Fetch the selected object and its current fields'),
    'Linear skill omitted its official connector boundary or read-first workflow',
);
assert(
    skill.content.includes('Before creating a project, initiative, milestone set')
    && skill.content.includes('canceling or closing multiple issues'),
    'Linear skill omitted structural review and consequential write safeguards',
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
    'Linear skill was not found through plugin skill discovery',
);

const evals = JSON.parse(readText(
    GLib.build_filenamev([skillRoot, 'evals', 'evals.json']),
));
assert(
    evals.skill_name === skill.name
    && evals.evals.length === 3
    && evals.evals.every((entry) => (
        entry.prompt
        && entry.expected_output
        && entry.expectations.length >= 5
    )),
    'Linear skill evaluations were incomplete',
);

print('Cusco Linear plugin smoke passed');
