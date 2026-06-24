import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { TOOL_PERMISSION_ASK } from '../tools/permissions.js';

const APP_ID = 'io.github.stonega.Cusco';
const CRONTAB_BEGIN = '# CUSCO_CRON_BEGIN';
const CRONTAB_META_PREFIX = '# CUSCO_CRON_META ';
const CRONTAB_END = '# CUSCO_CRON_END';
const CRONTAB_DISABLED_PREFIX = '# CUSCO_CRON_DISABLED ';
const RUN_BEGIN_PREFIX = 'CUSCO_RUN_BEGIN ';
const RUN_END = 'CUSCO_RUN_END';
const STDOUT_BEGIN = 'stdout<<CUSCO_STDOUT';
const STDOUT_END = 'CUSCO_STDOUT';
const STDERR_BEGIN = 'stderr<<CUSCO_STDERR';
const STDERR_END = 'CUSCO_STDERR';

function now() {
    return new Date().toISOString();
}

function userVisibleError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
}

function splitLines(contents) {
    const source = String(contents ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (!source)
        return [];

    const lines = source.split('\n');

    if (lines[lines.length - 1] === '')
        lines.pop();

    return lines;
}

function normalizeTitle(value, fallbackCommand = '') {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();

    return normalized || String(fallbackCommand ?? '').trim().slice(0, 48) || 'Cron job';
}

function normalizeSchedule(value) {
    const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
    const fields = normalized ? normalized.split(' ') : [];

    if (fields.length !== 5)
        throw userVisibleError('Cron schedule must have exactly 5 fields.');

    if (fields.some((field) => !field || /[\r\n]/.test(field)))
        throw userVisibleError('Cron schedule fields cannot be empty or multiline.');

    return normalized;
}

function normalizeCommand(value) {
    const command = String(value ?? '').trim();

    if (!command)
        throw userVisibleError('Cron command cannot be empty.');

    if (/[\r\n]/.test(command))
        throw userVisibleError('Cron command must be a single line.');

    if (command.includes('\0'))
        throw userVisibleError('Cron command cannot contain NUL bytes.');

    return command;
}

function normalizeOptionalString(value) {
    return String(value ?? '').trim();
}

function defaultCronLogDirectory() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        APP_ID,
        'cron-logs',
    ]);
}

function shellQuote(value) {
    return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;
}

function cronLogPath(jobId, logDirectory = defaultCronLogDirectory()) {
    return GLib.build_filenamev([logDirectory, `${jobId}.log`]);
}

function buildCronCommand(job, { logDirectory = defaultCronLogDirectory() } = {}) {
    const logPath = cronLogPath(job.id, logDirectory);
    const appendLog = [
        'printf "%s\\n" "CUSCO_RUN_BEGIN $run_id"',
        `printf "%s\\n" ${shellQuote(`jobId=${job.id}`)}`,
        'printf "%s\\n" "startedAt=$started_at"',
        'printf "%s\\n" "finishedAt=$finished_at"',
        'printf "%s\\n" "exitStatus=$status"',
        `printf "%s\\n" ${shellQuote(STDOUT_BEGIN)}`,
        'cat "$out"',
        `printf "\\n%s\\n" ${shellQuote(STDOUT_END)}`,
        `printf "%s\\n" ${shellQuote(STDERR_BEGIN)}`,
        'cat "$err"',
        `printf "\\n%s\\n" ${shellQuote(STDERR_END)}`,
        `printf "%s\\n" ${shellQuote(RUN_END)}`,
    ].join('; ');
    const script = [
        `log_dir=${shellQuote(logDirectory)}`,
        `log_path=${shellQuote(logPath)}`,
        'mkdir -p "$log_dir"',
        'out="$(mktemp "${TMPDIR:-/tmp}/cusco-cron-out.XXXXXX")" || exit 1',
        'err="$(mktemp "${TMPDIR:-/tmp}/cusco-cron-err.XXXXXX")" || exit 1',
        'run_id="$(date +%s)-$$"',
        'started_at="$(date -Is)"',
        `/bin/sh -lc ${shellQuote(job.command)} >"$out" 2>"$err"`,
        'status=$?',
        'finished_at="$(date -Is)"',
        `{ ${appendLog}; } >> "$log_path"`,
        'rm -f "$out" "$err"',
        'exit "$status"',
    ].join('; ');

    return `/bin/sh -c ${shellQuote(script)}`;
}

