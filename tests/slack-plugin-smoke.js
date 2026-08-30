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
const pluginRoot = GLib.build_filenamev([repositoryRoot, 'plugins', 'slack']);
const skillRoot = GLib.build_filenamev([pluginRoot, 'skills', 'slack']);

const catalog = await new CuscoPluginClient({ repositoryRoot }).listPlugins();
const plugin = catalog.find((entry) => entry.name === 'slack');

assert(plugin, 'Slack was missing from the bundled marketplace');
assert(
    plugin.displayName === 'Slack'
    && plugin.category === 'Communication'
    && plugin.hasSkills
    && plugin.hasMcpServers
    && !plugin.hasApps
    && plugin.connectors.length === 1,
    'Slack was not normalized as a skill and MCP plugin',
);
assert(
    plugin.logoPath?.endsWith('/plugins/slack/assets/slack.svg')
    && GLib.file_test(plugin.logoPath, GLib.FileTest.IS_REGULAR)
    && plugin.manifest.interface.composerIcon === './assets/slack.svg'
    && plugin.manifest.interface.logoDark === './assets/slack.svg',
    'Slack did not expose its bundled official color icon',
);

const connector = plugin.connectors[0];
const server = connector.server;
assert(
    connector.type === 'mcp'
    && connector.name === 'Slack'
    && server?.namespace === 'slack'
    && server?.transport === 'streamable-http',
    'Slack did not expose one namespaced Streamable HTTP connector',
);
assert(
    server?.url === 'https://mcp.slack.com/mcp'
    && server?.oauth?.resource === 'https://mcp.slack.com/mcp',
    'Slack did not use its official hosted MCP endpoint and OAuth resource',
);
assert(
    server?.oauth?.clientIdRequired
    && !server.oauth.clientId
    && server.oauth.callbackUrl === 'http://localhost:32119/callback'
    && server.oauth.callbackPort === 32119,
    'Slack did not require a user-owned registered app with a fixed local callback',
);
assert(
    pluginConnectorNeedsSetup(connector),
    'Slack did not route first connection through registered OAuth client setup',
);
assert(
    server.oauth.scopes.includes('search:read.public')
    && server.oauth.scopes.includes('chat:write')
    && server.oauth.scopes.includes('canvases:write')
    && server.permissionPolicy === 'ask',
    'Slack did not preserve its documented scopes and permission policy',
);

const mcpText = readText(GLib.build_filenamev([pluginRoot, '.mcp.json']));
assert(
    !/(clientId"\s*:\s*"\d|clientSecret|access[_-]?token|refresh[_-]?token)/i.test(mcpText)
    && !mcpText.includes('1601185624273.8899143856786')
    && !mcpText.includes('3660753192626.8903469228982'),
    'Slack MCP configuration must not embed credentials or another client identity',
);

const skill = loadSkillFromPath(skillRoot, { source: 'plugin', enabled: true });
assert(!skill.loadError, `Slack skill did not load: ${skill.loadError}`);
assert(
    skill.name === 'slack'
    && skill.description.includes('Slack messages')
    && skill.description.includes("Slack's official MCP server"),
    'Slack skill metadata does not cover its intended trigger surface',
);
assert(
    skill.content.includes('mcp__slack__')
    && skill.content.includes('Do not use shell commands, browser automation, web search')
    && skill.content.includes('Drafting text is not authorization to post it'),
    'Slack skill omitted its official connector boundary or draft safety',
);
assert(
    skill.content.includes('uses `@channel`, `@here`, `@everyone`')
    && skill.content.includes('private channel, direct message, or restricted file'),
    'Slack skill omitted broadcast and cross-channel confidentiality safeguards',
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
    'Slack skill was not found through plugin skill discovery',
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
    'Slack skill evaluations were incomplete',
);

print('Cusco Slack plugin smoke passed');
