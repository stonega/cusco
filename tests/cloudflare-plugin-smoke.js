import GLib from 'gi://GLib?version=2.0';

import { pluginConnectorNeedsSetup } from '../src/chat/pluginsPage.js';
import { CuscoPluginClient } from '../src/plugins/client.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function readText(path) {
    return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
}

const repositoryRoot = GLib.get_current_dir();
const pluginRoot = GLib.build_filenamev([repositoryRoot, 'plugins', 'cloudflare']);
const catalog = await new CuscoPluginClient({ repositoryRoot }).listPlugins();
const plugin = catalog.find((entry) => entry.name === 'cloudflare');

assert(plugin, 'Cloudflare was missing from the bundled marketplace');
assert(
    plugin.displayName === 'Cloudflare'
    && plugin.category === 'Developer Tools'
    && !plugin.hasSkills
    && plugin.hasMcpServers
    && !plugin.hasApps
    && plugin.connectors.length === 1,
    'Cloudflare was not normalized as an MCP plugin',
);
assert(
    plugin.logoPath?.endsWith('/plugins/cloudflare/assets/cloudflare.svg')
    && GLib.file_test(plugin.logoPath, GLib.FileTest.IS_REGULAR)
    && plugin.manifest.interface.composerIcon === './assets/cloudflare.svg'
    && plugin.manifest.interface.logoDark === './assets/cloudflare.svg',
    'Cloudflare did not expose its bundled official brand logo',
);

const connector = plugin.connectors[0];
assert(
    connector.type === 'mcp'
    && connector.name === 'Cloudflare API'
    && connector.server?.namespace === 'cloudflare_api'
    && connector.server?.transport === 'streamable-http',
    'Cloudflare did not expose one namespaced Streamable HTTP connector',
);
assert(
    connector.server?.url === 'https://mcp.cloudflare.com/mcp'
    && connector.server?.oauth?.resource === 'https://mcp.cloudflare.com/mcp'
    && !connector.server?.oauth?.clientIdRequired,
    'Cloudflare did not use its official dynamically registered MCP endpoint',
);
assert(
    !pluginConnectorNeedsSetup(connector),
    'Cloudflare incorrectly required manual OAuth client setup',
);
assert(
    connector.server?.permissionPolicy === 'ask',
    'Cloudflare MCP calls were not configured to request permission',
);

const mcpText = readText(GLib.build_filenamev([pluginRoot, '.mcp.json']));
assert(
    !/(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?token|bearer)/i.test(mcpText),
    'Cloudflare MCP configuration must not embed credentials',
);

const logoText = readText(GLib.build_filenamev([pluginRoot, 'assets', 'cloudflare.svg']));
assert(
    logoText.includes('width="66"')
    && logoText.includes('height="30"')
    && logoText.includes('#F6821F'),
    'Cloudflare icon did not match the official bundled logo',
);

print('Cusco Cloudflare plugin smoke passed');
