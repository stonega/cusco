import {
    buildAutomationCommand,
    createAutomationCreateTool,
    createAutomationTools,
    CronJobManager,
    parseAutomationCreateInput,
    parseCronCreateInput,
    parseCronRunLog,
    parseCuscoCrontab,
    serializeCronJob,
} from '../src/cron/manager.js';
import { ToolManager } from '../src/tools/tools.js';
import { buildAgentModeSystemPrompt } from '../src/chat/agentMode.js';
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

const automationCommand = buildAutomationCommand('automation-123', {
    executablePath: '/usr/bin/cusco',
    systemdRunPath: '',
});

if (automationCommand !== "'/usr/bin/cusco' --run-automation 'automation-123'")
    throw new Error('Automation command did not target the Cusco automation entry point');

const sessionAutomationCommand = buildAutomationCommand('automation-456', {
    executablePath: '/usr/bin/cusco',
    systemdRunPath: '/usr/bin/systemd-run',
    runtimeDirectory: '/run/user/1000',
});

if (!sessionAutomationCommand.includes("XDG_RUNTIME_DIR='/run/user/1000'")
    || !sessionAutomationCommand.includes("DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1000/bus'")
    || !sessionAutomationCommand.includes("'/usr/bin/systemd-run' --user --collect --quiet")) {
    throw new Error('Automation command did not enter the GNOME user session');
}

const legacyJob = {
    id: 'legacy-percent-job',
    title: 'Legacy percent job',
    schedule: '* * * * *',
    command: 'printf "%s" "100%"',
};
const legacyBackend = new FakeCrontabBackend(
    `${serializeCronJob(legacyJob, { logDirectory }).join('\n').replace(/\\%/g, '%')}\n`,
);
const legacyManager = new CronJobManager({ backend: legacyBackend, logDirectory });

await legacyManager.listJobs();
const repairedLegacyLine = legacyBackend.contents
    .split('\n')
    .find((line) => line.trim() && !line.startsWith('#'));

if (legacyBackend.writes.length !== 1
    || repairedLegacyLine.replace(/\\%/g, '').includes('%')) {
    throw new Error('Existing cron jobs with unescaped percent signs were not repaired');
}

await legacyManager.listJobs();

if (legacyBackend.writes.length !== 1)
    throw new Error('Cron percent repair was not idempotent');

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
    command: 'printf "%s" wrapper-stdout; printf "%s" wrapper-stderr >&2; exit 3',
};
const wrapperLine = serializeCronJob(wrapperJob, { logDirectory }).find((line) => !line.startsWith('#'));
const escapedPercentCount = wrapperLine.match(/\\%/g)?.length ?? 0;

if (escapedPercentCount < 3 || wrapperLine.replace(/\\%/g, '').includes('%'))
    throw new Error('Cron wrapper contained an unescaped percent sign');

// Cron removes the escape before passing protected percent signs to the shell.
const wrapperCommand = wrapperLine
    .replace(/^(?:\S+\s+){5}/, '')
    .replace(/\\%/g, '%');
const wrapperResult = await runShell(wrapperCommand);

if (wrapperResult.exitStatus !== 3)
    throw new Error(`Cron wrapper did not preserve exit status: ${wrapperResult.exitStatus}`);

const wrapperLogs = manager.readRunLogs(wrapperJob.id);

if (wrapperLogs.length !== 1
    || !wrapperLogs[0].stdout.includes('wrapper-stdout')
    || !wrapperLogs[0].stderr.includes('wrapper-stderr')) {
    throw new Error('Cron wrapper did not write stdout/stderr to the run log');
}

const automationTool = createAutomationCreateTool(manager);
const toolResult = await automationTool.run(JSON.stringify({
    title: 'Daily briefing',
    schedule: '30 10 * * 1',
    prompt: 'Summarize my priorities for today.',
}));

if (!toolResult.includes('Automation created') || !toolResult.includes('Daily briefing'))
    throw new Error('Automation create tool did not return a transcript result');

jobs = await manager.listJobs();

const briefingJob = jobs.find((job) => job.title === 'Daily briefing');

if (jobs.length !== 2
    || !briefingJob
    || briefingJob.prompt !== 'Summarize my priorities for today.'
    || briefingJob.kind !== 'automation'
    || !briefingJob.command.includes('--run-automation')) {
    throw new Error('Automation create tool did not install a prompt-backed job');
}

const toolManager = new ToolManager();
toolManager.registerTool(createAutomationCreateTool(manager));
const parsedToolRequest = toolManager.parseRequest('/automation_create {"title":"Weekly plan","schedule":"45 8 * * 1","prompt":"Plan the week ahead"}');

