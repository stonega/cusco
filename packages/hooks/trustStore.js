import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const APP_ID = 'io.github.stonega.Cusco';
const TRUST_STORE_VERSION = 1;

function defaultTrustStorePath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        APP_ID,
        'hook-state.json',
    ]);
}

function normalizeFingerprints(value) {
    return Array.isArray(value)
        ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
        : [];
}

function writeFileAtomically(path, contents) {
    const directory = GLib.path_get_dirname(path);
    const basename = GLib.path_get_basename(path);
    const temporaryPath = GLib.build_filenamev([
        directory,
        `.${basename}.${GLib.uuid_string_random()}.tmp`,
    ]);

    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error(`Could not create hook state directory: ${directory}`);
    GLib.chmod(directory, 0o700);
    GLib.file_set_contents(temporaryPath, contents);

    try {
        if (GLib.chmod(temporaryPath, 0o600) !== 0)
            throw new Error(`Could not secure hook state: ${temporaryPath}`);

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

export class HookTrustStore {
    constructor(options = {}) {
        this.path = options.path ?? defaultTrustStorePath();
        const stored = this._load();
        this._trusted = new Set(stored.trusted);
        this._disabled = new Set(stored.disabled);
    }

    isTrusted(fingerprint) {
        return this._trusted.has(String(fingerprint ?? ''));
    }

    isDisabled(fingerprint) {
        return this._disabled.has(String(fingerprint ?? ''));
    }

    trust(fingerprint) {
        const value = String(fingerprint ?? '').trim();

        if (!value)
            return false;

        const changed = !this._trusted.has(value);
        this._trusted.add(value);

        if (changed)
            this._persist();

        return changed;
    }

    revoke(fingerprint) {
        const changed = this._trusted.delete(String(fingerprint ?? ''));

        if (changed)
            this._persist();

        return changed;
    }

    setDisabled(fingerprint, disabled) {
        const value = String(fingerprint ?? '').trim();

        if (!value)
            return false;

        const changed = disabled
            ? !this._disabled.has(value)
            : this._disabled.has(value);

        if (disabled)
            this._disabled.add(value);
        else
            this._disabled.delete(value);

        if (changed)
            this._persist();

        return changed;
    }

    _load() {
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS))
            return { trusted: [], disabled: [] };

        try {
            const [, bytes] = GLib.file_get_contents(this.path);
            const parsed = JSON.parse(new TextDecoder().decode(bytes));

            if (parsed?.version !== TRUST_STORE_VERSION)
                return { trusted: [], disabled: [] };

            return {
                trusted: normalizeFingerprints(parsed.trusted),
                disabled: normalizeFingerprints(parsed.disabled),
            };
        } catch (error) {
            logError(error, 'Failed to load hook trust state');
            return { trusted: [], disabled: [] };
        }
    }

    _persist() {
        const payload = JSON.stringify({
            version: TRUST_STORE_VERSION,
            trusted: [...this._trusted].sort(),
            disabled: [...this._disabled].sort(),
        }, null, 2);
        writeFileAtomically(this.path, `${payload}\n`);
    }
}
