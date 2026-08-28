import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { GmailImapClient } from './imap.js';
import { GoaGoogleAccountProvider } from './goa.js';

const APP_ID = 'io.github.stonega.Cusco';
const STATE_VERSION = 1;
const MAX_SEARCH_RESULTS = 50;
const MAX_BATCH_MESSAGES = 20;
export const GMAIL_GOA_CONNECTOR_TYPE = 'gnome-online-accounts';
export const GMAIL_TOOL_NAMES = Object.freeze([
    'read_latest_email',
    'search_emails',
    'search_email_ids',
    'batch_read_email',
    'read_email_thread',
]);

function userVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

export function defaultGmailGoaStatePath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        APP_ID,
        'gmail-goa.json',
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
        providerName: String(account?.providerName ?? 'Google'),
        presentationIdentity: String(account?.presentationIdentity ?? ''),
        emailAddress: String(account?.emailAddress ?? ''),
    };
}

function jsonOutput(value) {
    return JSON.stringify(value, null, 2);
}

export function parseGmailToolInput(input, fallbackField = 'query') {
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

export class GmailGoaConnector {
    constructor(options = {}) {
        this.statePath = options.statePath ?? defaultGmailGoaStatePath();
        this._accountProvider = options.accountProvider ?? new GoaGoogleAccountProvider();
        this._imap = options.imapClient ?? new GmailImapClient();
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
            logError(error, `Failed to load Gmail connector state: ${this.statePath}`);
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

    getStatus() {
        if (!this._selectedAccountId) {
            return {
                connected: false,
                status: 'unconfigured',
                message: 'Choose a Google account from GNOME Online Accounts.',
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
            message: this._lastError
                || 'The selected Google account is no longer available.',
            account: null,
        };
    }

    async connect(accountId = '', options = {}) {
        const accounts = await this.refreshAccounts(options);
        const selectedId = String(accountId ?? '').trim()
            || (accounts.length === 1 ? accounts[0].id : '');

        if (!selectedId) {
            if (accounts.length === 0) {
                throw userVisibleError(
                    'No Google mail account is available in GNOME Online Accounts.',
                    'Add a Google account and enable Mail in Settings → Online Accounts first.',
                );
            }
            throw userVisibleError('Choose which Google account Gmail should use.');
        }

        const account = this._accounts.find((item) => item.id === selectedId);

        if (!account)
            throw userVisibleError('The selected Google account is no longer available.');

        const accessToken = await this._accountProvider.getAccessToken(account, options);
        await this._imap.verify(account, accessToken, options);

        this._selectedAccountId = selectedId;
        this._persist();

        return {
            account: publicAccount(account),
            gmailAddress: String(account.emailAddress ?? ''),
        };
    }

    disconnect() {
        this._selectedAccountId = '';
        this._persist();
    }

    async _withAccessToken(operation, options = {}) {
        if (!this._accountsLoaded)
            await this.refreshAccounts(options);

        const account = this._accounts.find((item) => item.id === this._selectedAccountId);

        if (!account) {
            throw userVisibleError(
                'Gmail is not connected to a GNOME Online Account.',
                'Connect Gmail to a Google account from the Plugins page first.',
            );
        }

        const accessToken = await this._accountProvider.getAccessToken(account, options);
        return await operation(accessToken, account);
    }

    _toolDefinitions() {
        const searchProperties = {
            query: {
                type: 'string',
                description: 'A Gmail search query, such as "in:inbox is:unread newer_than:7d".',
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional Gmail label IDs such as INBOX, UNREAD, or STARRED.',
            },
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
            name: 'read_latest_email',
            label: 'Read latest Gmail message',
            description: 'Read the newest message from the connected Gmail inbox in one bounded request.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Optional Gmail search query. Defaults to "in:inbox".',
                    },
                    tags: searchProperties.tags,
                },
            },
            inputDescription: 'Optional JSON with a Gmail query and tags. Omit both to read the latest inbox message.',
            run: (input, options) => this._withAccessToken(
                async (token, account) => jsonOutput({
                    account: publicAccount(account),
                    ...await this._imap.readLatestEmail(
                        account,
                        token,
                        parseGmailToolInput(input),
                        options,
                    ),
                }),
                options,
            ),
        }, {
            name: 'search_emails',
            label: 'Search Gmail',
            description: 'Search the connected Gmail mailbox and return message metadata and snippets.',
            inputSchema: { type: 'object', properties: searchProperties },
            inputDescription: 'JSON with query, optional tags, max_results, and next_page_token.',
            run: (input, options) => this._withAccessToken(
                async (token, account) => jsonOutput({
                    account: publicAccount(account),
                    ...await this._imap.searchEmails(
                        account,
                        token,
                        parseGmailToolInput(input),
                        options,
                    ),
                }),
                options,
            ),
        }, {
            name: 'search_email_ids',
            label: 'Search Gmail message IDs',
            description: 'Search the connected Gmail mailbox and return only matching message IDs.',
            inputSchema: { type: 'object', properties: searchProperties },
            inputDescription: 'JSON with query, optional tags, max_results, and next_page_token.',
            run: (input, options) => this._withAccessToken(
                async (token, account) => jsonOutput({
                    account: publicAccount(account),
                    ...await this._imap.searchEmailIds(
                        account,
                        token,
                        parseGmailToolInput(input),
                        options,
                    ),
                }),
                options,
            ),
        }, {
            name: 'batch_read_email',
            label: 'Read Gmail messages',
            description: 'Read the bodies and attachment metadata for up to 20 Gmail messages.',
            inputSchema: {
                type: 'object',
                required: ['message_ids'],
                properties: {
                    message_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        minItems: 1,
                        maxItems: MAX_BATCH_MESSAGES,
                        description: 'Gmail message IDs to read.',
                    },
                },
            },
            inputDescription: 'JSON with a message_ids array containing up to 20 IDs.',
            run: (input, options) => this._withAccessToken(
                async (token, account) => jsonOutput({
                    account: publicAccount(account),
                    ...await this._imap.batchReadEmail(
                        account,
                        token,
                        parseGmailToolInput(input, 'message_ids'),
                        options,
                    ),
                }),
                options,
            ),
        }, {
            name: 'read_email_thread',
            label: 'Read Gmail thread',
            description: 'Read the conversation containing a Gmail message or a known Gmail thread.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string', description: 'A Gmail message or thread ID.' },
                    id_type: {
                        type: 'string',
                        enum: ['message', 'thread'],
                        description: 'How to interpret id. Defaults to message.',
                    },
                },
            },
            inputDescription: 'JSON with id and optional id_type (message or thread).',
            run: (input, options) => this._withAccessToken(
                async (token, account) => jsonOutput({
                    account: publicAccount(account),
                    ...await this._imap.readEmailThread(
                        account,
                        token,
                        parseGmailToolInput(input, 'id'),
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
        for (const name of GMAIL_TOOL_NAMES)
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
