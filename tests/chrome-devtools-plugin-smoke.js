import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { pluginConnectorNeedsSetup } from '../src/chat/pluginsPage.js';
import { CuscoPluginClient } from '../src/plugins/client.js';
import { discoverPluginSkills } from '../src/skills/skills.js';
import { McpClient } from '../packages/mcp/client.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function readText(path) {
    return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
}

function removeDirectory(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        try {
            for (let info = children.next_file(null); info; info = children.next_file(null))
                removeDirectory(file.get_child(info.get_name()));
        } finally {
            children.close(null);
        }
    }
    file.delete(null);
}

async function checkLiveTaskGroups(server, pluginPath) {
    const client = new McpClient({ ...server, args: [...server.args, '--headless'] });
    const call = async (name, args = {}) => {
        const result = await client.callTool(name, args, { timeoutSeconds: 45 });
        assert(!result.isError, `${name} failed: ${JSON.stringify(result)}`);
        return result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    };
    const evaluate = async (pageId, expression) => {
        const result = await call('evaluate_script', {
            pageId,
            function: `async () => ${expression}`,
        });
        const json = result.match(/```json\s*([\s\S]*?)```/);
        assert(json, `Evaluation did not return JSON: ${result}`);
        return JSON.parse(json[1]);
    };
    try {
        await client.connect({ timeoutSeconds: 45 });
        const tools = await client.listTools();
        assert(tools.some((tool) => tool.name === 'install_extension'), 'Live server lacked extension tools');
        const installed = await call('install_extension', {
            path: GLib.build_filenamev([pluginPath, 'skills', 'chrome-devtools', 'assets', 'task-groups']),
        });
        const extensionId = installed.match(/Id: ([a-p]{32})/)?.[1];
        assert(extensionId, `No installed extension ID: ${installed}`);
        const newTab = async () => {
            const page = await call('new_page', { url: `chrome-extension://${extensionId}/task.html` });
            const selectedId = page.match(/^(\d+): .*\[selected\]/m)?.[1];
            assert(selectedId, `No MCP page ID for task tab: ${page}`);
            return Number(selectedId);
        };
        const assign = (pageId, options) => evaluate(pageId, `await cuscoTaskGroup.assign(${JSON.stringify(options)})`);

        // An unrelated pre-existing tab must stay ungrouped.
        const unrelatedPage = await newTab();
        const unrelated = await evaluate(unrelatedPage, 'await chrome.tabs.getCurrent()');
        const firstPage = await newTab();
        const first = await assign(firstPage, { title: 'Layout check' });
        const retry = await assign(firstPage, { title: 'Layout check' });
        assert(retry.groupId === first.groupId, 'A retry created a duplicate task group');
        await call('navigate_page', { pageId: firstPage, url: 'about:blank' });

        // A different task with the same title still needs its own group.
        const secondPage = await newTab();
        const second = await assign(secondPage, { title: 'Layout check' });
        assert(second.groupId !== first.groupId, 'Different tasks shared a group by title');
        const followupPage = await newTab();
        const followup = await assign(followupPage, { title: 'Layout check', groupId: first.groupId });
        assert(followup.groupId === first.groupId, 'A follow-up tab did not join its task group');
        const firstTab = await evaluate(followupPage, `await chrome.tabs.get(${first.browserTabId})`);
        const untouched = await evaluate(followupPage, `await chrome.tabs.get(${unrelated.id})`);
        assert(firstTab.groupId === first.groupId, 'Navigation lost the first tab\'s group');
        assert(untouched.groupId === unrelated.groupId && untouched.groupId === -1, 'Grouping moved an unrelated tab');
        const members = await evaluate(followupPage, `await chrome.tabs.query({groupId: ${first.groupId}})`);
        assert(members.length === 2, 'Task group did not contain exactly its two tabs');
        const rejected = await evaluate(followupPage,
            `cuscoTaskGroup.assign({title: 'Different task', groupId: ${first.groupId}}).then(() => false, () => true)`);
        assert(rejected, 'The helper accepted a mismatched task title');
        const group = await evaluate(followupPage, `await chrome.tabGroups.get(${first.groupId})`);
        assert(group.title === 'Cusco · Layout check' && !group.collapsed, 'Task group was not visibly named and expanded');
        print(`Chrome task groups live check passed (${tools.length} MCP tools)`);
    } finally {
        client.disconnect();
    }
}