if (!parsedToolRequest || parsedToolRequest.name !== 'automation_create' || !parsedToolRequest.requiresPermission)
    throw new Error('Automation slash command was not parsed as a permissioned registered tool');

const slashToolResult = await toolManager.runRequest(parsedToolRequest);

if (!slashToolResult.output.includes('Weekly plan'))
    throw new Error('Automation slash command did not install a job through ToolManager');

jobs = await manager.listJobs();

if (jobs.length !== 3 || !jobs.find((job) => job.title === 'Weekly plan'))
    throw new Error('Automation slash command did not persist a job');

const managementBackend = new FakeCrontabBackend(unmanagedCrontab);
const managementManager = new CronJobManager({ backend: managementBackend, logDirectory });
const legacyCommand = await managementManager.createJob({
    title: 'Legacy command', schedule: '0 1 * * *', command: '/usr/bin/true',
});
const managementTools = new ToolManager();
const changedJobs = [];
const deletedJobs = [];
const runJobs = [];

for (const tool of createAutomationTools(managementManager, {
    onJobChanged: (job) => changedJobs.push(job),
    onJobDeleted: (job) => deletedJobs.push(job),
    runJob: (job, context) => {
        runJobs.push({ job, context });
        return { queued: true, conversationId: job.conversationId };
    },
})) {
    managementTools.registerTool(tool);
}

async function runAutomationTool(name, input = {}, context = {}) {
    return managementTools.runRequest(
        managementTools.createRequest(name, JSON.stringify(input)), context,
    );
}

for (const action of ['create', 'list', 'get', 'update', 'pause', 'resume', 'run', 'delete']) {
    const tool = managementTools.getTool(`automation_${action}`);
    const requiresPermission = !['list', 'get'].includes(action);

    if (!tool || tool.requiresPermission !== requiresPermission
        || tool.permissionPolicy !== (requiresPermission ? 'ask' : 'allow')
        || tool.inputSchema?.additionalProperties !== false) {
        throw new Error(`Automation ${action} did not expose its schema and permission policy`);
    }
}

if (JSON.parse((await runAutomationTool('automation_list')).output).length !== 0)
    throw new Error('Automation listing exposed legacy shell command jobs');

const createdResult = await runAutomationTool('automation_create', {
    title: 'Managed briefing', schedule: '0 9 * * *', prompt: 'Original prompt',
});
const managedJob = changedJobs[0];

if (!managedJob || !createdResult.output.includes(`ID: ${managedJob.id}`))
    throw new Error('Automation creation did not report an actionable ID and synchronize changes');

await managementManager.updateJob(managedJob.id, { conversationId: 'managed-conversation' });
await runAutomationTool('automation_update', { id: managedJob.id, title: 'Renamed briefing', schedule: '0 10 * * *' });
let inspectedJob = JSON.parse((await runAutomationTool('automation_get', { id: managedJob.id })).output);

if (inspectedJob.title !== 'Renamed briefing' || inspectedJob.schedule !== '0 10 * * *'
    || inspectedJob.prompt !== 'Original prompt' || inspectedJob.conversationId !== 'managed-conversation'
    || inspectedJob.createdAt !== managedJob.createdAt || !inspectedJob.enabled
    || Object.hasOwn(inspectedJob, 'command')) {
    throw new Error('Partial automation updates lost preserved fields or exposed launch commands');
}

await runAutomationTool('automation_update', { id: managedJob.id, prompt: 'Updated prompt', enabled: false });
await runAutomationTool('automation_resume', { id: managedJob.id });
inspectedJob = JSON.parse((await runAutomationTool('automation_get', { id: managedJob.id })).output);

if (!inspectedJob.enabled || inspectedJob.prompt !== 'Updated prompt')
    throw new Error('Automation resume did not retain the updated prompt');

await runAutomationTool('automation_pause', { id: managedJob.id });
await runAutomationTool('automation_pause', { id: managedJob.id });
const listedJobs = JSON.parse((await runAutomationTool('automation_list')).output);

if (listedJobs.length !== 1 || listedJobs[0].id !== managedJob.id || listedJobs[0].enabled
    || changedJobs.length !== 6 || !managementBackend.contents.includes('CUSCO_CRON_DISABLED')) {
    throw new Error('Automation pause was not idempotent, persisted, and visible in the list');
}

const runResult = JSON.parse((await runAutomationTool('automation_run', { id: managedJob.id }, {
    conversationId: 'requesting-chat',
})).output);