function splitCronLine(line) {
    const parts = String(line ?? '').trim().split(/\s+/);

    if (parts.length < 6)
        throw userVisibleError('Cusco cron block is missing a command.');

    return {
        schedule: normalizeSchedule(parts.slice(0, 5).join(' ')),
        command: normalizeCommand(parts.slice(5).join(' ')),
    };
}

function normalizeJobInput(input = {}, existing = null) {
    const command = normalizeCommand(input.command ?? existing?.command);
    const schedule = normalizeSchedule(input.schedule ?? existing?.schedule);
    const id = (existing?.id ?? String(input.id ?? '').trim()) || GLib.uuid_string_random();

    return {
        id,
        title: normalizeTitle(input.title ?? existing?.title, command),
        schedule,
        command,
        enabled: input.enabled === undefined ? existing?.enabled !== false : Boolean(input.enabled),
        conversationId: normalizeOptionalString(input.conversationId ?? existing?.conversationId),
        createdAt: existing?.createdAt ?? input.createdAt ?? now(),
        updatedAt: input.updatedAt ?? now(),
    };
}

function parseMetadata(line) {
    if (!line.startsWith(CRONTAB_META_PREFIX))
        return null;

    try {
        const parsed = JSON.parse(line.slice(CRONTAB_META_PREFIX.length));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
        return null;
    }
}

function parseBlock(lines) {
    const meta = lines.map(parseMetadata).find((item) => item) ?? {};
    let cronLine = '';
    let enabled = meta.enabled !== false;

    for (const line of lines) {
        if (line.startsWith(CRONTAB_DISABLED_PREFIX)) {
            cronLine = line.slice(CRONTAB_DISABLED_PREFIX.length);
            enabled = false;
            break;
        }

        const trimmed = line.trim();

        if (!trimmed
            || trimmed === CRONTAB_BEGIN
            || trimmed === CRONTAB_END
            || line.startsWith(CRONTAB_META_PREFIX)
            || trimmed.startsWith('#')) {
            continue;
        }

        cronLine = line;
        enabled = true;
        break;
    }

    if (!meta.id || (!cronLine && (!meta.schedule || !meta.command)))
        return null;

    const parsedLine = cronLine ? splitCronLine(cronLine) : {};
    const schedule = meta.schedule ? normalizeSchedule(meta.schedule) : parsedLine.schedule;
    const command = meta.command ? normalizeCommand(meta.command) : parsedLine.command;

    return normalizeJobInput({
        id: meta.id,
        title: meta.title,
        schedule,
        command,
        enabled,
        conversationId: meta.conversationId,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
    });
}

