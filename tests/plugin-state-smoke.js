import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { CuscoPluginClient, isPluginRemoved } from '../packages/plugins/client.js';
import { discoverPluginSkills } from '../src/skills/skills.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function writeText(path, contents) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, contents);
}

function visitChildren(file, callback) {
    const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    try {
        for (let info = children.next_file(null); info; info = children.next_file(null))
            callback(file.get_child(info.get_name()));
    } finally {
        children.close(null);
    }
}

function makeReadOnly(file) {
    const directory = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY;
    if (directory)
        visitChildren(file, makeReadOnly);
    assert(GLib.chmod(file.get_path(), directory ? 0o555 : 0o444) === 0,
        'Could not make the packaged plugin fixture read-only');
}

function removeDirectory(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        GLib.chmod(file.get_path(), 0o700);
        visitChildren(file, removeDirectory);
    }
    file.delete(null);
}

function createRepository(repositoryRoot) {
    for (const name of ['bundled', 'legacy']) {
        writeText(`${repositoryRoot}/plugins/${name}/.cusco-plugin/plugin.json`, JSON.stringify({
            name,
            version: '1.0.0',
            skills: './skills',
        }));
        writeText(`${repositoryRoot}/plugins/${name}/skills/${name}/SKILL.md`, `# ${name}\n\nTest skill.\n`);
    }
    writeText(`${repositoryRoot}/.agents/plugins/marketplace.json`, JSON.stringify({
        name: 'cusco',
        plugins: ['bundled', 'legacy'].map((name) => ({
            name,
            source: { source: 'local', path: `./plugins/${name}` },
        })),
    }));
    writeText(`${repositoryRoot}/plugins/.removed/legacy`, 'removed\n');
    makeReadOnly(Gio.File.new_for_path(repositoryRoot));
}

function runChild(mode, root, dataDirectory) {
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
    launcher.setenv('XDG_DATA_HOME', dataDirectory, true);
    const process = launcher.spawnv([
        'gjs', '-m', Gio.File.new_for_uri(import.meta.url).get_path(), mode, root,
    ]);
    process.wait_check(null);
}

async function checkDefaults(repositoryRoot) {
    const catalog = await new CuscoPluginClient({ repositoryRoot }).listPlugins();
    assert(catalog.find((plugin) => plugin.name === 'bundled')?.installed,
        'Removal state leaked across users or installation roots');
    assert(!catalog.find((plugin) => plugin.name === 'legacy')?.installed,
        'Legacy removal state was ignored');
}

if (ARGV[0] === '--other-user') {
    await checkDefaults(`${ARGV[1]}/repository`);
} else if (ARGV[0] === '--isolated') {
    const root = ARGV[1];
    const repositoryRoot = `${root}/repository`;
    const pluginsRootPath = `${repositoryRoot}/plugins`;
    createRepository(repositoryRoot);
    await checkDefaults(repositoryRoot);
    assert(discoverPluginSkills({ pluginsRootPath }).length === 1,
        'Legacy removal did not hide bundled skills');

    for (let cycle = 0; cycle < 2; cycle++) {
        for (const name of ['bundled', 'legacy']) {
            const removingClient = new CuscoPluginClient({ repositoryRoot });
            await removingClient.uninstall(`${name}@cusco`);
            assert(isPluginRemoved(`${pluginsRootPath}/../plugins`, name),
                'Removal state did not persist for the canonical plugin root');
            const reinstallingClient = new CuscoPluginClient({ repositoryRoot });
            const plugin = (await reinstallingClient.listPlugins()).find((entry) => entry.name === name);
            assert(!plugin.installed && !plugin.enabled && plugin.hasSkills,
                'Removed plugin lost its catalog metadata or remained active');
            assert(!discoverPluginSkills({ pluginsRootPath }).some((skill) => skill.name === name),
                'Removed plugin still exposed skills');
            runChild('--other-user', root, `${root}/user-b`);

            await reinstallingClient.install(plugin.pluginId);
            const freshClient = new CuscoPluginClient({ repositoryRoot });
            assert((await freshClient.listPlugins()).find((entry) => entry.name === name)?.installed,
                'Reinstallation did not persist across client instances');
            assert(discoverPluginSkills({ pluginsRootPath }).some((skill) => skill.name === name),
                'Reinstallation did not restore skills');
        }
    }
    runChild('--other-user', root, `${root}/user-b`);
    assert(!GLib.file_test(`${pluginsRootPath}/.removed/bundled`, GLib.FileTest.EXISTS),
        'Removal wrote state into the packaged plugin directory');
    const [, legacyContents] = GLib.file_get_contents(`${pluginsRootPath}/.removed/legacy`);
    assert(new TextDecoder().decode(legacyContents) === 'removed\n',
        'Reinstallation modified the legacy system marker');

    await new CuscoPluginClient({ repositoryRoot }).uninstall('bundled@cusco');
    createRepository(`${root}/second-repository`);
    await checkDefaults(`${root}/second-repository`);
} else {
    const root = GLib.dir_make_tmp('cusco-plugin-state-XXXXXX');
    try {
        runChild('--isolated', root, `${root}/user-a`);
    } finally {
        removeDirectory(Gio.File.new_for_path(root));
    }
    print('Cusco read-only plugin state smoke passed');
}