const repositoryRoot = GLib.get_current_dir();
const catalog = await new CuscoPluginClient({ repositoryRoot }).listPlugins();
const plugin = catalog.find((entry) => entry.name === 'chrome-devtools');
assert(plugin, 'Chrome DevTools was missing or hidden in the predefined catalog');
assert(
    plugin.displayName === 'Chrome DevTools' && plugin.category === 'Developer Tools'
    && plugin.hasSkills && plugin.hasMcpServers && !plugin.hasApps
    && plugin.connectors.length === 1,
    'Chrome DevTools did not expose its skills and one MCP connector',
);
const connector = plugin.connectors[0];
const server = connector.server;
assert(
    connector.type === 'mcp' && !pluginConnectorNeedsSetup(connector)
    && server.transport === 'stdio' && server.command === 'npx'
    && server.namespace === 'chrome_devtools'
    && server.args.includes(`chrome-devtools-mcp@${plugin.version}`)
    && server.args.includes('-y') && server.permissionPolicy === 'ask',
    'Chrome DevTools cannot connect using its pinned local server and normal permission controls',
);
assert(
    ['--isolated', '--category-extensions', '--memory-debugging',
        '--no-usage-statistics', '--no-performance-crux'].every((flag) => server.args.includes(flag))
    && !server.args.includes('--slim') && !server.args.includes('--auto-connect'),
    'Chrome DevTools defaults did not preserve its isolated browser and full skill capabilities',
);

const expectedSkills = [
    'chrome-devtools',
    'chrome-devtools-a11y-debugging',
    'chrome-devtools-cli',
    'chrome-devtools-cookie-debugging',
    'chrome-devtools-debug-optimize-lcp',
    'chrome-devtools-memory-leak-debugging',
    'chrome-devtools-troubleshooting',
].sort();
const temporaryRoot = GLib.dir_make_tmp('cusco-chrome-plugin-XXXXXX');
try {
    const marketplaceDirectory = GLib.build_filenamev([temporaryRoot, '.agents', 'plugins']);
    GLib.mkdir_with_parents(marketplaceDirectory, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([marketplaceDirectory, 'marketplace.json']), JSON.stringify({
        name: 'cusco',
        plugins: [{ name: plugin.name, source: { source: 'local', path: plugin.sourcePath } }],
    }));
    const client = new CuscoPluginClient({ repositoryRoot: temporaryRoot });
    const available = (await client.listPlugins())[0];
    assert(!available.installed, 'Temporary catalog incorrectly reported an installed plugin');
    const installed = await client.install(available.pluginId);
    const installedPlugin = (await client.listPlugins())[0];
    assert(installedPlugin.installed, 'Plugin installation did not update catalog state');
    const skills = discoverPluginSkills({ pluginsRootPath: GLib.build_filenamev([temporaryRoot, 'plugins']) });
    assert(
        JSON.stringify(skills.map((skill) => skill.name).sort()) === JSON.stringify(expectedSkills)
        && skills.every((skill) => skill.source === 'plugin' && skill.enabled && !skill.loadError
            && skill.content && skill.description),
        'Installation did not discover all seven enabled, readable plugin skills',
    );

    // Check actual relative references from the copied skills, not just their entrypoints.
    const pending = skills.map((skill) => GLib.build_filenamev([skill.path, 'SKILL.md']));
    const visited = new Set();
    while (pending.length > 0) {
        const path = pending.pop();
        if (visited.has(path))
            continue;
        visited.add(path);
        for (const match of readText(path).matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
            const target = match[1].split('#')[0];
            if (!target || /^[a-z]+:/i.test(target))
                continue;
            const resolved = GLib.canonicalize_filename(target, GLib.path_get_dirname(path));
            assert(resolved.startsWith(`${installed.path}/`), `Reference escaped the plugin: ${target}`);
            assert(GLib.file_test(resolved, GLib.FileTest.IS_REGULAR), `Missing copied reference: ${target}`);
            if (resolved.endsWith('.md'))
                pending.push(resolved);
        }
    }
    for (const relative of ['.cusco-plugin/plugin.json', '.mcp.json', 'assets/devtools.svg', 'LICENSE', 'NOTICE']) {
        assert(
            readText(GLib.build_filenamev([installed.path, relative]))
            === readText(GLib.build_filenamev([plugin.sourcePath, relative])),
            `Plugin installation failed to preserve ${relative}`,
        );
    }
    const helperManifest = JSON.parse(readText(GLib.build_filenamev([
        installed.path, 'skills', 'chrome-devtools', 'assets', 'task-groups', 'manifest.json',
    ])));
    assert(
        JSON.stringify(helperManifest.permissions) === '["tabGroups"]'
        && !helperManifest.host_permissions && !helperManifest.content_scripts && !helperManifest.background,
        'Task group helper requested unrelated browsing access or a background runtime',
    );
    if (ARGV.includes('--live'))
        await checkLiveTaskGroups(server, installed.path);
    await client.uninstall(available.pluginId);
    assert(!(await client.listPlugins())[0].installed, 'Removal did not clear the installed state');
    assert(
        discoverPluginSkills({ pluginsRootPath: GLib.build_filenamev([temporaryRoot, 'plugins']) }).length === 0,
        'Removal left plugin skills discoverable',
    );
    assert(GLib.file_test(plugin.sourcePath, GLib.FileTest.IS_DIR), 'Removal affected the predefined source');
} finally {
    removeDirectory(Gio.File.new_for_path(temporaryRoot));
}

print('Cusco Chrome DevTools plugin smoke passed');
