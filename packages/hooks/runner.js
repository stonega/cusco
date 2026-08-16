import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const MAX_CAPTURED_OUTPUT_CHARS = 1024 * 1024;
const INLINE_OUTPUT_CHARS = 10000;

function shellProgram() {
    const shell = GLib.find_program_in_path('bash') ?? GLib.find_program_in_path('sh');

    if (!shell)
        throw new Error('No supported command shell was found in PATH.');

    return shell;
}

function boundedOutput(value) {
    const text = String(value ?? '');

    if (text.length <= MAX_CAPTURED_OUTPUT_CHARS)
        return { text, truncated: false };

    return {
        text: `${text.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n[Hook output truncated by Cusco]`,
        truncated: true,
    };
}

function writeOversizedOutput(value, sessionId) {
    const text = String(value ?? '');

    if (text.length <= INLINE_OUTPUT_CHARS)
        return '';

    const safeSessionId = String(sessionId ?? 'session').replaceAll(/[^A-Za-z0-9_.-]/g, '_');
    const directory = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        'cusco-hook-outputs',
        safeSessionId,
    ]);
    const path = GLib.build_filenamev([
        directory,
        `${GLib.uuid_string_random()}.txt`,
    ]);

    try {
        if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
            return '';
        GLib.chmod(directory, 0o700);
        GLib.file_set_contents(path, text.slice(0, MAX_CAPTURED_OUTPUT_CHARS));
        GLib.chmod(path, 0o600);
        return path;
    } catch (error) {
        logError(error, 'Failed to store oversized hook output');
        return '';
    }
}

export function runHookCommand(definition, input, options = {}) {
    return new Promise((resolve) => {
        let subprocess;
        let timeoutId = 0;
        let cancelHandlerId = 0;
        let timedOut = false;
        let cancelled = Boolean(options.cancellable?.is_cancelled?.());
        const startedAt = GLib.get_monotonic_time();

        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE
                    | Gio.SubprocessFlags.STDOUT_PIPE
                    | Gio.SubprocessFlags.STDERR_PIPE,
            });
            const cwd = String(options.cwd ?? '').trim();

            if (cwd && GLib.file_test(cwd, GLib.FileTest.IS_DIR))
                launcher.set_cwd(cwd);

            subprocess = launcher.spawnv([
                shellProgram(),
                '-lc',
                definition.command,
            ]);
        } catch (error) {
            resolve({
                exitStatus: 1,
                stdout: '',
                stderr: error.message,
                timedOut: false,
                cancelled,
                durationMs: 0,
                failedToStart: true,
            });
            return;
        }

        const stopProcess = () => {
            try {
                subprocess.force_exit();
            } catch (_error) {
                // The process may already have exited.
            }
        };

        if (options.cancellable) {
            if (cancelled) {
                stopProcess();
            } else {
                cancelHandlerId = options.cancellable.connect(() => {
                    cancelled = true;
                    stopProcess();
                });
            }
        }

        timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            definition.timeout,
            () => {
                timedOut = true;
                timeoutId = 0;
                stopProcess();
                return GLib.SOURCE_REMOVE;
            },
        );

        const stdin = `${JSON.stringify(input)}\n`;
        subprocess.communicate_utf8_async(stdin, null, (_process, result) => {
            let stdout = '';
            let stderr = '';
            let communicationError = null;

            try {
                [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
            } catch (error) {
                communicationError = error;
            }

            if (timeoutId)
                GLib.source_remove(timeoutId);
            if (cancelHandlerId)
                options.cancellable.disconnect(cancelHandlerId);

            const stdoutPath = writeOversizedOutput(stdout, input.session_id);
            const boundedStdout = boundedOutput(stdout);
            const boundedStderr = boundedOutput(stderr);
            resolve({
                exitStatus: subprocess.get_if_exited()
                    ? subprocess.get_exit_status()
                    : timedOut ? 124 : cancelled ? 130 : 1,
                stdout: boundedStdout.text,
                stderr: communicationError?.message
                    ? [boundedStderr.text, communicationError.message].filter(Boolean).join('\n')
                    : boundedStderr.text,
                stdoutTruncated: boundedStdout.truncated,
                stdoutPath,
                stderrTruncated: boundedStderr.truncated,
                timedOut,
                cancelled,
                durationMs: Math.max(
                    0,
                    Math.round((GLib.get_monotonic_time() - startedAt) / 1000),
                ),
                failedToStart: false,
            });
        });
    });
}
