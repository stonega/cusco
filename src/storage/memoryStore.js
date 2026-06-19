import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const APP_ID = 'io.github.stonega.Cusco';
const DATABASE_VERSION = 1;

function defaultMemoryDatabasePath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        APP_ID,
        'memories.json',
    ]);
}

function normalizeString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function normalizeMemory(memory) {
    const timestamp = new Date().toISOString();

    return {
        id: normalizeString(memory?.id, GLib.uuid_string_random()),
        content: normalizeString(memory?.content),
        enabled: memory?.enabled !== false,
        pinned: Boolean(memory?.pinned),
        sourceConversationId: normalizeString(memory?.sourceConversationId),
        sourceMessageId: normalizeString(memory?.sourceMessageId),
        createdAt: normalizeString(memory?.createdAt, timestamp),
        updatedAt: normalizeString(memory?.updatedAt, timestamp),
        lastUsedAt: normalizeString(memory?.lastUsedAt),
    };
}

function normalizeUsageLogEntry(entry) {
    return {
        id: normalizeString(entry?.id, GLib.uuid_string_random()),
        memoryId: normalizeString(entry?.memoryId),
        conversationId: normalizeString(entry?.conversationId),
        messageId: normalizeString(entry?.messageId),
        usedAt: normalizeString(entry?.usedAt, new Date().toISOString()),
    };
}

function normalizeDatabase(value) {
    return {
        memories: Array.isArray(value?.memories)
            ? value.memories.map(normalizeMemory).filter((memory) => memory.content)
            : [],
        usageLog: Array.isArray(value?.usageLog)
            ? value.usageLog.map(normalizeUsageLogEntry).filter((entry) => entry.memoryId)
            : [],
    };
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

export class MemoryFileStore {
    constructor(options = {}) {
        this.path = options.path ?? defaultMemoryDatabasePath();
    }

    load() {
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS))
            return { memories: [], usageLog: [] };

        const [, contents] = GLib.file_get_contents(this.path);
        const decoded = new TextDecoder().decode(contents);
        const parsed = JSON.parse(decoded);

        return normalizeDatabase(parsed);
    }

    save(database) {
        const normalized = normalizeDatabase(database);
        const payload = JSON.stringify({
            version: DATABASE_VERSION,
            memories: normalized.memories,
            usageLog: normalized.usageLog,
        }, null, 2);

        writeFileAtomically(this.path, `${payload}\n`);
    }
}
