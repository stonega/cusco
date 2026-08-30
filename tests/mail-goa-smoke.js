import GLib from 'gi://GLib?version=2.0';

import {
    extractGoaCredential,
    GoaMailAccountProvider,
    MAIL_TOOL_NAMES,
    MailGoaConnector,
    parseMailToolInput,
    StandardImapClient,
    StandardImapSession,
} from '../src/connectors/mailGoa.js';
import { ToolManager } from '../src/tools/tools.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

assert(
    extractGoaCredential([true, 'mail-secret', 3600]) === 'mail-secret'
    && extractGoaCredential('direct-secret') === 'direct-secret',
    'GOA mail credential extraction did not skip the GI success return value',
);

let rejectedFailedCredential = false;

try {
    extractGoaCredential([false, '', 0]);
} catch (_error) {
    rejectedFailedCredential = true;
}

assert(rejectedFailedCredential, 'GOA mail credential extraction accepted a failed result');

function fakeGoaObject({
    id,
    providerType,
    providerName,
    useSsl = true,
    useTls = false,
    acceptSslErrors = false,
    credentialType = 'oauth2',
}) {
    return {
        get_account: () => ({
            id,
            provider_type: providerType,
            provider_name: providerName,
            presentation_identity: `${id}@example.test`,
        }),
        get_mail: () => ({
            email_address: `${id}@example.test`,
            imap_supported: true,
            imap_host: 'imap.example.test',
            imap_user_name: `${id}@example.test`,
            imap_use_ssl: useSsl,
            imap_use_tls: useTls,
            imap_accept_ssl_errors: acceptSslErrors,
        }),
        get_oauth2_based: () => credentialType === 'oauth2' ? {} : null,
        get_password_based: () => credentialType === 'password' ? {} : null,
    };
}

const discoveryProvider = new GoaMailAccountProvider({
    clientFactory: async () => ({
        get_accounts: () => [
            fakeGoaObject({
                id: 'microsoft',
                providerType: 'microsoft365',
                providerName: 'Microsoft 365',
            }),
            fakeGoaObject({
                id: 'generic-mail',
                providerType: 'imap-smtp',
                providerName: 'IMAP/SMTP',
                useSsl: false,
                useTls: true,
                credentialType: 'password',
            }),
            fakeGoaObject({ id: 'google', providerType: 'google', providerName: 'Google' }),
            fakeGoaObject({
                id: 'insecure',
                providerType: 'imap-smtp',
                providerName: 'IMAP/SMTP',
                useSsl: false,
            }),
            fakeGoaObject({
                id: 'bad-certificate',
                providerType: 'imap-smtp',
                providerName: 'IMAP/SMTP',
                acceptSslErrors: true,
            }),
        ],
    }),
});
const discoveredAccounts = await discoveryProvider.listAccounts();
assert(
    discoveredAccounts.length === 2
    && discoveredAccounts[0].id === 'microsoft'
    && discoveredAccounts[0].credentialType === 'oauth2'
    && discoveredAccounts[1].id === 'generic-mail'
    && discoveredAccounts[1].credentialType === 'password',
    'GOA Mail discovery did not keep compatible non-Google secure IMAP accounts only',
);
discoveryProvider.dispose();