export function parseCronCreateInput(input) {
    let parsed;

    try {
        parsed = JSON.parse(String(input ?? '').trim());
    } catch (error) {
        throw userVisibleError(`Cron job input must be JSON: ${error.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw userVisibleError('Cron job input must be a JSON object.');

    return normalizeJobInput(parsed);
}

export function normalizeCronJobInput(input) {
    return normalizeJobInput(input);
}

export function parseCuscoCrontab(contents) {
    const lines = splitLines(contents);
    const segments = [];
    const jobs = [];
    let index = 0;

    while (index < lines.length) {
        if (lines[index].trim() === CRONTAB_BEGIN) {
            const block = [];
            let hasEnd = false;

            while (index < lines.length) {
                block.push(lines[index]);

                if (lines[index].trim() === CRONTAB_END) {
                    hasEnd = true;
                    index++;
                    break;
                }

                index++;
            }

            if (!hasEnd) {
                segments.push({ type: 'raw', lines: block });
                continue;
            }

            try {
                const job = parseBlock(block);

                if (job) {
                    segments.push({ type: 'job', lines: block, job });
                    jobs.push(job);
                } else {
                    segments.push({ type: 'raw', lines: block });
                }
            } catch (error) {
                segments.push({ type: 'raw', lines: block, error });
            }

            continue;
        }

        const raw = [];

        while (index < lines.length && lines[index].trim() !== CRONTAB_BEGIN) {
            raw.push(lines[index]);
            index++;
        }

        segments.push({ type: 'raw', lines: raw });
    }

    return { segments, jobs };
}

export function serializeCronJob(job, options = {}) {
    const normalized = normalizeJobInput(job);
    const metadata = JSON.stringify({
        id: normalized.id,
        title: normalized.title,
        schedule: normalized.schedule,
        command: normalized.command,
        enabled: normalized.enabled,
        conversationId: normalized.conversationId,
        createdAt: normalized.createdAt,
        updatedAt: normalized.updatedAt,
    });
    const cronLine = `${normalized.schedule} ${buildCronCommand(normalized, options)}`;

    return [
        CRONTAB_BEGIN,
        `${CRONTAB_META_PREFIX}${metadata}`,
        normalized.enabled ? cronLine : `${CRONTAB_DISABLED_PREFIX}${cronLine}`,
        CRONTAB_END,
    ];
}

function serializeSegments(segments) {
    const lines = segments.flatMap((segment) => segment.lines ?? []);
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function readUntilMarker(lines, index, marker) {
    const collected = [];
    let cursor = index;

    while (cursor < lines.length && lines[cursor] !== marker) {
        collected.push(lines[cursor]);
        cursor++;
    }

    if (cursor < lines.length && lines[cursor] === marker)
        cursor++;

    return {
        text: collected.join('\n').replace(/\n$/, ''),
        index: cursor,
    };
}

export function parseCronRunLog(contents) {
    const lines = splitLines(contents);
    const runs = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];

        if (!line.startsWith(RUN_BEGIN_PREFIX)) {
            index++;
            continue;
        }

        const run = {
            runId: normalizeOptionalString(line.slice(RUN_BEGIN_PREFIX.length)),
            jobId: '',
            startedAt: '',
            finishedAt: '',
            exitStatus: null,
            stdout: '',
            stderr: '',
        };
        index++;

        while (index < lines.length && lines[index] !== RUN_END) {
            const current = lines[index];

            if (current === STDOUT_BEGIN) {
                const result = readUntilMarker(lines, index + 1, STDOUT_END);
                run.stdout = result.text;
                index = result.index;
                continue;
            }

            if (current === STDERR_BEGIN) {
                const result = readUntilMarker(lines, index + 1, STDERR_END);
                run.stderr = result.text;
                index = result.index;
                continue;
            }

            const separator = current.indexOf('=');

            if (separator > 0) {
                const key = current.slice(0, separator);
                const value = current.slice(separator + 1);

                if (key === 'jobId')
                    run.jobId = value;
                else if (key === 'startedAt')
                    run.startedAt = value;
                else if (key === 'finishedAt')
                    run.finishedAt = value;
                else if (key === 'exitStatus')
                    run.exitStatus = Number.parseInt(value, 10);
            }

            index++;
        }

        if (index < lines.length && lines[index] === RUN_END)
            index++;

        if (run.runId && run.jobId)
            runs.push(run);
    }

    return runs;
}

function noCrontabMessage(text) {
    return /no crontab for/i.test(text);
}

function crontabAccessMessage(action, result) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
        || `exit status ${result.exitStatus}`;
    return `Unable to ${action} user crontab: ${details}`;
}

function runProcess(argv, stdin = null) {
    return new Promise((resolve, reject) => {
        let subprocess;

        try {
            subprocess = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDIN_PIPE
                    | Gio.SubprocessFlags.STDOUT_PIPE
                    | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (error) {
            reject(error);
            return;
        }

        subprocess.communicate_utf8_async(stdin, null, (_process, result) => {
            try {
                const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                resolve({
                    exitStatus: subprocess.get_if_exited() ? subprocess.get_exit_status() : 1,
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}

export class SystemCrontabBackend {
    constructor({ crontabPath = null } = {}) {
        this._crontabPath = crontabPath ?? GLib.find_program_in_path('crontab');
    }

    _assertAvailable() {
        if (!this._crontabPath)
            throw userVisibleError('crontab was not found in PATH.');
    }

    async read() {
        this._assertAvailable();

        const result = await runProcess([this._crontabPath, '-l']);

        if (result.exitStatus === 0)
            return result.stdout;

        const text = `${result.stderr}\n${result.stdout}`;

        if (noCrontabMessage(text))
            return '';

        throw userVisibleError(crontabAccessMessage('read', result));
    }

    async write(contents) {
        this._assertAvailable();

        const tempPath = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            `cusco-crontab-${GLib.uuid_string_random()}`,
        ]);

        try {
            GLib.file_set_contents(tempPath, String(contents ?? ''));

            if (typeof GLib.chmod === 'function')
                GLib.chmod(tempPath, 0o600);

            const result = await runProcess([this._crontabPath, tempPath]);

            if (result.exitStatus !== 0)
                throw userVisibleError(crontabAccessMessage('install', result));
        } finally {
            if (GLib.file_test(tempPath, GLib.FileTest.EXISTS))
                GLib.unlink(tempPath);
        }
    }
}

export class CronJobManager {
    constructor({ backend = null, logDirectory = null } = {}) {
        this._backend = backend ?? new SystemCrontabBackend();
        this._logDirectory = logDirectory ?? defaultCronLogDirectory();
    }

    async _load() {
        const contents = await this._backend.read();
        return parseCuscoCrontab(contents);
    }

    async _save(segments) {
        await this._backend.write(serializeSegments(segments));
    }

    async listJobs() {
        const parsed = await this._load();
        return parsed.jobs.map((job) => ({ ...job }));
    }

    async getStatus() {
        try {
            const jobs = await this.listJobs();
            return {
                available: true,
                error: '',
                jobs,
            };
        } catch (error) {
            return {
                available: false,
                error: error.userMessage ?? error.message,
                jobs: [],
            };
        }
    }

    async createJob(input) {
        const parsed = await this._load();
        const job = normalizeJobInput(input);

        parsed.segments.push({ type: 'job', job, lines: serializeCronJob(job, { logDirectory: this._logDirectory }) });
        await this._save(parsed.segments);
        return { ...job };
    }

    async updateJob(jobId, updates = {}) {
        const parsed = await this._load();
        const segment = parsed.segments.find((item) => item.type === 'job' && item.job.id === jobId);

        if (!segment)
            throw userVisibleError(`Cron job does not exist: ${jobId}`);

        const job = normalizeJobInput({
            ...segment.job,
            ...updates,
            id: segment.job.id,
            createdAt: segment.job.createdAt,
            updatedAt: now(),
        }, segment.job);

        segment.job = job;
        segment.lines = serializeCronJob(job, { logDirectory: this._logDirectory });
        await this._save(parsed.segments);
        return { ...job };
    }

    async setJobEnabled(jobId, enabled) {
        return this.updateJob(jobId, { enabled: Boolean(enabled) });
    }

    getLogPath(jobId) {
        return cronLogPath(jobId, this._logDirectory);
    }

    readRunLogs(jobOrId) {
        const jobId = typeof jobOrId === 'string' ? jobOrId : jobOrId?.id;

        if (!jobId)
            return [];

        const path = this.getLogPath(jobId);

        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return [];

        const [, contents] = GLib.file_get_contents(path);
        return parseCronRunLog(new TextDecoder().decode(contents))
            .filter((run) => run.jobId === jobId);
    }

    async deleteJob(jobId) {
        const parsed = await this._load();
        const index = parsed.segments.findIndex((item) => item.type === 'job' && item.job.id === jobId);

        if (index < 0)
            throw userVisibleError(`Cron job does not exist: ${jobId}`);

        const [segment] = parsed.segments.splice(index, 1);
        await this._save(parsed.segments);
        return { ...segment.job };
    }
}

export function formatCronJobForTranscript(job) {
    return [
        'Cron job created',
        `Title: ${job.title}`,
        `Schedule: ${job.schedule}`,
        `Status: ${job.enabled ? 'Enabled' : 'Disabled'}`,
        'Command:',
        '```sh',
        job.command,
        '```',
    ].join('\n');
}

export function createCronCreateTool(cronManager, options = {}) {
    return {
        name: 'cron_create',
        label: 'Cron Job',
        description: 'Create a current-user crontab entry managed by Cusco.',
        inputDescription: 'JSON object: {"title":"Daily sync","schedule":"0 9 * * *","command":"/path/to/script","enabled":true}',
        permissionPolicy: TOOL_PERMISSION_ASK,
        requiresPermission: true,
        concurrencySafe: false,
        run: async (input) => {
            const parsedInput = parseCronCreateInput(input);
            const job = await cronManager.createJob(parsedInput);
            await options.onJobCreated?.(job);
            return formatCronJobForTranscript(job);
        },
    };
}