if (runResult.status !== 'queued' || runResult.conversationId !== 'managed-conversation'
    || runJobs.length !== 1 || runJobs[0].job.enabled
    || runJobs[0].context.conversationId !== 'requesting-chat'
    || (await managementManager.listJobs()).find((job) => job.id === managedJob.id).enabled) {
    throw new Error('Running a paused automation failed to queue or changed its scheduled status');
}

const contentsBeforeInvalidInput = managementBackend.contents;

for (const [action, input] of [
    ['get', {}],
    ['get', { id: 'missing' }],
    ['update', { id: managedJob.id }],
    ['update', { id: managedJob.id, prompt: '' }],
    ['update', { id: managedJob.id, prompt: null }],
    ['update', { id: managedJob.id, schedule: '@daily' }],
    ['update', { id: managedJob.id, enabled: 'false' }],
    ['update', { id: managedJob.id, command: '/usr/bin/false' }],
    ['update', { id: managedJob.id, conversationId: 'other-chat' }],
    ['create', { schedule: '0 9 * * *', prompt: 'Test', enabled: 'false' }],
    ['create', { schedule: '0 9 * * *', prompt: 'Test', executablePath: '/usr/bin/false' }],
    ...['get', 'update', 'pause', 'resume', 'run', 'delete'].map((action) => [
        action, { id: legacyCommand.id, ...(action === 'update' ? { prompt: 'Replacement' } : {}) },
    ]),
    ...['update', 'pause', 'resume', 'run', 'delete'].map((action) => [
        action, { id: 'missing', ...(action === 'update' ? { prompt: 'Replacement' } : {}) },
    ]),
]) {
    let rejected = false;

    try {
        await runAutomationTool(`automation_${action}`, input);
    } catch (error) {
        rejected = Boolean(error.userMessage);
    }

    if (!rejected || managementBackend.contents !== contentsBeforeInvalidInput)
        throw new Error(`Invalid automation ${action} input changed the crontab: ${JSON.stringify(input)}`);
}

for (const badInput of ['[]', 'null', '{invalid']) {
    let rejected = false;

    try {
        await managementTools.runRequest(managementTools.createRequest('automation_list', badInput));
    } catch (error) {
        rejected = Boolean(error.userMessage);
    }

    if (!rejected)
        throw new Error(`Automation tool accepted invalid JSON input: ${badInput}`);
}

managementBackend.writeError = new Error('Simulated crontab write failure');
let writeRejected = false;

try {
    await runAutomationTool('automation_resume', { id: managedJob.id });
} catch (error) {
    writeRejected = error === managementBackend.writeError;
}

if (!writeRejected || changedJobs.length !== 6)
    throw new Error('Failed automation persistence was reported as a successful change');

managementBackend.writeError = null;
const deleteResult = await runAutomationTool('automation_delete', { id: managedJob.id });

if (!deleteResult.output.includes('Automation deleted') || deletedJobs[0]?.id !== managedJob.id
    || JSON.parse((await runAutomationTool('automation_list')).output).length !== 0
    || (await managementManager.listJobs())[0]?.id !== legacyCommand.id
    || !managementBackend.contents.startsWith(unmanagedCrontab)) {
    throw new Error('Automation deletion did not synchronize removal or preserve unrelated jobs');
}

for (const nativeToolCalling of [false, true]) {
    const automationPrompt = buildAgentModeSystemPrompt(managementTools.listTools(), { nativeToolCalling });

    if (!automationPrompt.includes('Use automation_* tools for in-app scheduled AI tasks')
        || !automationPrompt.includes('Do not create a duplicate')
        || !automationPrompt.includes('A queued run is not a completed run')) {
        throw new Error('Agent Mode did not receive automation management guidance');
    }
}

await manager.deleteJob(firstJob.id);
jobs = await manager.listJobs();

if (jobs.length !== 2 || !jobs.find((job) => job.title === 'Daily briefing'))
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

for (const badInput of [
    { title: 'Missing prompt', schedule: '0 9 * * *' },
    { title: 'Bad schedule', schedule: '@daily', prompt: 'Run this' },
]) {
    let failed = false;

    try {
        parseAutomationCreateInput(JSON.stringify(badInput));
    } catch (error) {
        failed = Boolean(error.userMessage);
    }

    if (!failed)
        throw new Error(`Invalid automation input was accepted: ${JSON.stringify(badInput)}`);
}

const failingBackend = new FakeCrontabBackend();
const accessError = new Error('blocked by PAM');
accessError.userMessage = 'Unable to read user crontab: blocked by PAM';
failingBackend.readError = accessError;

const status = await new CronJobManager({ backend: failingBackend }).getStatus();

if (status.available || !status.error.includes('blocked by PAM'))
    throw new Error('Cron backend read failure was not surfaced in status');

print('Cusco cron smoke passed');
