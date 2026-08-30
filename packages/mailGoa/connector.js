import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { StandardImapClient } from '../gmailGoa/imap.js';
import { GoaMailAccountProvider } from './goa.js';

const APP_ID = 'io.github.stonega.Cusco';
const STATE_VERSION = 1;
const MAX_SEARCH_RESULTS = 50;
const MAX_BATCH_MESSAGES = 20;
export const MAIL_GOA_CONNECTOR_TYPE = 'gnome-online-accounts';
export const MAIL_TOOL_NAMES = Object.freeze([
    'read_latest_mail',
    'search_mail',
    'search_mail_ids',
    'batch_read_mail',
]);

function userVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

export function defaultMailGoaStatePath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        APP_ID,
        'mail-goa.json',
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
        throw new Error(`Could not create connector state directory: ${directory}`);
    GLib.chmod(directory, 0o700);
    GLib.file_set_contents(temporaryPath, contents);

    try {
        if (GLib.chmod(temporaryPath, 0o600) !== 0)
            throw new Error(`Could not secure connector state: ${temporaryPath}`);

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

function publicAccount(account) {
    return {
        id: String(account?.id ?? ''),
        providerType: String(account?.providerType ?? ''),
        providerName: String(account?.providerName ?? 'Mail'),
        presentationIdentity: String(account?.presentationIdentity ?? ''),
        emailAddress: String(account?.emailAddress ?? ''),
    };
}

function jsonOutput(value) {
    return JSON.stringify(value, null, 2);
}

export function parseMailToolInput(input, fallbackField = 'query') {
    const text = String(input ?? '').trim();

    if (!text)
        return {};

    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : { [fallbackField]: parsed };
    } catch (_error) {
        return { [fallbackField]: text };
    }
}

export class MailGoaConnector {
    constructor(options = {}) {
        this.statePath = options.statePath ?? defaultMailGoaStatePath();
        this._accountProvider = options.accountProvider ?? new GoaMailAccountProvider();
        this._imap = options.imapClient ?? new StandardImapClient();
        this._selectedAccountId = this._loadSelectedAccountId();
        this._accounts = [];
        this._accountsLoaded = false;
        this._lastError = '';
    }

    get selectedAccountId() {
        return this._selectedAccountId;
    }

    _loadSelectedAccountId() {
        if (!GLib.file_test(this.statePath, GLib.FileTest.IS_REGULAR))
            return '';

        try {
            const [, bytes] = GLib.file_get_contents(this.statePath);
            const state = JSON.parse(new TextDecoder().decode(bytes));
            return state?.version === STATE_VERSION
                ? String(state.selectedAccountId ?? '').trim()
                : '';
        } catch (error) {
            logError(error, `Failed to load Mail connector state: ${this.statePath}`);
            return '';
        }
    }

    _persist() {
        writeFileAtomically(this.statePath, `${JSON.stringify({
            version: STATE_VERSION,
            selectedAccountId: this._selectedAccountId,
        }, null, 2)}\n`);
    }

    async refreshAccounts(options = {}) {
        try {
            this._accounts = await this._accountProvider.listAccounts(options);
            this._accountsLoaded = true;
            this._lastError = '';
            return this._accounts.map(publicAccount);
        } catch (error) {
            this._accounts = [];
            this._accountsLoaded = true;
            this._lastError = error?.userMessage || error?.message || 'GNOME Online Accounts failed.';
            throw error;
        }
    }

    listAccounts() {
        return this._accounts.map(publicAccount);
    }

    noAccountsError() {
        return userVisibleError(
            'No compatible non-Google mail account is available in GNOME Online Accounts.',
            'Add a Microsoft, Microsoft 365, Exchange, or IMAP/SMTP account and enable Mail in Settings → Online Accounts first.',
        );
    }

    getStatus() {
        if (!this._selectedAccountId) {
            return {
                connected: false,
                status: 'unconfigured',
                message: 'Choose a mail account from GNOME Online Accounts.',
                account: null,
            };
        }

        const account = this._accounts.find((item) => item.id === this._selectedAccountId);

        if (account) {
            return {
                connected: true,
                status: 'connected',
                message: `Connected as ${account.emailAddress || account.presentationIdentity}`,
                account: publicAccount(account),
            };
        }

        if (!this._accountsLoaded) {
            return {
                connected: false,
                status: 'checking',
                message: 'Checking GNOME Online Accounts…',
                account: null,
            };
        }

        return {
            connected: false,
            status: 'error',
            message: this._lastError || 'The selected mail account is no longer available.',
            account: null,
        };
    }

    async connect(accountId = '', options = {}) {
        const accounts = await this.refreshAccounts(options);
        const selectedId = String(accountId ?? '').trim()
            || (accounts.length === 1 ? accounts[0].id : '');

        if (!selectedId) {
            if (accounts.length === 0)
                throw this.noAccountsError();
            throw userVisibleError('Choose which online mail account Cusco should use.');
        }

        const account = this._accounts.find((item) => item.id === selectedId);

        if (!account)
            throw userVisibleError('The selected mail account is no longer available.');

        const credential = await this._accountProvider.getCredential(account, options);
        await this._imap.verify(account, credential, options);

        this._selectedAccountId = selectedId;
        this._persist();

        return {
            account: publicAccount(account),
            mailAddress: String(account.emailAddress ?? ''),
        };
    }

