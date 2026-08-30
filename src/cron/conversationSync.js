import GLib from 'gi://GLib?version=2.0';

import { createMessage } from '../providers/provider.js';

function isCronConversation(conversation) {
    return conversation?.conversationType === 'cron' && Boolean(conversation.cronJobId);
}

export class CronConversationSync {
    constructor({
        cron,
        conversations,
        getSelectionSerial = () => 0,
        createDefaultConversation = () => {},
        refreshConversationList = () => {},
        renderActiveConversation = () => {},
    }) {
        this._cron = cron;
        this._conversations = conversations;
        this._getSelectionSerial = getSelectionSerial;
        this._createDefaultConversation = createDefaultConversation;
        this._refreshConversationList = refreshConversationList;
        this._renderActiveConversation = renderActiveConversation;
        this._jobIndex = new Map();
        this._observedAutomationRunIds = new Set();
        this._logSyncTimeoutId = 0;
    }

    start() {
        if (this._logSyncTimeoutId)
            return;

        this._logSyncTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this.sync({ refreshUi: true }).catch((error) => {
                logError(error, 'Failed to sync cron job logs');
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (!this._logSyncTimeoutId)
            return;

        GLib.source_remove(this._logSyncTimeoutId);
        this._logSyncTimeoutId = 0;
    }

    dispose() {
        this.stop();
        this._jobIndex.clear();
        this._observedAutomationRunIds.clear();
    }

    async sync({ refreshUi = false } = {}) {
        const activeConversationId = this._conversations.activeConversation?.id ?? null;
        const selectionSerial = this._getSelectionSerial();
        const status = await this._cron.getStatus();

        if (!status.available)
            return status;

        this._jobIndex = new Map(status.jobs.map((job) => [job.id, job]));
        let conversationsChanged = false;

        for (const job of status.jobs) {
            const ensured = this.ensureConversation(job);
            const conversation = ensured.conversation;

            conversationsChanged = conversationsChanged || ensured.changed;

            if (conversation && job.conversationId !== conversation.id) {
                const updatedJob = await this._cron.updateJob(job.id, {
                    conversationId: conversation.id,
                });
                this._jobIndex.set(updatedJob.id, updatedJob);
            }

            if (conversation && this.appendRunLogs(job, conversation))
                conversationsChanged = true;
        }

        if (conversationsChanged
            && selectionSerial === this._getSelectionSerial()
            && activeConversationId
            && this._conversations.getConversation(activeConversationId)) {
            this._conversations.selectConversation(activeConversationId);
        }

        if (refreshUi && conversationsChanged) {
            this._refreshConversationList();

            if (isCronConversation(this._conversations.activeConversation))
                this._renderActiveConversation();
        }

        return status;
    }

    ensureConversation(job) {
        let conversation = job.conversationId
            ? this._conversations.getConversation(job.conversationId)
            : null;
        let changed = false;

        if (!conversation)
            conversation = this.findConversation(job.id);

        if (!conversation) {
            conversation = this._conversations.createConversation({
                title: job.title,
                conversationType: 'cron',
                cronJobId: job.id,
                memoryEnabled: false,
                agentModeEnabled: false,
                messages: [createMessage('system', this.formatJobCreatedMessage(job))],
            });
            changed = true;
        } else if (conversation.conversationType !== 'cron' || conversation.cronJobId !== job.id) {
            this._conversations.setCronMetadata(conversation.id, {
                conversationType: 'cron',
                cronJobId: job.id,
            });
            changed = true;
        }

        if (conversation.title !== job.title) {
            this._conversations.renameConversation(conversation.id, job.title);
            changed = true;
        }

        return { conversation, changed };
    }

    findConversation(jobId) {
        return this._conversations.allConversations.find((conversation) => (
            conversation.conversationType === 'cron' && conversation.cronJobId === jobId
        )) ?? null;
    }

    getJob(jobId) {
        return this._jobIndex.get(jobId) ?? null;
    }

    deleteConversation(jobId) {
        const conversation = this.findConversation(jobId);

        if (!conversation)
            return;

        this._conversations.deleteConversation(conversation.id);

        if (this._conversations.conversations.length === 0)
            this._createDefaultConversation();

        this._refreshConversationList();
        this._renderActiveConversation();
    }

    appendRunLogs(job, conversation) {
        const existingRunIds = new Set(conversation.messages
            .map((message) => message.cronRun?.runId)
            .filter(Boolean));
        const logs = this._cron.readRunLogs(job);
        let appended = false;

        for (const run of logs) {
            const runKey = `${job.id}:${run.runId}`;

            if (existingRunIds.has(run.runId) || this._observedAutomationRunIds.has(runKey))
                continue;

            if (job.prompt && run.exitStatus === 0) {
                this._observedAutomationRunIds.add(runKey);
                continue;
            }

            this._conversations.appendMessage(conversation.id, createMessage(
                'system',
                this.formatRunMessage(job, run),
                {
                    cronRun: {
                        jobId: job.id,
                        runId: run.runId,
                        exitStatus: run.exitStatus,
                        startedAt: run.startedAt,
                        finishedAt: run.finishedAt,
                    },
                },
            ));
            existingRunIds.add(run.runId);
            this._observedAutomationRunIds.add(runKey);
            appended = true;
        }

        return appended;
    }

    formatJobCreatedMessage(job) {
        if (job.prompt) {
            return [
                `Automation: ${job.title}`,
                `Schedule: ${job.schedule}`,
                `Status: ${job.enabled ? 'Active' : 'Paused'}`,
                '',
                'Prompt:',
                job.prompt,
            ].join('\n');
        }

        return [
            `Cron job: ${job.title}`,
            `Schedule: ${job.schedule}`,
            `Status: ${job.enabled ? 'Enabled' : 'Disabled'}`,
            '',
            'Command:',
            '```sh',
            job.command,
            '```',
        ].join('\n');
    }

    formatRunMessage(job, run) {
        if (job.prompt) {
            return [
                `Automation launch failed: ${job.title}`,
                `Schedule: ${job.schedule}`,
                `Started: ${run.startedAt || 'unknown'}`,
                `Finished: ${run.finishedAt || 'unknown'}`,
                `Exit status: ${Number.isFinite(run.exitStatus) ? run.exitStatus : 'unknown'}`,
                '',
                run.stderr || run.stdout || 'Cusco could not be started for this automation.',
            ].join('\n');
        }

        return [
            `Cron job run: ${job.title}`,
            `Schedule: ${job.schedule}`,
            `Started: ${run.startedAt || 'unknown'}`,
            `Finished: ${run.finishedAt || 'unknown'}`,
            `Exit status: ${Number.isFinite(run.exitStatus) ? run.exitStatus : 'unknown'}`,
            '',
            'stdout',
            '```text',
            run.stdout || '<empty>',
            '```',
            '',
            'stderr',
            '```text',
            run.stderr || '<empty>',
            '```',
        ].join('\n');
    }
}
