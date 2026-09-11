import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { BUNDLED_CATALOG } from '../src/providers/catalog.js';

const project = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const temporary = Gio.File.new_for_path(GLib.dir_make_tmp('cusco-catalog-resources-XXXXXX'));
const staged = temporary.get_child('app');
const files = [
    ['src/providers/catalog.js', 'providers/catalog.js'],
    ['src/packageLoader.js', 'packageLoader.js'],
    ['builddir/src/appInfo.js', 'appInfo.js'],
    ['data/model-catalog.v1.json', 'model-catalog.v1.json'],
    ['data/model-catalog.schema.json', 'model-catalog.schema.json'],
    ...['index', 'validation', 'parameters', 'snapshot', 'service', 'io'].map(name => [
        `packages/modelCatalog/${name}.js`, `packages/modelCatalog/${name}.js`,
    ]),
];
const directories = new Map();
let resource = null;
try {
    for (const [source, destination] of files) {
        const target = staged.resolve_relative_path(destination);
        const parent = target.get_parent();
        GLib.mkdir_with_parents(parent.get_path(), 0o700);
        for (let directory = parent; directory.get_path() !== temporary.get_path(); directory = directory.get_parent())
            directories.set(directory.get_path(), directory);
        project.resolve_relative_path(source).copy(target, Gio.FileCopyFlags.NONE, null, null);
    }
    const installed = await import(staged.resolve_relative_path('providers/catalog.js').get_uri());
    if (JSON.stringify(installed.BUNDLED_CATALOG.data) !== JSON.stringify(BUNDLED_CATALOG.data))
        throw new Error('Installed-layout catalog lookup differs from source execution');
    resource = Gio.Resource.load(project.resolve_relative_path('builddir/data/cusco-resources.gresource').get_path());
    Gio.resources_register(resource);
    for (const name of ['model-catalog.v1.json', 'model-catalog.schema.json'])
        staged.get_child(name).delete(null);
    if (JSON.stringify(installed.loadCatalogResource('model-catalog.v1.json')) !== JSON.stringify(BUNDLED_CATALOG.data))
        throw new Error('Compiled GResource catalog differs from the bundled source');
    if (installed.loadCatalogResource('model-catalog.schema.json').title !== 'Cusco model catalog v1')
        throw new Error('Compiled GResource schema is missing');
} finally {
    if (resource)
        Gio.resources_unregister(resource);
    for (const [, destination] of files) {
        const target = staged.resolve_relative_path(destination);
        if (target.query_exists(null))
            target.delete(null);
    }
    for (const directory of [...directories.values()].sort((a, b) => b.get_path().length - a.get_path().length))
        directory.delete(null);
    temporary.delete(null);
}
print('Cusco model catalog resource smoke passed');
