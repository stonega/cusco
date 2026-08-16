import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const APP_ID = 'io.github.stonega.Cusco';
const AUDIT_VERSION = 1;
const MAX_AUDIT_RECORDS = 200;

function defaultAuditPath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        APP_ID,
        'hook-audit.json',
    ]);
}
function writeFileAtomically(path, contents) {
    const directory = GLib.path_get_dirname(path);
    const basename = GLib.path_get_basename(path);
    const temporaryPath = GLib.build_filenamev([
        directory,
        `.${basename}.${GLib.uuid_string_random()}.tmp`,
    ]);

    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error(`Could not create hook audit directory: ${directory}`);
    GLib.chmod(directory, 0o700);
    GLib.file_set_contents(temporaryPath, contents);

    try {
        GLib.chmod(temporaryPath, 0o600);
        Gio.File.new_for_path(temporaryPath).move(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null,
        );
        GLib.chmod(path, 0o600);
    } finally {
        if (GLib.file_test(temporaryPath, GLib.FileTest.EXISTS))
            GLib.unlink(temporaryPath);
    }
}

function normalizeRecord(record) {
    return {
        fingerprint: String(record?.fingerprint ?? ''),
        eventName: String(record?.eventName ?? ''),
        sourcePath: String(record?.sourcePath ?? ''),
        exitStatus: Number.isFinite(record?.exitStatus) ? record.exitStatus : 1,
        timedOut: Boolean(record?.timedOut),
        cancelled: Boolean(record?.cancelled),
        durationMs: Math.max(0, Number(record?.durationMs) || 0),
        finishedAt: String(record?.finishedAt ?? ''),
        error: String(record?.error ?? '').slice(0, 500),
    };
}

export class HookAuditStore {
    constructor(options = {}) {
        this.path = options.path ?? defaultAuditPath();
        this._records = this._load();
    }

    record(value) {
        const record = normalizeRecord(value);

        if (!record.fingerprint || !record.eventName)
            return null;

        this._records.unshift(record);
        this._records.splice(MAX_AUDIT_RECORDS);
        this._persist();
        return { ...record };
    }

    latest(fingerprint) {
        const record = this._records.find((item) => item.fingerprint === fingerprint);
        return record ? { ...record } : null;
    }

    get records() {
        return this._records.map((record) => ({ ...record }));
    }

    _load() {
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS))
            return [];

        try {
            const [, bytes] = GLib.file_get_contents(this.path);
            const parsed = JSON.parse(new TextDecoder().decode(bytes));

            if (parsed?.version !== AUDIT_VERSION || !Array.isArray(parsed.records))
                return [];

            return parsed.records.slice(0, MAX_AUDIT_RECORDS).map(normalizeRecord);
        } catch (error) {
            logError(error, 'Failed to load hook audit records');
            return [];
        }
    }

    _persist() {
        try {
            writeFileAtomically(this.path, `${JSON.stringify({
                version: AUDIT_VERSION,
                records: this._records,
            }, null, 2)}\n`);
        } catch (error) {
            logError(error, 'Failed to persist hook audit records');
        }
    }
}
