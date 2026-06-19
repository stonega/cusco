import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const APP_ID = 'io.github.stonega.Cusco';
const DATABASE_VERSION = 1;

function defaultWorkspaceDatabasePath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        APP_ID,
        'workspace.json',
    ]);
}

function writeFileAtomically(path, contents) {
    const directory = GLib.path_get_dirname(path);
    const basename = GLib.path_get_basename(path);
    const tempPath = GLib.build_filenamev([
        directory,
        `.${basename}.${GLib.uuid_string_random()}.tmp`,
    ]);

    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(tempPath, contents);

    try {
        Gio.File.new_for_path(tempPath).move(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null,
        );
    } finally {
        if (GLib.file_test(tempPath, GLib.FileTest.EXISTS))
            GLib.unlink(tempPath);
    }
}

function normalizeArray(value) {
    return Array.isArray(value) ? value.map((item) => ({ ...item })) : [];
}

function normalizeDatabase(value) {
    return {
        prompts: normalizeArray(value?.prompts),
        profiles: normalizeArray(value?.profiles),
        folders: normalizeArray(value?.folders),
        skills: normalizeArray(value?.skills),
        pluginTools: normalizeArray(value?.pluginTools),
        mcpServers: normalizeArray(value?.mcpServers),
        cacheEntries: normalizeArray(value?.cacheEntries),
    };
}

export class WorkspaceFileStore {
    constructor(options = {}) {
        this.path = options.path ?? defaultWorkspaceDatabasePath();
    }

    load() {
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS))
            return normalizeDatabase({});

        const [, contents] = GLib.file_get_contents(this.path);
        return normalizeDatabase(JSON.parse(new TextDecoder().decode(contents)));
    }

    save(database) {
        const normalized = normalizeDatabase(database);
        const payload = JSON.stringify({
            version: DATABASE_VERSION,
            ...normalized,
        }, null, 2);

        writeFileAtomically(this.path, `${payload}\n`);
    }
}