const fixtureRoot = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-mail-goa-${GLib.uuid_string_random()}`,
]);
const statePath = GLib.build_filenamev([fixtureRoot, 'mail-goa.json']);
const account = {
    id: 'microsoft-account-1',
    providerType: 'microsoft365',
    providerName: 'Microsoft 365',
    presentationIdentity: 'person@example.test',
    emailAddress: 'person@example.test',
    imapHost: 'imap.example.test',
    imapUserName: 'person@example.test',
    imapUseSsl: true,
    imapUseTls: false,
};
let credentialRequests = 0;
let verificationRequests = 0;
let searchRequests = 0;
let latestReadRequests = 0;
const accountProvider = {
    async listAccounts() {
        return [account];
    },
    async getCredential(selected) {
        assert(selected.id === account.id, 'Mail connector requested the wrong account');
        credentialRequests += 1;
        return { type: 'oauth2', secret: 'short-lived-mail-secret' };
    },
    dispose() {},
};
const imapClient = {
    async verify(selected, credential) {
        assert(selected.id === account.id, 'Mail verification used the wrong account');
        assert(
            credential.type === 'oauth2' && credential.secret === 'short-lived-mail-secret',
            'GOA credential did not reach the standard IMAP client',
        );
        verificationRequests += 1;
        return true;
    },
    async searchEmails(selected, credential, input) {
        assert(selected.id === account.id, 'Mail search used the wrong account');
        assert(credential.secret === 'short-lived-mail-secret', 'Mail search lost its credential');
        assert(
            input.from === 'sender@example.test' && input.unread === true,
            'Structured Mail filters were not parsed',
        );
        searchRequests += 1;
        return {
            messages: [{ id: '42', subject: 'Test' }],
            message_ids: ['42'],
            next_page_token: '',
            result_size_estimate: 1,
        };
    },
    async searchEmailIds() {
        return { message_ids: ['42'], next_page_token: '', result_size_estimate: 1 };
    },
    async readLatestEmail(selected, credential, input) {
        assert(selected.id === account.id, 'Latest Mail read used the wrong account');
        assert(credential.secret === 'short-lived-mail-secret', 'Latest Mail read lost its credential');
        assert(Object.keys(input).length === 0, 'Latest Mail read did not preserve empty input');
        latestReadRequests += 1;
        return { message: { id: '43', subject: 'Latest' }, result_size_estimate: 1 };
    },
    async batchReadEmail() {
        return { messages: [] };
    },
};
const connector = new MailGoaConnector({ accountProvider, imapClient, statePath });

assert(!connector.getStatus().connected, 'Fresh Mail connector was unexpectedly connected');
const connected = await connector.connect(account.id);
assert(
    connected.mailAddress === account.emailAddress
    && connector.getStatus().connected
    && verificationRequests === 1,
    'Mail connector did not verify and bind the selected GOA account',
);

const persistedText = new TextDecoder().decode(GLib.file_get_contents(statePath)[1]);
assert(
    persistedText.includes(account.id)
    && !persistedText.includes('short-lived-mail-secret')
    && !persistedText.includes(account.emailAddress),
    'Mail connector persisted more than the selected GOA account ID',
);

const tools = new ToolManager();
await connector.refreshTools(tools, { enabled: true });
const registered = tools.listTools().filter((tool) => MAIL_TOOL_NAMES.includes(tool.name));
assert(
    registered.length === MAIL_TOOL_NAMES.length
    && registered.every((tool) => tool.requiresPermission && tool.permissionPolicy === 'ask'),
    'Connected Mail tools were not registered with permission prompts',
);

const searchResult = await tools.runRequest(tools.createRequest(
    'search_mail',
    JSON.stringify({ from: 'sender@example.test', unread: true }),
));
assert(
    searchResult.output.includes('42')
    && searchResult.output.includes('Microsoft 365')
    && credentialRequests === 2
    && searchRequests === 1,
    'Registered Mail search did not use the selected GOA account',
);

const latestResult = await tools.runRequest(tools.createRequest('read_latest_mail', '{}'));
assert(
    latestResult.output.includes('43')
    && credentialRequests === 3
    && latestReadRequests === 1,
    'Latest Mail tool did not read through one native connector call',
);

await connector.refreshTools(tools, { enabled: false });
assert(
    !tools.listTools().some((tool) => MAIL_TOOL_NAMES.includes(tool.name)),
    'Mail tools remained registered while the plugin was disabled',
);

const reloaded = new MailGoaConnector({ accountProvider, imapClient, statePath });
assert(reloaded.selectedAccountId === account.id, 'Mail connector did not restore its account ID');
await reloaded.refreshAccounts();
assert(reloaded.getStatus().connected, 'Restored Mail connector did not resolve its GOA account');
reloaded.disconnect();
assert(
    !new TextDecoder().decode(GLib.file_get_contents(statePath)[1]).includes(account.id),
    'Disconnecting Mail did not clear the selected GOA account ID',
);

assert(
    parseMailToolInput('quarterly report').query === 'quarterly report'
    && parseMailToolInput('{"message_ids":["42"]}', 'message_ids').message_ids[0] === '42',
    'Mail tool input compatibility parsing failed',
);

let clientSearchInput = null;
let clientBeforeUid = 0;
const fakeClientSession = {
    async connect() {},
    close() {},
    async search(input, beforeUid) {
        clientSearchInput = input;
        clientBeforeUid = beforeUid;
        return Array.from({ length: 60 }, (_value, index) => index + 1);
    },
    async fetch(uids) {
        return uids.map((uid) => ({
            id: String(uid),
            imap_uid: String(uid),
            subject: `Message ${uid}`,
            body: 'Body',
            attachments: [],
        }));
    },
};
const standardClient = new StandardImapClient({
    sessionFactory(selected, credential) {
        assert(selected === account, 'Standard IMAP client lost the account');
        assert(credential.secret === 'secret', 'Standard IMAP client lost the credential');
        return fakeClientSession;
    },
});
const standardSearch = await standardClient.searchEmails(
    account,
    { type: 'oauth2', secret: 'secret' },
    { subject: 'Report', max_results: 500, next_page_token: '55' },
);
assert(
    clientSearchInput.subject === 'Report'
    && clientBeforeUid === 55
    && standardSearch.messages.length === 50
    && standardSearch.messages[0]?.id === '60'
    && standardSearch.next_page_token === '11',
    'Standard IMAP search did not preserve filters, bounds, ordering, and pagination',
);
const standardIds = await standardClient.searchEmailIds(
    account,
    { type: 'oauth2', secret: 'secret' },
    { max_results: 2 },
);
assert(
    standardIds.message_ids.join(',') === '60,59',
    'Standard IMAP ID search did not return bounded UIDs',
);

function fakeTransport({ startTls = false, oauth2 = true } = {}) {
    const records = [{ line: '* OK IMAP ready', literal: null }];
    const written = [];
    let tlsStarts = 0;

    return {
        written,
        get tlsStarts() {
            return tlsStarts;
        },
        async connect() {},
        async startTls() {
            tlsStarts += 1;
        },
        async readRecord() {
            return records.shift();
        },
        async writeLine(line) {
            written.push(line);
            const tag = line.split(/\s+/, 1)[0];

            if (/ CAPABILITY$/i.test(line)) {
                const capabilities = [
                    'IMAP4rev1',
                    startTls && tlsStarts === 0 ? 'STARTTLS' : '',
                    oauth2 ? 'AUTH=XOAUTH2' : '',
                ].filter(Boolean).join(' ');
                records.push(
                    { line: `* CAPABILITY ${capabilities}`, literal: null },
                    { line: `${tag} OK CAPABILITY`, literal: null },
                );
            } else if (/ STARTTLS$/i.test(line)) {
                records.push({ line: `${tag} OK STARTTLS`, literal: null });
            } else if (/ AUTHENTICATE XOAUTH2 /i.test(line) || / LOGIN /i.test(line)) {
                records.push({ line: `${tag} OK authenticated`, literal: null });
            } else if (/ EXAMINE /i.test(line)) {
                records.push({ line: `${tag} OK selected`, literal: null });
            } else if (/ UID SEARCH /i.test(line)) {
                records.push(
                    { line: '* SEARCH 6 8', literal: null },
                    { line: `${tag} OK searched`, literal: null },
                );
            }
        },
        close() {},
    };
}

const oauthTransport = fakeTransport({ startTls: true, oauth2: true });
const oauthSession = new StandardImapSession(
    { ...account, imapUseSsl: false, imapUseTls: true },
    { type: 'oauth2', secret: 'oauth-secret' },
    { transport: oauthTransport },
);
await oauthSession.connect();
const searchedUids = await oauthSession.search({
    query: 'quarterly "report"',
    from: 'sender@example.test',
    since: '2026-08-01',
    unread: true,
}, 77);
assert(
    oauthTransport.tlsStarts === 1
    && searchedUids.join(',') === '6,8'
    && oauthTransport.written.some((line) => line.includes('AUTHENTICATE XOAUTH2'))
    && oauthTransport.written.some((line) => (
        line.includes('UID 1:76')
        && line.includes('TEXT "quarterly \\"report\\""')
        && line.includes('FROM "sender@example.test"')
        && line.includes('SINCE 1-Aug-2026')
        && line.includes('UNSEEN')
    )),
    'Standard IMAP session did not enforce STARTTLS, OAuth2, or safe structured search',
);
oauthSession.close();

const passwordTransport = fakeTransport({ oauth2: false });
const passwordSession = new StandardImapSession(
    account,
    { type: 'password', secret: 'password-secret' },
    { transport: passwordTransport },
);
await passwordSession.connect();
assert(
    passwordTransport.written.some((line) => line.includes(' LOGIN ')),
    'Standard IMAP session did not support GOA password credentials',
);
passwordSession.close();

const mailSkill = new TextDecoder().decode(
    GLib.file_get_contents('plugins/mail/skills/mail/SKILL.md')[1],
);
assert(
    mailSkill.includes('never retrieve credentials with Bash')
    && mailSkill.includes('Call `read_latest_mail` once'),
    'Mail skill does not enforce the native credential and one-call path',
);

connector.dispose();
reloaded.dispose();

print('Cusco Mail GOA smoke passed');
