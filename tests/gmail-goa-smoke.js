import GLib from 'gi://GLib?version=2.0';

import {
    extractGoaAccessToken,
    GMAIL_TOOL_NAMES,
    GmailGoaConnector,
    GmailImapClient,
    normalizeGmailNumericId,
    parseGmailToolInput,
    parseImapFetchRecords,
} from '../src/connectors/gmailGoa.js';
import { ToolManager } from '../src/tools/tools.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

assert(
    extractGoaAccessToken([true, 'real-access-token', 3600]) === 'real-access-token'
    && extractGoaAccessToken('direct-access-token') === 'direct-access-token',
    'GOA access-token extraction did not skip the GI success return value',
);

let failedTokenResultRejected = false;

try {
    extractGoaAccessToken([false, '', 0]);
} catch (_error) {
    failedTokenResultRejected = true;
}

assert(failedTokenResultRejected, 'GOA token extraction accepted a failed finish result');

const fixtureRoot = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-gmail-goa-${GLib.uuid_string_random()}`,
]);
const statePath = GLib.build_filenamev([fixtureRoot, 'gmail-goa.json']);
const account = {
    id: 'google-account-1',
    providerName: 'Google',
    presentationIdentity: 'person@example.test',
    emailAddress: 'person@example.test',
};
let tokenRequests = 0;
let verificationRequests = 0;
let searchRequests = 0;
let latestReadRequests = 0;
const accountProvider = {
    async listAccounts() {
        return [account];
    },
    async getAccessToken(selected) {
        assert(selected.id === account.id, 'Connector requested a token for the wrong account');
        tokenRequests += 1;
        return 'short-lived-secret-token';
    },
    dispose() {},
};
const imapClient = {
    async verify(selected, token) {
        assert(selected.id === account.id, 'IMAP verification used the wrong account');
        assert(token === 'short-lived-secret-token', 'GOA token did not reach the Gmail client');
        verificationRequests += 1;
        return true;
    },
    async searchEmails(selected, token, input) {
        assert(selected.id === account.id, 'Gmail search used the wrong account');
        assert(token === 'short-lived-secret-token', 'Gmail search did not receive the GOA token');
        assert(input.query === 'in:inbox is:unread', 'Gmail query input was not parsed');
        searchRequests += 1;
        return {
            messages: [{ id: 'message-1', subject: 'Test' }],
            next_page_token: '',
            result_size_estimate: 1,
        };
    },
    async searchEmailIds() {
        return { message_ids: [], next_page_token: '', result_size_estimate: 0 };
    },
    async readLatestEmail(selected, token, input) {
        assert(selected.id === account.id, 'Latest Gmail read used the wrong account');
        assert(token === 'short-lived-secret-token', 'Latest Gmail read did not receive the GOA token');
        assert(Object.keys(input).length === 0, 'Latest Gmail read did not preserve empty input');
        latestReadRequests += 1;
        return {
            message: { id: 'latest-message', subject: 'Latest message' },
            result_size_estimate: 1,
        };
    },
    async batchReadEmail() {
        return { messages: [] };
    },
    async readEmailThread() {
        return { id: 'thread-1', total_messages: 0, messages: [] };
    },
};
const connector = new GmailGoaConnector({ accountProvider, imapClient, statePath });

assert(!connector.getStatus().connected, 'Fresh Gmail connector was unexpectedly connected');
const connected = await connector.connect(account.id);
assert(
    connected.gmailAddress === account.emailAddress
    && connector.getStatus().connected
    && verificationRequests === 1,
    'Gmail connector did not verify and bind the selected GOA account',
);

const [, persistedBytes] = GLib.file_get_contents(statePath);
const persistedText = new TextDecoder().decode(persistedBytes);
assert(
    persistedText.includes(account.id)
    && !persistedText.includes('short-lived-secret-token')
    && !persistedText.includes(account.emailAddress),
    'Gmail connector state persisted more than the selected GOA account ID',
);

const tools = new ToolManager();
await connector.refreshTools(tools, { enabled: true });
const registered = tools.listTools().filter((tool) => GMAIL_TOOL_NAMES.includes(tool.name));
assert(
    registered.length === GMAIL_TOOL_NAMES.length,
    'Connected Gmail tools were not registered',
);
assert(
    registered.every((tool) => tool.requiresPermission && tool.permissionPolicy === 'ask'),
    'Gmail reads did not retain Cusco permission prompts',
);

const request = tools.createRequest(
    'search_emails',
    JSON.stringify({ query: 'in:inbox is:unread' }),
);
const result = await tools.runRequest(request);
assert(
    result.output.includes('message-1')
    && result.output.includes(account.emailAddress)
    && tokenRequests === 2
    && searchRequests === 1,
    'Registered Gmail search did not fetch through the selected GOA account',
);

const latestResult = await tools.runRequest(tools.createRequest('read_latest_email', '{}'));
assert(
    latestResult.output.includes('latest-message')
    && tokenRequests === 3
    && latestReadRequests === 1,
    'Latest Gmail tool did not read the newest message through one connector call',
);

await connector.refreshTools(tools, { enabled: false });
assert(
    !tools.listTools().some((tool) => GMAIL_TOOL_NAMES.includes(tool.name)),
    'Gmail tools remained registered while the plugin was disabled',
);

const reloaded = new GmailGoaConnector({ accountProvider, imapClient, statePath });
assert(
    reloaded.selectedAccountId === account.id,
    'Gmail connector did not restore the selected GOA account ID',
);
await reloaded.refreshAccounts();
assert(reloaded.getStatus().connected, 'Restored Gmail connector did not resolve its GOA account');
reloaded.disconnect();
assert(
    !reloaded.getStatus().connected
    && !new TextDecoder().decode(GLib.file_get_contents(statePath)[1])
        .includes(account.id),
    'Disconnecting Gmail did not clear the selected GOA account ID',
);

assert(
    parseGmailToolInput('newer_than:7d').query === 'newer_than:7d'
    && parseGmailToolInput('{"id":"abc"}', 'id').id === 'abc',
    'Gmail tool input compatibility parsing failed',
);

const rawMessage = [
    'From: Sender <sender@example.test>',
    'To: Person <person@example.test>',
    'Subject: A subject',
    'Content-Type: multipart/mixed; boundary="test-boundary"',
    '',
    '--test-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello from Gmail',
    '--test-boundary',
    'Content-Type: application/pdf; name="brief.pdf"',
    'Content-Disposition: attachment; filename="brief.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'cGRm',
    '--test-boundary--',
    '',
].join('\r\n');
const rawBytes = new TextEncoder().encode(rawMessage);
const [normalized] = parseImapFetchRecords([{
    line: `* 7 FETCH (UID 42 X-GM-MSGID 1278455344230334865 X-GM-THRID 1266894439832287888 X-GM-LABELS (\\Inbox Important) FLAGS (\\Seen) INTERNALDATE "01-Jan-2026 00:00:00 +0000" BODY[]<0> {${rawBytes.length}}`,
    literal: rawBytes,
}, {
    line: ')',
    literal: null,
}, {
    line: 'C0001 OK FETCH completed',
    literal: null,
}], { requestedBytes: 8192 });
assert(
    normalized.body === 'Hello from Gmail'
    && normalized.attachments[0]?.filename === 'brief.pdf'
    && normalized.subject === 'A subject'
    && normalized.id === '1278455344230334865'
    && normalized.labels.includes('INBOX')
    && normalized.flags.includes('SEEN'),
    'Gmail IMAP normalization did not extract IDs, labels, body, headers, and attachment metadata',
);

assert(
    normalizeGmailNumericId('11be69b0a6dd3fd1') === '1278575551654477777'
    && normalizeGmailNumericId('1278455344230334865') === '1278455344230334865',
    'Gmail web/API hex IDs were not normalized for X-GM-MSGID searches',
);

let imapQuery = '';
const fakeSession = {
    async connect() {},
    close() {},
    async search(query) {
        imapQuery = query;
        return Array.from({ length: 60 }, (_value, index) => index + 1);
    },
    async fetch(uids) {
        return uids.map((uid) => ({
            id: String(1000 + uid),
            thread_id: '2000',
            imap_uid: String(uid),
            subject: `Message ${uid}`,
            snippet: 'Metadata result',
            labels: ['INBOX'],
            flags: [],
            body: '',
            attachments: [],
        }));
    },
};
const imap = new GmailImapClient({
    sessionFactory(selected, token) {
        assert(selected === account && token === 'token', 'IMAP session lost account credentials');
        return fakeSession;
    },
});
const search = await imap.searchEmails(account, 'token', {
    query: 'from:sender@example.test',
    tags: ['INBOX', 'UNREAD'],
    max_results: 500,
});
assert(
    imapQuery === 'from:sender@example.test label:INBOX label:UNREAD'
    && search.messages.length === 50
    && search.messages[0]?.subject === 'Message 60'
    && search.next_page_token === '11'
    && search.result_size_estimate === 60,
    'Gmail IMAP search did not preserve query, labels, bounds, ordering, metadata, and pagination',
);

const latest = await imap.readLatestEmail(account, 'token');
assert(
    imapQuery === 'in:inbox'
    && latest.message?.subject === 'Message 60'
    && latest.result_size_estimate === 60,
    'Latest Gmail read did not use the inbox default, newest UID, and one bounded result',
);

const [, gmailSkillBytes] = GLib.file_get_contents('plugins/gmail/skills/gmail/SKILL.md');
const gmailSkill = new TextDecoder().decode(gmailSkillBytes);
assert(
    gmailSkill.includes('Never fall back to Bash')
    && gmailSkill.includes('call `read_latest_email` once'),
    'Gmail skill does not enforce the native one-call mailbox path',
);

connector.dispose();
reloaded.dispose();
print('Cusco Gmail GOA smoke passed');
