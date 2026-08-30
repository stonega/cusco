import GLib from 'gi://GLib?version=2.0';

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
const pluginRoot = GLib.build_filenamev([repositoryRoot, 'plugins', 'notion']);
const skillRoot = GLib.build_filenamev([pluginRoot, 'skills', 'notion']);

const catalog = await new CuscoPluginClient({ repositoryRoot }).listPlugins();
const plugin = catalog.find((entry) => entry.name === 'notion');

assert(plugin, 'Notion was missing from the bundled marketplace');
assert(
    plugin.displayName === 'Notion'
    && plugin.category === 'Productivity'
    && plugin.hasSkills
    && plugin.hasMcpServers
    && !plugin.hasApps
    && plugin.connectors.length === 1,
    'Notion was not normalized as a skill and MCP plugin',
);
assert(
    plugin.logoPath?.endsWith('/plugins/notion/assets/notion.svg')
    && GLib.file_test(plugin.logoPath, GLib.FileTest.IS_REGULAR)
    && plugin.manifest.interface.composerIcon === './assets/notion.svg'
    && plugin.manifest.interface.logoDark === './assets/notion.svg',
    'Notion did not expose its bundled theme-safe brand icon',
);

const connector = plugin.connectors[0];
assert(
    connector.type === 'mcp'
    && connector.name === 'Notion'
    && connector.server?.namespace === 'notion'
    && connector.server?.transport === 'streamable-http',
    'Notion did not expose one namespaced Streamable HTTP connector',
);
assert(
    connector.server?.url === 'https://mcp.notion.com/mcp'
    && connector.server?.oauth?.resource === 'https://mcp.notion.com/mcp',
    'Notion did not use its official hosted MCP endpoint and OAuth resource',
);
assert(
    connector.server?.permissionPolicy === 'ask',
    'Notion MCP calls were not configured to request permission',
);

const mcpText = readText(GLib.build_filenamev([pluginRoot, '.mcp.json']));
assert(
    !/(access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer)/i.test(mcpText),
    'Notion MCP configuration must not embed credentials',
);

const skill = loadSkillFromPath(skillRoot, { source: 'plugin', enabled: true });
assert(!skill.loadError, `Notion skill did not load: ${skill.loadError}`);
assert(
    skill.name === 'notion'
    && skill.description.includes('Notion pages')
    && skill.description.includes("Notion's official MCP server"),
    'Notion skill metadata does not cover its intended trigger surface',
);
assert(
    skill.content.includes("only path to the user's")
    && skill.content.includes('Notion workspace')
    && skill.content.includes('mcp__notion__')
    && skill.content.includes('Never use shell commands, browser automation, web search'),
    'Notion skill omitted its official-connector-only boundary',
);
assert(
    skill.content.includes('Read the target before changing existing content')
    && skill.content.includes('Never delete, archive, bulk-replace, move, or overwrite full page content'),
    'Notion skill omitted read-first and high-impact write safeguards',
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
    'Notion skill was not found through plugin skill discovery',
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
    'Notion skill evaluations were incomplete',
);

print('Cusco Notion plugin smoke passed');
