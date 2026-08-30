import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    PluginsPage,
    presentPluginDetailsDialog,
} from '../src/chat/pluginsPage.js';
import { CuscoPluginClient } from '../src/plugins/client.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function walkWidgets(widget, callback) {
    if (!widget)
        return;

    callback(widget);
    for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling())
        walkWidgets(child, callback);
}

function widgetLabels(widget) {
    const labels = [];
    walkWidgets(widget, (child) => {
        if (child instanceof Gtk.Label)
            labels.push(child.get_label());
    });
    return labels;
}

const catalog = await new CuscoPluginClient().listPlugins();
const pluginsPageSource = new TextDecoder().decode(GLib.file_get_contents(
    GLib.build_filenamev([GLib.get_current_dir(), 'src', 'chat', 'pluginsPage.js']),
)[1]);
assert(
    pluginsPageSource.includes("BUNDLED_PLUGIN_DEVELOPER = 'Cusco'")
    && !pluginsPageSource.toLowerCase().includes('ported from openai'),
    'Plugins UI did not consistently use Cusco branding or retained a porting notice',
);
const brandedPluginNames = [
    'gmail',
    'gnome-shell-extension-development',
    'github',
    'notion',
    'slack',
    'linear',
];

for (const name of brandedPluginNames) {
    const plugin = catalog.find((candidate) => candidate.name === name);

    assert(plugin, `${name} was missing from the bundled marketplace`);
    assert(
        plugin.manifest.interface?.developerName === 'Cusco',
        `${name} did not declare Cusco as its developer`,
    );
}

const github = catalog.find((plugin) => plugin.name === 'github');
assert(
    github.logoPath?.endsWith('/plugins/github/assets/github-small.svg'),
    'GitHub did not expose its bundled Invertocat icon',
);
const githubSvg = new TextDecoder().decode(GLib.file_get_contents(github.logoPath)[1]);
assert(
    githubSvg.includes('width="256"')
    && githubSvg.includes('height="256"')
    && githubSvg.includes('<title>GitHub</title>'),
    'GitHub icon was not the expected accessible high-resolution SVG',
);

if (Gtk.init_check()) {
    const page = new PluginsPage({
        client: {
            async listPlugins() {
                return [github];
            },
        },
    });
    await page.refresh();

    const catalogLabels = widgetLabels(page.widget);
    assert(
        catalogLabels.some((label) => label.includes('Cusco · Developer Tools')),
        'GitHub catalog row did not identify Cusco as its developer',
    );
    assert(
        !catalogLabels.some((label) => label.toLowerCase().includes('ported from openai')),
        'Plugin catalog still showed an OpenAI porting notice',
    );

    const details = presentPluginDetailsDialog(page.widget, github);
    const detailLabels = widgetLabels(details.get_child());
    assert(
        detailLabels.includes('Developer') && detailLabels.includes('Cusco'),
        'GitHub details did not identify Cusco as its developer',
    );
    assert(
        !detailLabels.some((label) => label.toLowerCase().includes('ported from openai')),
        'GitHub details still showed an OpenAI porting notice',
    );
    details.close();
    page.dispose();
}

print('Cusco plugin branding smoke passed');
