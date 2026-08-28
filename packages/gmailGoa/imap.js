import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_SEARCH_RESULTS = 20;
const MAX_SEARCH_RESULTS = 50;
const MAX_BATCH_MESSAGES = 20;
const MAX_THREAD_MESSAGES = 50;
const SEARCH_PREVIEW_BYTES = 8192;
const READ_PREVIEW_BYTES = 131072;
const MAX_LITERAL_BYTES = READ_PREVIEW_BYTES + 65536;
const MAX_BODY_CHARS = 40000;

function userVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

function boundedInteger(value, fallback, maximum) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed)
        ? Math.max(1, Math.min(maximum, parsed))
        : fallback;
}

function stringList(value) {
    return Array.isArray(value)
        ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
        : [];
}

function concatBytes(chunks, totalLength) {
    const output = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }

    return output;
}

function connectToHost(client, host, defaultPort, cancellable) {
    return new Promise((resolve, reject) => {
        client.connect_to_host_async(host, defaultPort, cancellable, (source, result) => {
            try {
                resolve(source.connect_to_host_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function readLine(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                const finished = source.read_line_finish_utf8(result);
                const values = Array.isArray(finished) ? finished : [finished];
                const line = values.find((value) => typeof value === 'string');
                resolve(line === undefined ? null : line);
            } catch (error) {
                reject(error);
            }
        });
    });
}

function readBytes(stream, count, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(
            count,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, result) => {
                try {
                    resolve(source.read_bytes_finish(result));
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

function writeAll(stream, bytes, cancellable) {
    return new Promise((resolve, reject) => {
        stream.write_all_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, result) => {
                try {
                    source.write_all_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

function flush(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.flush_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
            try {
                source.flush_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

function imapQuoted(value) {
    const text = String(value ?? '');

    if (/[\r\n\0]/.test(text))
        throw userVisibleError('An IMAP value contained prohibited control characters.');

    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseTaggedStatus(line, tag) {
    const match = String(line ?? '').match(new RegExp(`^${tag}\\s+(OK|NO|BAD)\\b`, 'i'));
    return match?.[1]?.toUpperCase() ?? '';
}

class GioImapTransport {
    constructor(account, options = {}) {
        this._account = account;
        this._cancellable = options.cancellable ?? null;
        this._timeoutSeconds = Math.max(
            1,
            Math.round(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
        );
        this._connection = null;
        this._input = null;
        this._output = null;
    }

    async connect() {
        if (!this._account.imapUseSsl) {
            throw userVisibleError(
                'The selected GOA account does not expose an SSL IMAP endpoint.',
                'Gmail did not provide the secure IMAP configuration expected by Cusco.',
            );
        }

        const client = new Gio.SocketClient({
            timeout: this._timeoutSeconds,
            tls: true,
        });

        try {
            this._connection = await connectToHost(
                client,
                this._account.imapHost,
                993,
                this._cancellable,
            );
        } catch (error) {
            throw userVisibleError(
                `Could not connect to Gmail IMAP: ${error.message}`,
                'Cusco could not reach Gmail’s secure IMAP server.',
            );
        }

        this._input = new Gio.DataInputStream({
            base_stream: this._connection.get_input_stream(),
            newline_type: Gio.DataStreamNewlineType.CR_LF,
        });
        this._output = this._connection.get_output_stream();
    }

    async _readExact(count) {
        if (count > MAX_LITERAL_BYTES) {
            throw userVisibleError(
                `Gmail returned an oversized IMAP literal (${count} bytes).`,
                'Gmail returned more message data than Cusco’s safety limit allows.',
            );
        }

        const chunks = [];
        let total = 0;

        while (total < count) {
            const bytes = await readBytes(this._input, count - total, this._cancellable);
            const chunk = bytes.get_data();

            if (!chunk?.length)
                throw userVisibleError('Gmail closed the IMAP connection during a message body.');

            chunks.push(chunk);
            total += chunk.length;
        }

        return concatBytes(chunks, total);
    }

    async readRecord() {
        const line = await readLine(this._input, this._cancellable);

        if (line === null)
            throw userVisibleError('Gmail closed the IMAP connection unexpectedly.');

        const literalMatch = line.match(/\{(\d+)\}\s*$/);
        const literal = literalMatch
            ? await this._readExact(Number.parseInt(literalMatch[1], 10))
            : null;

        return { line, literal };
    }

    async writeLine(line) {
        const bytes = new TextEncoder().encode(`${line}\r\n`);
        await writeAll(this._output, bytes, this._cancellable);
        await flush(this._output, this._cancellable);
    }

    close() {
        try {
            this._connection?.close(null);
        } catch (_error) {
            // The server may already have closed the connection.
        }

        this._connection = null;
        this._input = null;
        this._output = null;
    }
}

function allMailMailbox(records) {
    for (const record of records) {
        const match = record.line.match(/^\*\s+LIST\s+\(([^)]*)\)\s+(?:"[^"]*"|NIL)\s+(.+)$/i);

        if (match && /(?:^|\s)\\All(?:\s|$)/i.test(match[1]))
            return match[2].trim();
    }

    return 'INBOX';
}

function searchUids(records) {
    const output = [];

    for (const record of records) {
        const match = record.line.match(/^\*\s+SEARCH(?:\s+(.*))?$/i);

        if (!match)
            continue;

        for (const value of String(match[1] ?? '').trim().split(/\s+/)) {
            if (/^\d+$/.test(value))
                output.push(Number.parseInt(value, 10));
        }
    }

    return output;
}

export class ImapSession {
    constructor(account, accessToken, options = {}) {
        this._account = account;
        this._accessToken = String(accessToken ?? '');
        this._transport = options.transport ?? new GioImapTransport(account, options);
        this._nextTag = 1;
        this._capabilities = new Set();
    }

    _tag() {
        const tag = `C${String(this._nextTag).padStart(4, '0')}`;
        this._nextTag += 1;
        return tag;
    }

    async _readTagged(tag, action, { authentication = false } = {}) {
        const records = [];

        for (let count = 0; count < 100000; count += 1) {
            const record = await this._transport.readRecord();
            records.push(record);

            if (/^\*\s+BYE\b/i.test(record.line))
                throw userVisibleError(`Gmail ended the IMAP session while ${action}.`);

            if (authentication && /^\+/.test(record.line)) {
                await this._transport.writeLine('');
                continue;
            }

            const status = parseTaggedStatus(record.line, tag);

            if (!status)
                continue;

            if (status !== 'OK') {
                const userMessage = authentication
                    ? 'Gmail rejected the GNOME Online Accounts credential. Reconnect the Google account in GNOME Settings.'
                    : `Gmail could not finish ${action}.`;
                throw userVisibleError(
                    `Gmail IMAP returned ${status} while ${action}: ${record.line}`,
                    userMessage,
                );
            }

            return records;
        }

        throw userVisibleError(`Gmail returned too many IMAP records while ${action}.`);
    }

    async command(command, action) {
        const tag = this._tag();
        await this._transport.writeLine(`${tag} ${command}`);
        return await this._readTagged(tag, action);
    }

    async connect() {
        await this._transport.connect();
        const greeting = await this._transport.readRecord();

        if (!/^\*\s+(?:OK|PREAUTH)\b/i.test(greeting.line))
            throw userVisibleError('Gmail IMAP did not return a valid greeting.');

        const capabilityRecords = await this.command('CAPABILITY', 'checking capabilities');

        for (const record of capabilityRecords) {
            const match = record.line.match(/^\*\s+CAPABILITY\s+(.+)$/i);

            if (match) {
                for (const capability of match[1].split(/\s+/))
                    this._capabilities.add(capability.toUpperCase());
            }
        }

        if (!this._capabilities.has('AUTH=XOAUTH2'))
            throw userVisibleError('Gmail IMAP did not advertise XOAUTH2 authentication.');

        const userName = this._account.imapUserName
            || this._account.emailAddress
            || this._account.presentationIdentity;
        const authText = `user=${userName}\x01auth=Bearer ${this._accessToken}\x01\x01`;
        const authPayload = GLib.base64_encode(new TextEncoder().encode(authText));
        const authTag = this._tag();
        await this._transport.writeLine(`${authTag} AUTHENTICATE XOAUTH2 ${authPayload}`);
        await this._readTagged(authTag, 'authenticating', { authentication: true });

        if (!this._capabilities.has('X-GM-EXT-1')) {
            const refreshed = await this.command('CAPABILITY', 'checking Gmail extensions');

            for (const record of refreshed) {
                if (/\bX-GM-EXT-1\b/i.test(record.line))
                    this._capabilities.add('X-GM-EXT-1');
            }
        }

        if (!this._capabilities.has('X-GM-EXT-1'))
            throw userVisibleError('The selected mail server does not expose Gmail IMAP extensions.');

        await this.command(
            'ID ("name" "Cusco" "version" "0.5.40" "vendor" "Cusco")',
            'identifying the client',
        );
        const listRecords = await this.command(
            'LIST "" "*" RETURN (SPECIAL-USE)',
            'finding All Mail',
        );
        await this.command(`EXAMINE ${allMailMailbox(listRecords)}`, 'opening All Mail read-only');
    }

    async search(query = '', beforeUid = 0) {
        const criteria = [];

        if (beforeUid > 1)
            criteria.push(`UID 1:${beforeUid - 1}`);

        if (String(query).trim())
            criteria.push(`X-GM-RAW ${imapQuoted(query)}`);
        else
            criteria.push('ALL');

        return searchUids(await this.command(
            `UID SEARCH ${criteria.join(' ')}`,
            'searching Gmail',
        ));
    }

    async searchMessageId(messageId) {
        return searchUids(await this.command(
            `UID SEARCH X-GM-MSGID ${messageId}`,
            'finding a Gmail message',
        ));
    }

    async searchThreadId(threadId) {
        return searchUids(await this.command(
            `UID SEARCH X-GM-THRID ${threadId}`,
            'finding a Gmail thread',
        ));
    }

    async fetch(uids, byteLimit = SEARCH_PREVIEW_BYTES) {
        const normalizedUids = uids
            .map((uid) => Number.parseInt(uid, 10))
            .filter((uid) => Number.isFinite(uid) && uid > 0);

        if (normalizedUids.length === 0)
            return [];

        const bodyFetch = byteLimit > 0
            ? ` BODY.PEEK[]<0.${Math.min(READ_PREVIEW_BYTES, byteLimit)}>`
            : '';
        const records = await this.command([
            `UID FETCH ${normalizedUids.join(',')}`,
            `(UID X-GM-MSGID X-GM-THRID X-GM-LABELS FLAGS INTERNALDATE${bodyFetch})`,
        ].join(' '), 'reading Gmail messages');
        return parseImapFetchRecords(records, { requestedBytes: byteLimit });
    }

    close() {
        this._accessToken = '';
        this._transport.close();
    }
}

function unfoldHeaderLines(text) {
    return String(text ?? '').replace(/\r?\n[ \t]+/g, ' ');
}

function headerMap(headerText) {
    const headers = new Map();

    for (const line of unfoldHeaderLines(headerText).split(/\r?\n/)) {
        const separator = line.indexOf(':');

        if (separator <= 0)
            continue;

        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        const existing = headers.get(name) ?? [];
        existing.push(value);
        headers.set(name, existing);
    }

    return headers;
}

function firstHeader(headers, name) {
    return headers.get(String(name).toLowerCase())?.[0] ?? '';
}

function decodeBytes(bytes, charset = 'utf-8') {
    try {
        return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch (_error) {
        return new TextDecoder('utf-8').decode(bytes);
    }
}

function quotedPrintableBytes(value) {
    const source = String(value ?? '').replace(/=\r?\n/g, '');
    const output = [];

    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === '=' && /^[0-9a-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
            output.push(Number.parseInt(source.slice(index + 1, index + 3), 16));
            index += 2;
        } else {
            output.push(source.charCodeAt(index) & 0xff);
        }
    }

    return new Uint8Array(output);
}

function decodeEncodedWords(value) {
    return String(value ?? '').replace(
        /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
        (_match, charset, encoding, encoded) => {
            try {
                const bytes = encoding.toLowerCase() === 'b'
                    ? GLib.base64_decode(encoded)
                    : quotedPrintableBytes(encoded.replace(/_/g, ' '));
                return decodeBytes(bytes, charset);
            } catch (_error) {
                return _match;
            }
        },
    );
}

function contentType(value) {
    const input = String(value ?? 'text/plain');
    const [mimeValue, ...parameterParts] = input.split(';');
    const parameters = {};

    for (const part of parameterParts) {
        const separator = part.indexOf('=');

        if (separator <= 0)
            continue;

        const name = part.slice(0, separator).trim().toLowerCase();
        const parameter = part.slice(separator + 1).trim().replace(/^"|"$/g, '');
        parameters[name] = parameter.replace(/\\"/g, '"');
    }

    return { mimeType: mimeValue.trim().toLowerCase(), parameters };
}

function splitMessage(rawText) {
    const match = rawText.match(/\r?\n\r?\n/);

    if (!match)
        return { headerText: rawText, bodyText: '' };

    return {
        headerText: rawText.slice(0, match.index),
        bodyText: rawText.slice(match.index + match[0].length),
    };
}

function decodePartBody(bodyText, headers, charset) {
    const transferEncoding = firstHeader(headers, 'content-transfer-encoding').toLowerCase();
    let bytes;

    if (transferEncoding === 'base64') {
        try {
            bytes = GLib.base64_decode(bodyText.replace(/\s+/g, ''));
        } catch (_error) {
            bytes = new TextEncoder().encode(bodyText);
        }
    } else if (transferEncoding === 'quoted-printable') {
        bytes = quotedPrintableBytes(bodyText);
    } else {
        bytes = new TextEncoder().encode(bodyText);
    }

    return decodeBytes(bytes, charset);
}

function htmlToText(value) {
    const entities = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
    return String(value ?? '')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
            const lower = entity.toLowerCase();

            if (lower.startsWith('#')) {
                const point = lower.startsWith('#x')
                    ? Number.parseInt(lower.slice(2), 16)
                    : Number.parseInt(lower.slice(1), 10);
                return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
                    ? String.fromCodePoint(point)
                    : match;
            }

            return entities[lower] ?? match;
        })
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function dispositionFilename(headers, type) {
    const disposition = contentType(firstHeader(headers, 'content-disposition'));
    return disposition.parameters.filename
        || type.parameters.name
        || '';
}

function collectMimeParts(rawText, output = { plain: [], html: [], attachments: [] }) {
    const { headerText, bodyText } = splitMessage(rawText);
    const headers = headerMap(headerText);
    const type = contentType(firstHeader(headers, 'content-type'));

    if (type.mimeType.startsWith('multipart/') && type.parameters.boundary) {
        const marker = `--${type.parameters.boundary}`;

        for (const section of bodyText.split(marker).slice(1)) {
            if (section.startsWith('--'))
                break;
            collectMimeParts(section.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), output);
        }
        return output;
    }

    const filename = decodeEncodedWords(dispositionFilename(headers, type));

    if (filename) {
        output.attachments.push({
            filename,
            mime_type: type.mimeType || 'application/octet-stream',
            size: new TextEncoder().encode(bodyText).length,
        });
        return output;
    }

    const decoded = decodePartBody(bodyText, headers, type.parameters.charset || 'utf-8');

    if (type.mimeType === 'text/plain')
        output.plain.push(decoded.trim());
    else if (type.mimeType === 'text/html')
        output.html.push(htmlToText(decoded));

    return output;
}

function parseImapList(value) {
    const output = [];
    const input = String(value ?? '');
    const matcher = /"((?:\\.|[^"])*)"|([^\s]+)/g;
    let match = matcher.exec(input);

    while (match) {
        output.push((match[1] ?? match[2] ?? '').replace(/\\([\\"])/g, '$1'));
        match = matcher.exec(input);
    }

    return output;
}

function gmailLabels(line) {
    const match = line.match(/X-GM-LABELS\s+\(([^)]*)\)/i);
    return parseImapList(match?.[1]).map((label) => {
        const system = label.match(/^\\(.+)$/)?.[1];
        return system ? system.toUpperCase() : label;
    });
}

function imapFlags(line) {
    const match = line.match(/FLAGS\s+\(([^)]*)\)/i);
    return parseImapList(match?.[1]).map((flag) => flag.replace(/^\\/, '').toUpperCase());
}

function fetchGroups(records) {
    const groups = [];
    let current = null;

    for (const record of records) {
        if (/^\*\s+\d+\s+FETCH\b/i.test(record.line)) {
            current = { lines: [], literals: [] };
            groups.push(current);
        }

        if (!current)
            continue;

        current.lines.push(record.line);
        if (record.literal)
            current.literals.push(record.literal);
    }

    return groups;
}

export function normalizeGmailNumericId(value) {
    const raw = String(value ?? '').trim().replace(/^(?:msg|thread|uid):/i, '');

    if (/^\d+$/.test(raw))
        return raw;
    if (/^[0-9a-f]+$/i.test(raw)) {
        try {
            return BigInt(`0x${raw}`).toString(10);
        } catch (_error) {
            return '';
        }
    }

    return '';
}

export function parseImapFetchRecords(records, { requestedBytes = SEARCH_PREVIEW_BYTES } = {}) {
    return fetchGroups(records).map((group) => {
        const line = group.lines.join(' ');
        const uid = line.match(/\bUID\s+(\d+)/i)?.[1] ?? '';
        const messageId = line.match(/\bX-GM-MSGID\s+(\d+)/i)?.[1] ?? '';
        const threadId = line.match(/\bX-GM-THRID\s+(\d+)/i)?.[1] ?? '';
        const internalDate = line.match(/\bINTERNALDATE\s+"([^"]+)"/i)?.[1] ?? '';
        const rawBytes = group.literals[0] ?? new Uint8Array();
        const rawText = decodeBytes(rawBytes);
        const { headerText } = splitMessage(rawText);
        const headers = headerMap(headerText);
        const mime = collectMimeParts(rawText);
        const body = mime.plain.find(Boolean) || mime.html.find(Boolean) || '';
        const boundedBody = body.length > MAX_BODY_CHARS
            ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[Body truncated by Cusco]`
            : body;

        return {
            id: messageId,
            thread_id: threadId,
            imap_uid: uid,
            from: decodeEncodedWords(firstHeader(headers, 'from')),
            to: decodeEncodedWords(firstHeader(headers, 'to')),
            cc: decodeEncodedWords(firstHeader(headers, 'cc')),
            subject: decodeEncodedWords(firstHeader(headers, 'subject')) || '(no subject)',
            date: firstHeader(headers, 'date'),
            received_at: internalDate,
            snippet: boundedBody.replace(/\s+/g, ' ').trim().slice(0, 500),
            labels: gmailLabels(line),
            flags: imapFlags(line),
            body: boundedBody,
            attachments: mime.attachments,
            truncated: requestedBytes > 0 && rawBytes.length >= requestedBytes,
        };
    }).filter((message) => message.id && message.imap_uid);
}

function searchQueryWithTags(input) {
    const query = String(input.query ?? input.q ?? '').trim();
    const tags = stringList(input.tags ?? input.label_ids ?? input.labelIds)
        .map((tag) => `label:${tag}`);
    return [query, ...tags].filter(Boolean).join(' ');
}

export class GmailImapClient {
    constructor(options = {}) {
        this._sessionFactory = options.sessionFactory ?? ((account, token, sessionOptions) => (
            new ImapSession(account, token, sessionOptions)
        ));
    }

    async _withSession(account, accessToken, options, operation) {
        const session = this._sessionFactory(account, accessToken, options);

        try {
            await session.connect();
            return await operation(session);
        } finally {
            session.close();
        }
    }

    async verify(account, accessToken, options = {}) {
        return await this._withSession(account, accessToken, options, async () => true);
    }

    async _searchPage(session, input) {
        const maxResults = boundedInteger(
            input.max_results ?? input.maxResults,
            DEFAULT_SEARCH_RESULTS,
            MAX_SEARCH_RESULTS,
        );
        const beforeUid = Number.parseInt(input.next_page_token ?? input.pageToken ?? 0, 10);
        const matching = await session.search(
            searchQueryWithTags(input),
            Number.isFinite(beforeUid) ? beforeUid : 0,
        );
        const descending = [...new Set(matching)].sort((left, right) => right - left);
        const selected = descending.slice(0, maxResults);

        return {
            selected,
            nextPageToken: descending.length > maxResults
                ? String(selected[selected.length - 1])
                : '',
            resultSizeEstimate: descending.length,
        };
    }

    async searchEmailIds(account, accessToken, input = {}, options = {}) {
        return await this._withSession(account, accessToken, options, async (session) => {
            const page = await this._searchPage(session, input);
            const messages = await session.fetch(page.selected, 0);
            const byUid = new Map(messages.map((message) => [Number(message.imap_uid), message]));
            return {
                message_ids: page.selected.map((uid) => byUid.get(uid)?.id).filter(Boolean),
                next_page_token: page.nextPageToken,
                result_size_estimate: page.resultSizeEstimate,
            };
        });
    }

    async searchEmails(account, accessToken, input = {}, options = {}) {
        return await this._withSession(account, accessToken, options, async (session) => {
            const page = await this._searchPage(session, input);
            const fetched = await session.fetch(page.selected, SEARCH_PREVIEW_BYTES);
            const byUid = new Map(fetched.map((message) => [Number(message.imap_uid), message]));
            const messages = page.selected.map((uid) => byUid.get(uid)).filter(Boolean).map((message) => {
                const { body: _body, attachments: _attachments, ...summary } = message;
                return summary;
            });
            return {
                messages,
                message_ids: messages.map((message) => message.id),
                next_page_token: page.nextPageToken,
                result_size_estimate: page.resultSizeEstimate,
            };
        });
    }

    async readLatestEmail(account, accessToken, input = {}, options = {}) {
        return await this._withSession(account, accessToken, options, async (session) => {
            const page = await this._searchPage(session, {
                ...input,
                query: String(input.query ?? input.q ?? '').trim() || 'in:inbox',
                max_results: 1,
            });
            const messages = await session.fetch(page.selected, READ_PREVIEW_BYTES);
            const byUid = new Map(messages.map((message) => [Number(message.imap_uid), message]));

            return {
                message: page.selected.length > 0
                    ? byUid.get(page.selected[0]) ?? null
                    : null,
                result_size_estimate: page.resultSizeEstimate,
            };
        });
    }

    async batchReadEmail(account, accessToken, input = {}, options = {}) {
        const rawIds = input.message_ids ?? input.email_ids ?? input.ids ?? [];
        const ids = stringList(Array.isArray(rawIds) ? rawIds : [rawIds])
            .slice(0, MAX_BATCH_MESSAGES);

        if (ids.length === 0)
            throw userVisibleError('batch_read_email requires at least one message ID.');

        return await this._withSession(account, accessToken, options, async (session) => {
            const uids = [];

            for (const id of ids) {
                const normalized = normalizeGmailNumericId(id);

                if (!normalized)
                    throw userVisibleError(`Invalid Gmail message ID: ${id}`);
                uids.push(...await session.searchMessageId(normalized));
            }

            return { messages: await session.fetch([...new Set(uids)], READ_PREVIEW_BYTES) };
        });
    }

    async readEmailThread(account, accessToken, input = {}, options = {}) {
        const id = String(input.id ?? input.message_id ?? input.thread_id ?? '').trim();
        const idType = String(input.id_type ?? 'message').trim().toLowerCase();
        const normalizedId = normalizeGmailNumericId(id);

        if (!normalizedId)
            throw userVisibleError('read_email_thread requires a valid Gmail message or thread ID.');
        if (idType !== 'message' && idType !== 'thread')
            throw userVisibleError('id_type must be either "message" or "thread".');

        return await this._withSession(account, accessToken, options, async (session) => {
            let threadId = normalizedId;

            if (idType === 'message') {
                const messageUids = await session.searchMessageId(normalizedId);
                const message = (await session.fetch(messageUids.slice(0, 1), 0))[0];

                if (!message)
                    throw userVisibleError('That Gmail message was not found.');
                threadId = message.thread_id;
            }

            const allUids = await session.searchThreadId(threadId);
            const selectedUids = allUids
                .sort((left, right) => left - right)
                .slice(-MAX_THREAD_MESSAGES);
            const messages = await session.fetch(selectedUids, READ_PREVIEW_BYTES);
            const byUid = new Map(messages.map((message) => [Number(message.imap_uid), message]));

            return {
                id: threadId,
                total_messages: allUids.length,
                messages_returned: selectedUids.length,
                messages: selectedUids.map((uid) => byUid.get(uid)).filter(Boolean),
            };
        });
    }
}