    disconnect() {
        this._selectedAccountId = '';
        this._persist();
    }

    async _withCredential(operation, options = {}) {
        if (!this._accountsLoaded)
            await this.refreshAccounts(options);

        const account = this._accounts.find((item) => item.id === this._selectedAccountId);

        if (!account) {
            throw userVisibleError(
                'Mail is not connected to a GNOME Online Account.',
                'Connect Mail to an online account from the Plugins page first.',
            );
        }

        const credential = await this._accountProvider.getCredential(account, options);
        return await operation(credential, account);
    }

    _toolDefinitions() {
        const searchProperties = {
            query: {
                type: 'string',
                description: 'Words or phrases to find anywhere in the message.',
            },
            from: { type: 'string', description: 'Match sender addresses or names.' },
            to: { type: 'string', description: 'Match recipient addresses or names.' },
            subject: { type: 'string', description: 'Match words in the subject.' },
            since: { type: 'string', description: 'Only messages on or after YYYY-MM-DD.' },
            before: { type: 'string', description: 'Only messages before YYYY-MM-DD.' },
            unread: { type: 'boolean', description: 'When true, only unread messages.' },
            flagged: { type: 'boolean', description: 'When true, only flagged messages.' },
            max_results: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_SEARCH_RESULTS,
                description: 'Maximum messages to return (default 20, maximum 50).',
            },
            next_page_token: {
                type: 'string',
                description: 'Pagination token returned by an earlier search.',
            },
        };

        return [{
            name: 'read_latest_mail',
            label: 'Read latest mail message',
            description: 'Read the newest message from the connected inbox in one bounded request.',
            inputSchema: {
                type: 'object',
                properties: searchProperties,
            },
            inputDescription: 'Optional JSON filters. Omit all fields to read the newest inbox message.',
            run: (input, options) => this._withCredential(
                async (credential, account) => jsonOutput({
                    account: publicAccount(account),
                    ...await this._imap.readLatestEmail(
                        account,
                        credential,
                        parseMailToolInput(input),
                        options,
                    ),
                }),
                options,
            ),
        }, {
            name: 'search_mail',
            label: 'Search mail',
            description: 'Search the connected inbox with standard, bounded IMAP filters.',
            inputSchema: { type: 'object', properties: searchProperties },
            inputDescription: 'JSON with search filters, max_results, and optional next_page_token.',
            run: (input, options) => this._withCredential(
                async (credential, account) => jsonOutput({
                    account: publicAccount(account),
                    ...await this._imap.searchEmails(
                        account,
                        credential,
                        parseMailToolInput(input),
                        options,
                    ),
                }),
                options,
            ),
        }, {
            name: 'search_mail_ids',
            label: 'Search mail message IDs',
            description: 'Search the connected inbox and return only matching IMAP message IDs.',
            inputSchema: { type: 'object', properties: searchProperties },
            inputDescription: 'JSON with search filters, max_results, and optional next_page_token.',
            run: (input, options) => this._withCredential(
                async (credential, account) => jsonOutput({
                    account: publicAccount(account),
                    ...await this._imap.searchEmailIds(
                        account,
                        credential,
                        parseMailToolInput(input),
                        options,
                    ),
                }),
                options,
            ),
        }, {
            name: 'batch_read_mail',
            label: 'Read mail messages',
            description: 'Read the bodies and attachment metadata for up to 20 inbox messages.',
            inputSchema: {
                type: 'object',
                required: ['message_ids'],
                properties: {
                    message_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        minItems: 1,
                        maxItems: MAX_BATCH_MESSAGES,
                        description: 'Numeric IMAP message IDs returned by search_mail.',
                    },
                },
            },
            inputDescription: 'JSON with a message_ids array containing up to 20 IDs.',
            run: (input, options) => this._withCredential(
                async (credential, account) => jsonOutput({
                    account: publicAccount(account),
                    ...await this._imap.batchReadEmail(
                        account,
                        credential,
                        parseMailToolInput(input, 'message_ids'),
                        options,
                    ),
                }),
                options,
            ),
        }].map((tool) => ({
            ...tool,
            permissionPolicy: 'ask',
            requiresPermission: true,
            concurrencySafe: true,
        }));
    }

    async refreshTools(toolManager, options = {}) {
        for (const name of MAIL_TOOL_NAMES)
            toolManager?.unregisterTool?.(name);

        if (options.enabled === false)
            return this.getStatus();

        try {
            await this.refreshAccounts(options);
        } catch (_error) {
            return this.getStatus();
        }

        if (!this.getStatus().connected)
            return this.getStatus();

        for (const tool of this._toolDefinitions())
            toolManager?.registerTool?.(tool);

        return this.getStatus();
    }

    dispose() {
        this._accountProvider.dispose?.();
        this._accounts = [];
    }
}
