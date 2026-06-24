import {
    createCronCreateTool,
    CronJobManager,
    parseCronCreateInput,
    parseCronRunLog,
    parseCuscoCrontab,
    serializeCronJob,
} from '../src/cron/manager.js';
import { ToolManager } from '../src/tools/tools.js';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

class FakeCrontabBackend {
    constructor(contents = '') {
        this.contents = contents;
        this.writes = [];
        this.readError = null;
        this.writeError = null;
    }

    async read() {
        if (this.readError)
            throw this.readError;

        return this.contents;
    }

    async write(contents) {
        if (this.writeError)
            throw this.writeError;

        this.contents = contents;
        this.writes.push(contents);
    }
}

function runShell(command) {
    return new Promise((resolve, reject) => {
        const subprocess = Gio.Subprocess.new(
            ['/bin/sh', '-c', command],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
        subprocess.communicate_utf8_async(null, null, (_process, result) => {
            try {
                const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                resolve({
                    exitStatus: subprocess.get_if_exited() ? subprocess.get_exit_status() : 1,
                    stdout,
                    stderr,
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}

const unmanagedCrontab = [
    'MAILTO=stone@example.com',
    '# existing user job',
    '15 4 * * * echo external',
    '',
].join('\n');
const backend = new FakeCrontabBackend(unmanagedCrontab);
const logDirectory = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-cron-logs-${GLib.uuid_string_random()}`,
]);
const manager = new CronJobManager({ backend, logDirectory });

const firstJob = await manager.createJob({
    title: 'Daily sync',
    schedule: '0 9 * * *',
    command: '/usr/bin/printf cusco',
});

if (!firstJob.id || firstJob.title !== 'Daily sync')
    throw new Error('Cron job was not created with an id and title');

if (!backend.contents.includes('MAILTO=stone@example.com') || !backend.contents.includes('15 4 * * * echo external'))
    throw new Error('Unmanaged crontab lines were not preserved');

if (!backend.contents.includes('# CUSCO_CRON_BEGIN')
    || !backend.contents.includes('"command":"/usr/bin/printf cusco"')
    || !backend.contents.includes('0 9 * * * /bin/sh -c')
    || !backend.contents.includes('CUSCO_RUN_BEGIN')) {
    throw new Error('Cusco cron block was not serialized');
}

let jobs = await manager.listJobs();

if (jobs.length !== 1 || jobs[0].command !== '/usr/bin/printf cusco')
    throw new Error('Cusco cron job was not parsed back from crontab');

await manager.setJobEnabled(firstJob.id, false);
jobs = await manager.listJobs();

if (jobs[0].enabled !== false || !backend.contents.includes('# CUSCO_CRON_DISABLED 0 9 * * * /bin/sh -c'))
    throw new Error('Cron job was not disabled reversibly');

await manager.updateJob(firstJob.id, {
    title: 'Hourly sync',
    schedule: '5 * * * *',
    command: '/usr/bin/printf updated',
    enabled: true,
});
jobs = await manager.listJobs();

if (jobs[0].title !== 'Hourly sync'
    || jobs[0].schedule !== '5 * * * *'
    || jobs[0].command !== '/usr/bin/printf updated'
    || jobs[0].enabled !== true
    || backend.contents.includes('CUSCO_CRON_DISABLED')) {
    throw new Error('Cron job update did not persist expected fields');
}

const parsed = parseCuscoCrontab(backend.contents);

if (parsed.jobs.length !== 1 || parsed.segments.filter((segment) => segment.type === 'raw').length === 0)
    throw new Error('Crontab parser did not return jobs and raw segments');

const logPath = manager.getLogPath(firstJob.id);
GLib.mkdir_with_parents(logDirectory, 0o700);
GLib.file_set_contents(logPath, [
    'CUSCO_RUN_BEGIN run-1',
    `jobId=${firstJob.id}`,
    'startedAt=2026-06-23T10:00:00+00:00',
    'finishedAt=2026-06-23T10:00:01+00:00',
    'exitStatus=7',
    'stdout<<CUSCO_STDOUT',
    'hello from cron',
    'CUSCO_STDOUT',
    'stderr<<CUSCO_STDERR',
    'warning from cron',
    'CUSCO_STDERR',
    'CUSCO_RUN_END',
    '',
].join('\n'));

const parsedLog = parseCronRunLog(new TextDecoder().decode(GLib.file_get_contents(logPath)[1]));

if (parsedLog.length !== 1 || parsedLog[0].stdout !== 'hello from cron')
    throw new Error('Cron run log parser did not parse stdout');

const runLogs = manager.readRunLogs(firstJob.id);

if (runLogs.length !== 1 || runLogs[0].exitStatus !== 7 || !runLogs[0].stderr.includes('warning'))
    throw new Error('Cron run logs were not read through the manager');

const wrapperJob = {
    id: 'wrapper-job',
    title: 'Wrapper job',
    schedule: '0 1 * * *',
    command: 'printf wrapper-stdout; printf wrapper-stderr >&2; exit 3',
};
const wrapperLine = serializeCronJob(wrapperJob, { logDirectory }).find((line) => !line.startsWith('#'));
const wrapperCommand = wrapperLine.replace(/^(?:\S+\s+){5}/, '');
const wrapperResult = await runShell(wrapperCommand);

if (wrapperResult.exitStatus !== 3)
    throw new Error(`Cron wrapper did not preserve exit status: ${wrapperResult.exitStatus}`);

const wrapperLogs = manager.readRunLogs(wrapperJob.id);

if (wrapperLogs.length !== 1
    || !wrapperLogs[0].stdout.includes('wrapper-stdout')
    || !wrapperLogs[0].stderr.includes('wrapper-stderr')) {
    throw new Error('Cron wrapper did not write stdout/stderr to the run log');
}

const cronTool = createCronCreateTool(manager);
const toolResult = await cronTool.run(JSON.stringify({
    title: 'Tool job',
    schedule: '30 10 * * 1',
    command: '/usr/bin/true',
}));

if (!toolResult.includes('Cron job created') || !toolResult.includes('Tool job'))
    throw new Error('Cron create tool did not return a transcript result');

jobs = await manager.listJobs();

if (jobs.length !== 2 || !jobs.find((job) => job.title === 'Tool job'))
    throw new Error('Cron create tool did not install a job');

const toolManager = new ToolManager();
toolManager.registerTool(createCronCreateTool(manager));
const parsedToolRequest = toolManager.parseRequest('/cron_create {"title":"Slash job","schedule":"45 8 * * *","command":"/usr/bin/false"}');

if (!parsedToolRequest || parsedToolRequest.name !== 'cron_create' || !parsedToolRequest.requiresPermission)
    throw new Error('Cron create slash command was not parsed as a permissioned registered tool');

const slashToolResult = await toolManager.runRequest(parsedToolRequest);

if (!slashToolResult.output.includes('Slash job'))
    throw new Error('Cron create slash command did not install a job through ToolManager');

jobs = await manager.listJobs();

if (jobs.length !== 3 || !jobs.find((job) => job.title === 'Slash job'))
    throw new Error('Cron create slash command did not persist a job');

await manager.deleteJob(firstJob.id);
jobs = await manager.listJobs();

if (jobs.length !== 2 || !jobs.find((job) => job.title === 'Tool job'))
    throw new Error('Cron job delete did not remove the requested job');

if (!backend.contents.includes('MAILTO=stone@example.com') || !backend.contents.includes('15 4 * * * echo external'))
    throw new Error('Cron job delete removed unmanaged crontab lines');

for (const badInput of [
    { schedule: '@daily', command: '/usr/bin/true' },
    { schedule: '* * * * *', command: 'printf one\nprintf two' },
]) {
    let failed = false;

    try {
        parseCronCreateInput(JSON.stringify(badInput));
    } catch (error) {
        failed = Boolean(error.userMessage);
    }

    if (!failed)
        throw new Error(`Invalid cron input was accepted: ${JSON.stringify(badInput)}`);
}

const failingBackend = new FakeCrontabBackend();
const accessError = new Error('blocked by PAM');
accessError.userMessage = 'Unable to read user crontab: blocked by PAM';
failingBackend.readError = accessError;

const status = await new CronJobManager({ backend: failingBackend }).getStatus();

if (status.available || !status.error.includes('blocked by PAM'))
    throw new Error('Cron backend read failure was not surfaced in status');

print('Cusco cron smoke passed');
