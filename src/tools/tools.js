import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import { normalizePermissionPolicy, TOOL_PERMISSION_ALLOW, TOOL_PERMISSION_ASK } from './permissions.js';

const DEFAULT_SEARCH_TIMEOUT_SECONDS = 15;
const DEFAULT_BASH_TIMEOUT_SECONDS = 300;
const MAX_BASH_TIMEOUT_SECONDS = 300;
const BASH_OUTPUT_NOTIFY_INTERVAL_MS = 100;
const BASH_OUTPUT_NOTIFY_MAX_CHARS = 8192;
const MAX_FILE_READ_BYTES = 120000;
const MAX_FILE_LIST_ITEMS = 200;
const MAX_TOOL_OUTPUT_CHARS = 60000;
const MAX_BASH_OUTPUT_CHARS = 40000;
const BASH_READ_CHUNK_BYTES = 4096;
const SUDO_AUTH_REQUIRED_PATTERNS = [
    'a password is required',
    'a terminal is required',
    'no tty present',
    'password is required',
];

const SENSITIVE_PATHS = [
    '.ssh',
    '.gnupg',
    '.local/share/keyrings',
    '.pki',
    '.mozilla',
    '.config/google-chrome',
    '.config/chromium',
];

const BUILT_IN_TOOLS = {
    calc: {
        name: 'calc',
        label: 'Calculator',
        description: 'Evaluate a basic arithmetic expression.',
        inputDescription: 'Arithmetic expression using numbers, parentheses, and +, -, *, /, or ^.',
        permissionPolicy: TOOL_PERMISSION_ALLOW,
        requiresPermission: false,
        concurrencySafe: true,
    },
    data: {
        name: 'data',
        label: 'Structured Data',
        description: 'Summarize JSON or CSV-like structured text.',
        inputDescription: 'Valid JSON or CSV-like text to summarize.',
        permissionPolicy: TOOL_PERMISSION_ALLOW,
        requiresPermission: false,
        concurrencySafe: true,
    },
    search: {
        name: 'search',
        label: 'Web Search',
        description: 'Search the web and return cited results. Models with native search use their provider; other models use built-in DuckDuckGo search or optional Exa Search.',
        inputDescription: 'A concise web search query.',
        permissionPolicy: TOOL_PERMISSION_ASK,
        requiresPermission: true,
        concurrencySafe: false,
    },
    file_list: {
        name: 'file_list',
        label: 'File List',
        description: 'List files in a local directory with type and size information.',
        inputDescription: 'A local directory path, such as ~/Documents or /tmp.',
        permissionPolicy: TOOL_PERMISSION_ASK,
        requiresPermission: true,
        concurrencySafe: true,
    },
    file_read: {
        name: 'file_read',
        label: 'File Read',
        description: 'Read a bounded local text file.',
        inputDescription: `A local file path. Files larger than ${MAX_FILE_READ_BYTES} bytes are rejected.`,
        permissionPolicy: TOOL_PERMISSION_ASK,
        requiresPermission: true,
        concurrencySafe: true,
    },
    bash: {
        name: 'bash',
        label: 'Bash',
        description: 'Run a shell command for up to five minutes with bounded, live output.',
        inputDescription: 'A shell command to execute through bash -lc.',
        permissionPolicy: TOOL_PERMISSION_ASK,
        requiresPermission: true,
        concurrencySafe: false,
    },
};

function userVisibleError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
}

function truncateText(text, maxChars = MAX_TOOL_OUTPUT_CHARS) {
    const source = String(text ?? '');

    if (source.length <= maxChars)
        return {
            text: source,
            truncated: false,
        };

    return {
        text: `${source.slice(0, maxChars)}\n\n[Output truncated after ${maxChars} characters.]`,
        truncated: true,
    };
}

function normalizeLocalPath(path) {
    const text = String(path ?? '').trim();

    if (!text)
        throw userVisibleError('Path cannot be empty.');

    const expandedPath = text === '~' || text.startsWith('~/')
        ? GLib.build_filenamev([GLib.get_home_dir(), text.slice(2)])
        : text;

    return GLib.canonicalize_filename(expandedPath, null);
}

function assertPathIsNotSensitive(path) {
    const home = GLib.canonicalize_filename(GLib.get_home_dir(), null);

    if (!path.startsWith(`${home}/`))
        return;

    const relativePath = path.slice(home.length + 1);

    for (const sensitivePath of SENSITIVE_PATHS) {
        if (relativePath === sensitivePath || relativePath.startsWith(`${sensitivePath}/`))
            throw userVisibleError(`Access to ${sensitivePath} is blocked by Cusco's file safety policy.`);
    }
}

function queryFileInfo(path, attributes) {
    const file = Gio.File.new_for_path(path);

    if (!file.query_exists(null))
        throw userVisibleError(`Path does not exist: ${path}`);

    return {
        file,
        info: file.query_info(attributes, Gio.FileQueryInfoFlags.NONE, null),
    };
}

function sendAndRead(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
            try {
                resolve(session.send_and_read_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function tokenizeExpression(expression) {
    const tokens = [];
    const source = String(expression ?? '');
    let index = 0;

    while (index < source.length) {
        const char = source[index];

        if (/\s/.test(char)) {
            index++;
            continue;
        }

        if (/[+\-*/^()]/.test(char)) {
            tokens.push(char);
            index++;
            continue;
        }

        if (/\d|\./.test(char)) {
            let value = '';

            while (index < source.length && /[\d.]/.test(source[index])) {
                value += source[index];
                index++;
            }

            if (!/^\d+(?:\.\d+)?$|^\.\d+$/.test(value))
                throw userVisibleError('The calculator expression contains an invalid number.');

            tokens.push(Number(value));
            continue;
        }

        throw userVisibleError(`The calculator expression contains an unsupported character: ${char}`);
    }

    return tokens;
}

function createExpressionParser(tokens) {
    let index = 0;

    const peek = () => tokens[index];
    const consume = () => tokens[index++];

    const parsePrimary = () => {
        const token = consume();

        if (typeof token === 'number')
            return token;

        if (token === '-') {
            return -parsePrimary();
        }

        if (token === '(') {
            const value = parseExpression();

            if (consume() !== ')')
                throw userVisibleError('The calculator expression has mismatched parentheses.');

            return value;
        }

        throw userVisibleError('The calculator expression is incomplete.');
    };

    const parsePower = () => {
        let value = parsePrimary();

        while (peek() === '^') {
            consume();
            value = value ** parsePrimary();
        }

        return value;
    };

    const parseTerm = () => {
        let value = parsePower();

        while (peek() === '*' || peek() === '/') {
            const operator = consume();
            const right = parsePower();

            if (operator === '*')
                value *= right;
            else
                value /= right;
        }

        return value;
    };

    const parseExpression = () => {
        let value = parseTerm();

        while (peek() === '+' || peek() === '-') {
            const operator = consume();
            const right = parseTerm();

            if (operator === '+')
                value += right;
            else
                value -= right;
        }

        return value;
    };

    return {
        parse() {
            const value = parseExpression();

            if (index < tokens.length)
                throw userVisibleError('The calculator expression has trailing input.');

            if (!Number.isFinite(value))
                throw userVisibleError('The calculator result is not finite.');

            return value;
        },
    };
}

export function calculateExpression(expression) {
    return createExpressionParser(tokenizeExpression(expression)).parse();
}

function summarizeJson(value) {
    if (Array.isArray(value)) {
        const keys = new Set();

        for (const item of value) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                for (const key of Object.keys(item))
                    keys.add(key);
            }
        }

        return `JSON array with ${value.length} items${keys.size > 0 ? ` and fields: ${[...keys].join(', ')}` : ''}.`;
    }

    if (value && typeof value === 'object')
        return `JSON object with ${Object.keys(value).length} keys: ${Object.keys(value).join(', ')}.`;

    return `JSON ${typeof value}: ${String(value)}.`;
}

function summarizeCsv(text) {
    const rows = String(text).trim().split(/\r?\n/).filter(Boolean);

    if (rows.length === 0)
        throw userVisibleError('The structured data input is empty.');

    const headers = rows[0].split(',').map((item) => item.trim()).filter(Boolean);
    return `CSV-like data with ${Math.max(0, rows.length - 1)} rows and ${headers.length} columns: ${headers.join(', ')}.`;
}

export function summarizeStructuredData(input) {
    const text = String(input ?? '').trim();

    if (!text)
        throw userVisibleError('The structured data input is empty.');

    try {
        return summarizeJson(JSON.parse(text));
    } catch (_error) {
        if (text.includes(',') && text.includes('\n'))
            return summarizeCsv(text);
    }

    throw userVisibleError('Structured data must be valid JSON or CSV-like text.');
}

export function extractExaSearchResults(response) {
    const results = Array.isArray(response?.results)
        ? response.results.map((result) => {
            const highlights = Array.isArray(result?.highlights)
                ? result.highlights.filter(Boolean).join(' … ')
                : '';
            const snippet = htmlText(
                highlights
                || result?.summary
                || result?.text
                || result?.author
                || '',
            ).slice(0, 800);

            return {
                title: String(result?.title ?? result?.url ?? '').trim(),
                url: String(result?.url ?? '').trim(),
                snippet,
                ...(result?.publishedDate
                    ? { publishedAt: String(result.publishedDate) }
                    : {}),
            };
        })
        : [];

    const seenUrls = new Set();
    return results.filter((result) => {
        if (!result.url || seenUrls.has(result.url))
            return false;

        seenUrls.add(result.url);
        return true;
    }).slice(0, 5);
}

async function fetchText(url, {
    timeoutSeconds = DEFAULT_SEARCH_TIMEOUT_SECONDS,
    cancellable = null,
    headers = {},
    method = 'GET',
    body = null,
    serviceName = 'Search service',
    statusMessages = {},
    unavailableMessage = '',
} = {}) {
    const session = new Soup.Session({
        timeout: timeoutSeconds,
    });
    const message = Soup.Message.new(method, url);

    for (const [name, value] of Object.entries(headers))
        message.request_headers.append(name, value);

    if (body !== null) {
        const requestBody = typeof body === 'string'
            ? body
            : JSON.stringify(body);
        const bytes = new GLib.Bytes(new TextEncoder().encode(requestBody));
        message.set_request_body_from_bytes('application/json', bytes);
    }

    let bytes;

    try {
        bytes = await sendAndRead(session, message, cancellable);
    } catch (error) {
        if (cancellable?.is_cancelled?.())
            throw error;

        throw userVisibleError(unavailableMessage || `${serviceName} could not be reached.`);
    }

    const status = message.get_status();

    if (statusMessages[status])
        throw userVisibleError(statusMessages[status]);

    if (status === 429)
        throw userVisibleError(`${serviceName} rate limit exceeded. Try again later.`);

    if (status < 200 || status >= 300)
        throw userVisibleError(`${serviceName} failed with HTTP ${status}.`);

    return new TextDecoder().decode(bytes.get_data());
}

async function fetchJson(url, options = {}) {
    const serviceName = options.serviceName ?? 'Search service';
    const text = await fetchText(url, options);

    try {
        return JSON.parse(text);
    } catch (_error) {
        throw userVisibleError(`${serviceName} returned an invalid JSON response.`);
    }
}

function appendQueryParameters(endpoint, parameters) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const query = Object.entries(parameters)
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .join('&');

    return `${endpoint}${separator}${query}`;
}

const HTML_ENTITIES = {
    amp: '&',
    apos: '\'',
    gt: '>',
    hellip: '…',
    ldquo: '“',
    lsquo: '‘',
    lt: '<',
    mdash: '—',
    nbsp: ' ',
    ndash: '–',
    quot: '"',
    rdquo: '”',
    rsquo: '’',
};

function decodeHtmlEntities(value) {
    return String(value ?? '').replace(
        /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
        (entityText, entity) => {
            if (entity.startsWith('#')) {
                const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10;
                const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
                const codePoint = Number.parseInt(digits, radix);

                if (Number.isInteger(codePoint)
                    && codePoint > 0
                    && codePoint <= 0x10ffff) {
                    return String.fromCodePoint(codePoint);
                }
            }

            return HTML_ENTITIES[entity.toLowerCase()] ?? entityText;
        },
    );
}

function htmlText(value) {
    return decodeHtmlEntities(String(value ?? '').replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function htmlAttribute(attributes, name) {
    const match = String(attributes ?? '').match(
        new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'),
    );

    return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? '');
}

function anchorByClass(html, className) {
    const anchors = String(html ?? '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);

    for (const anchor of anchors) {
        const classes = htmlAttribute(anchor[1], 'class').split(/\s+/);

        if (!classes.includes(className))
            continue;

        return {
            href: htmlAttribute(anchor[1], 'href'),
            text: htmlText(anchor[2]),
        };
    }

    return null;
}

function decodedDuckDuckGoResultUrl(href) {
    let url = decodeHtmlEntities(href);

    if (url.startsWith('//'))
        url = `https:${url}`;
    else if (url.startsWith('/'))
        url = `https://html.duckduckgo.com${url}`;

    let uri;

    try {
        uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch (_error) {
        return '';
    }

    const host = uri.get_host()?.toLowerCase() ?? '';

    if ((host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com'))
        && uri.get_path() === '/l/') {
        for (const pair of String(uri.get_query() ?? '').split('&')) {
            const [rawName, ...rawValueParts] = pair.split('=');

            if (rawName !== 'uddg')
                continue;

            try {
                url = GLib.uri_unescape_string(
                    rawValueParts.join('=').replace(/\+/g, '%20'),
                    null,
                ) ?? '';
            } catch (_error) {
                return '';
            }
            break;
        }
    }

    try {
        const resultUri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        const scheme = resultUri.get_scheme()?.toLowerCase();

        return resultUri.get_host() && (scheme === 'http' || scheme === 'https')
            ? url
            : '';
    } catch (_error) {
        return '';
    }
}

export function extractDuckDuckGoSearchResults(html) {
    const parts = String(html ?? '').split(
        /(<div\b[^>]*class=(?:"[^"]*\bresults_links\b[^"]*"|'[^']*\bresults_links\b[^']*')[^>]*>)/gi,
    );
    const results = [];
    const seenUrls = new Set();

    for (let index = 1; index < parts.length && results.length < 5; index += 2) {
        const openingTag = parts[index];
        const body = parts[index + 1] ?? '';
        const titleLink = anchorByClass(body, 'result__a');
        const snippetLink = anchorByClass(body, 'result__snippet');
        const url = decodedDuckDuckGoResultUrl(titleLink?.href);

        if (!titleLink?.text || !url || seenUrls.has(url))
            continue;

        const sponsored = /result--ad|badge--ad|result__badge|\bsponsored\b/i
            .test(`${openingTag}${body.slice(0, 1200)}`);

        seenUrls.add(url);
        results.push({
            title: sponsored ? `Sponsored: ${titleLink.text}` : titleLink.text,
            url,
            snippet: snippetLink?.text ?? '',
            ...(sponsored ? { sponsored: true } : {}),
        });
    }

    return results;
}

export async function searchWeb(query, options = {}) {
    const normalizedQuery = String(query ?? '').trim();

    if (!normalizedQuery)
        throw userVisibleError('Search query cannot be empty.');

    const providerId = String(options.searchProviderId ?? options.id ?? 'duckduckgo').trim();

    if (providerId === 'duckduckgo') {
        const url = appendQueryParameters('https://html.duckduckgo.com/html/', {
            q: normalizedQuery,
            kp: '-1',
            k1: '1',
            t: 'cusco',
        });
        const html = await (options.fetcher ?? fetchText)(url, {
            ...options,
            serviceName: 'DuckDuckGo',
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent': 'Cusco desktop search',
            },
            unavailableMessage: 'DuckDuckGo could not be reached. Check the internet connection and try again.',
        });
        const results = extractDuckDuckGoSearchResults(html);

        if (results.length === 0
            && !/no results|result--no-result|no-results/i.test(html)) {
            throw userVisibleError('DuckDuckGo returned a search page Cusco could not read. Try again later or select Exa Search in Settings.');
        }

        return {
            query: normalizedQuery,
            results,
            providerId,
            providerName: 'DuckDuckGo',
        };
    }

    if (providerId === 'exa-search') {
        const apiKey = String(options.apiKey ?? GLib.getenv('EXA_API_KEY') ?? '').trim();

        if (!apiKey)
            throw userVisibleError('Configure Exa Search credentials in Settings before searching.');

        const response = await (options.fetcher ?? fetchJson)('https://api.exa.ai/search', {
            ...options,
            method: 'POST',
            body: {
                query: normalizedQuery,
                type: 'auto',
                numResults: 5,
                contents: {
                    highlights: {
                        maxCharacters: 500,
                        query: normalizedQuery,
                    },
                },
            },
            serviceName: 'Exa Search',
            headers: {
                Accept: 'application/json',
                'x-api-key': apiKey,
            },
            statusMessages: {
                401: 'Exa Search rejected the configured API key.',
                402: 'Exa Search has no available credits. Check the Exa dashboard or switch to DuckDuckGo.',
                403: 'Exa Search rejected the configured API key.',
            },
        });

        return {
            query: normalizedQuery,
            results: extractExaSearchResults(response),
            providerId,
            providerName: 'Exa Search',
        };
    }

    throw userVisibleError(`Unsupported web search provider: ${providerId}`);
}

export function listLocalDirectory(path) {
    const normalizedPath = normalizeLocalPath(path);
    assertPathIsNotSensitive(normalizedPath);

    const { file, info } = queryFileInfo(normalizedPath, 'standard::type');

    if (info.get_file_type() !== Gio.FileType.DIRECTORY)
        throw userVisibleError(`Path is not a directory: ${normalizedPath}`);

    const enumerator = file.enumerate_children(
        'standard::name,standard::type,standard::size',
        Gio.FileQueryInfoFlags.NONE,
        null,
    );
    const entries = [];
    let truncated = false;

    try {
        let childInfo = enumerator.next_file(null);

        while (childInfo) {
            if (entries.length >= MAX_FILE_LIST_ITEMS) {
                truncated = true;
                break;
            }

            entries.push({
                name: childInfo.get_name(),
                type: childInfo.get_file_type() === Gio.FileType.DIRECTORY ? 'directory' : 'file',
                size: Number(childInfo.get_size()),
            });
            childInfo = enumerator.next_file(null);
        }
    } finally {
        enumerator.close(null);
    }

    entries.sort((left, right) => (
        left.type === right.type
            ? left.name.localeCompare(right.name)
            : left.type === 'directory' ? -1 : 1
    ));

    const output = entries.length === 0
        ? 'Directory is empty.'
        : entries.map((entry) => (
            `${entry.type === 'directory' ? 'dir ' : 'file'}\t${entry.size}\t${entry.name}`
        )).join('\n');

    return {
        path: normalizedPath,
        entries,
        truncated,
        output: truncated
            ? `${output}\n\n[Listing truncated after ${MAX_FILE_LIST_ITEMS} entries.]`
            : output,
    };
}

export function readLocalTextFile(path) {
    const normalizedPath = normalizeLocalPath(path);
    assertPathIsNotSensitive(normalizedPath);

    const { info } = queryFileInfo(normalizedPath, 'standard::type,standard::size');

    if (info.get_file_type() !== Gio.FileType.REGULAR)
        throw userVisibleError(`Path is not a regular file: ${normalizedPath}`);

    const size = Number(info.get_size());

    if (size > MAX_FILE_READ_BYTES)
        throw userVisibleError(`File is too large to read safely (${size} bytes, limit ${MAX_FILE_READ_BYTES}).`);

    const [, contents] = GLib.file_get_contents(normalizedPath);
    const decoded = new TextDecoder().decode(contents);

    if (decoded.includes('\0'))
        throw userVisibleError('File appears to be binary and cannot be read as text.');
    const truncated = truncateText(decoded);

    return {
        path: normalizedPath,
        size,
        content: truncated.text,
        truncated: truncated.truncated,
        output: truncated.text,
    };
}

function bashProgram() {
    const path = GLib.find_program_in_path('bash');

    if (!path)
        throw userVisibleError('bash was not found in PATH.');

    return path;
}

function setsidProgram() {
    return GLib.find_program_in_path('setsid');
}

function killProgram() {
    return GLib.find_program_in_path('kill');
}

function sudoProgram() {
    return GLib.find_program_in_path('sudo');
}

export function commandUsesSudo(command) {
    return /(^|[\s;|&({])(?:sudo|(?:\/[^\s;|&(){}]+)*\/sudo)(?=$|[\s;|&)}])/.test(String(command ?? ''));
}

function sudoAuthRequired(output) {
    const normalized = String(output ?? '').toLowerCase();
    return SUDO_AUTH_REQUIRED_PATTERNS.some((pattern) => normalized.includes(pattern));
}

async function sudoNeedsPassword() {
    const path = sudoProgram();

    if (!path)
        return false;

    const subprocess = Gio.Subprocess.new(
        [path, '-n', '-v'],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    );
    const [, stdoutResult, stderrResult] = await Promise.all([
        waitForSubprocess(subprocess),
        readTextPipe(subprocess.get_stdout_pipe()),
        readTextPipe(subprocess.get_stderr_pipe()),
    ]);

    if (subprocess.get_if_exited() && subprocess.get_exit_status() === 0)
        return false;

    return sudoAuthRequired(`${stdoutResult.text}\n${stderrResult.text}`);
}

function writeSubprocessPassword(subprocess, password) {
    const stream = subprocess.get_stdin_pipe();

    if (!stream)
        return;

    stream.write_all(new TextEncoder().encode(`${password}\n`), null);

    try {
        stream.close(null);
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CLOSED))
            throw error;
    }
}

async function refreshSudoTimestamp(password) {
    const path = sudoProgram();

    if (!path)
        throw userVisibleError('sudo was not found in PATH.');

    const subprocess = Gio.Subprocess.new(
        [path, '-S', '-p', '', '-v'],
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    );
    writeSubprocessPassword(subprocess, password);

    const [, stdoutResult, stderrResult] = await Promise.all([
        waitForSubprocess(subprocess),
        readTextPipe(subprocess.get_stdout_pipe()),
        readTextPipe(subprocess.get_stderr_pipe()),
    ]);

    if (subprocess.get_if_exited() && subprocess.get_exit_status() === 0)
        return;

    const detail = [stdoutResult.text, stderrResult.text].filter(Boolean).join('\n').trim();
    throw userVisibleError(detail ? `Sudo authentication failed: ${detail}` : 'Sudo authentication failed.');
}

function bashCancelledResult(command) {
    return {
        command,
        exitStatus: 130,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        cancelled: true,
        output: formatBashOutput({
            exitStatus: 130,
            cancelled: true,
        }),
    };
}

function formatBashOutput(result) {
    return [
        `exit status: ${result.exitStatus}`,
        result.cancelled ? 'cancelled: true' : '',
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n\n');
}

function formatBashTranscript(result) {
    return [
        'Bash command',
        '```sh',
        result.command,
        '```',
        `Exit status: ${result.exitStatus}${result.timedOut ? ' (timed out)' : ''}${result.cancelled ? ' (cancelled)' : ''}`,
        result.stdout ? `\nstdout\n\`\`\`text\n${result.stdout}\n\`\`\`` : '',
        result.stderr ? `\nstderr\n\`\`\`text\n${result.stderr}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');
}

function createBoundedTextCollector(maxChars) {
    let text = '';
    let truncated = false;

    return {
        append(chunk) {
            const value = String(chunk ?? '');

            if (!value)
                return;

            const available = Math.max(0, maxChars - text.length);

            if (available > 0)
                text += value.slice(0, available);

            if (value.length > available)
                truncated = true;
        },
        result() {
            return {
                text: truncated
                    ? `${text}\n\n[Output truncated after ${maxChars} characters.]`
                    : text,
                truncated,
            };
        },
    };
}

function waitForSubprocess(subprocess) {
    return new Promise((resolve, reject) => {
        subprocess.wait_async(null, (_process, result) => {
            try {
                resolve(subprocess.wait_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function readTextPipe(stream, onChunk = null, cancellable = null) {
    const collector = createBoundedTextCollector(MAX_BASH_OUTPUT_CHARS);

    return new Promise((resolve, reject) => {
        const readNext = () => {
            stream.read_bytes_async(BASH_READ_CHUNK_BYTES, GLib.PRIORITY_LOW, cancellable, (source, result) => {
                try {
                    const bytes = source.read_bytes_finish(result);
                    const data = bytes.get_data();

                    if (!data || data.length === 0) {
                        resolve(collector.result());
                        return;
                    }

                    const text = new TextDecoder().decode(data);
                    collector.append(text);
                    onChunk?.(text);
                    readNext();
                } catch (error) {
                    if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        resolve(collector.result());
                    else
                        reject(error);
                }
            });
        };

        readNext();
    });
}

function notifyBashOutput(callback, stream, text) {
    if (!callback || !text)
        return;

    try {
        callback({ stream, text });
    } catch (_error) {
        // Output preview callbacks are best-effort UI updates; the command result is authoritative.
    }
}

function createBashOutputNotifier(callback) {
    const pending = {
        stdout: '',
        stderr: '',
    };
    let notifySourceId = 0;

    const flush = () => {
        notifySourceId = 0;

        for (const stream of ['stdout', 'stderr']) {
            const text = pending[stream];
            pending[stream] = '';
            notifyBashOutput(callback, stream, text);
        }
    };

    return {
        append(stream, text) {
            if (!callback || !text)
                return;

            const combined = `${pending[stream] ?? ''}${text}`;
            pending[stream] = combined.slice(-BASH_OUTPUT_NOTIFY_MAX_CHARS);

            if (notifySourceId)
                return;

            notifySourceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT_IDLE,
                BASH_OUTPUT_NOTIFY_INTERVAL_MS,
                () => {
                    flush();
                    return GLib.SOURCE_REMOVE;
                },
            );
        },
        finish() {
            if (notifySourceId) {
                GLib.source_remove(notifySourceId);
                notifySourceId = 0;
            }

            flush();
        },
    };
}

export function normalizeBashTimeoutSeconds(value) {
    const seconds = Number.isFinite(value)
        ? Math.round(value)
        : DEFAULT_BASH_TIMEOUT_SECONDS;

    return Math.min(MAX_BASH_TIMEOUT_SECONDS, Math.max(1, seconds));
}

function createBashSubprocess(command) {
    const bashPath = bashProgram();
    const setsidPath = setsidProgram();
    const argv = setsidPath
        ? [setsidPath, bashPath, '-lc', command]
        : [bashPath, '-lc', command];

    return {
        isolatedProcessGroup: Boolean(setsidPath),
        subprocess: Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        ),
    };
}

function terminateBashSubprocess(subprocess, isolatedProcessGroup) {
    const identifier = String(subprocess.get_identifier?.() ?? '');
    const killPath = killProgram();

    if (isolatedProcessGroup && killPath && /^\d+$/.test(identifier)) {
        try {
            Gio.Subprocess.new(
                [killPath, '-KILL', '--', `-${identifier}`],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
            );
            return;
        } catch (_error) {
            // Fall through to terminating the direct child when process-group cleanup is unavailable.
        }
    }

    subprocess.force_exit();
}

export async function runBashCommand(command, options = {}) {
    const normalizedCommand = String(command ?? '').trim();

    if (!normalizedCommand)
        throw userVisibleError('Bash command cannot be empty.');

    const timeoutSeconds = normalizeBashTimeoutSeconds(options.timeoutSeconds);
    const externalCancellable = options.cancellable ?? null;
    let externalCancelHandlerId = 0;
    let timedOut = false;
    let cancelled = Boolean(externalCancellable?.is_cancelled?.());
    const usesSudo = commandUsesSudo(normalizedCommand);

    if (cancelled)
        return bashCancelledResult(normalizedCommand);

    if (usesSudo && await sudoNeedsPassword()) {
        if (typeof options.requestSudoPassword !== 'function')
            throw userVisibleError('This command requires a sudo password, but Cusco cannot prompt for it here.');

        let sudoPassword = await options.requestSudoPassword(normalizedCommand);

        if (externalCancellable?.is_cancelled?.()) {
            cancelled = true;
            return bashCancelledResult(normalizedCommand);
        }

        if (!sudoPassword)
            throw userVisibleError('Sudo password was not provided.');

        await refreshSudoTimestamp(sudoPassword);
        sudoPassword = null;
    }

    const { subprocess, isolatedProcessGroup } = createBashSubprocess(normalizedCommand);
    const pipeCancellable = new Gio.Cancellable();
    const outputNotifier = createBashOutputNotifier(options.onOutput);
    let terminationRequested = false;

    const terminateSubprocess = () => {
        pipeCancellable.cancel();

        if (terminationRequested)
            return;

        terminationRequested = true;
        terminateBashSubprocess(subprocess, isolatedProcessGroup);
    };

    const cancelSubprocess = () => {
        cancelled = true;
        terminateSubprocess();
    };

    if (externalCancellable) {
        if (cancelled)
            cancelSubprocess();
        else
            externalCancelHandlerId = externalCancellable.connect(cancelSubprocess);
    }

    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
        timedOut = true;
        timeoutId = 0;
        terminateSubprocess();
        return GLib.SOURCE_REMOVE;
    });

    const stdoutPromise = readTextPipe(subprocess.get_stdout_pipe(), (text) => {
        outputNotifier.append('stdout', text);
    }, pipeCancellable);
    const stderrPromise = readTextPipe(subprocess.get_stderr_pipe(), (text) => {
        outputNotifier.append('stderr', text);
    }, pipeCancellable);

    try {
        const [, stdoutResult, stderrResult] = await Promise.all([
            waitForSubprocess(subprocess),
            stdoutPromise,
            stderrPromise,
        ]);
        const exitStatus = subprocess.get_if_exited() ? subprocess.get_exit_status() : 124;
        const normalizedExitStatus = cancelled ? 130 : timedOut ? 124 : exitStatus;

        return {
            command: normalizedCommand,
            exitStatus: normalizedExitStatus,
            stdout: stdoutResult.text,
            stderr: stderrResult.text,
            stdoutTruncated: stdoutResult.truncated,
            stderrTruncated: stderrResult.truncated,
            timedOut,
            cancelled,
            output: formatBashOutput({
                exitStatus: normalizedExitStatus,
                stdout: stdoutResult.text,
                stderr: stderrResult.text,
                cancelled,
            }),
        };
    } finally {
        outputNotifier.finish();

        if (timeoutId)
            GLib.source_remove(timeoutId);

        if (externalCancelHandlerId)
            externalCancellable.disconnect(externalCancelHandlerId);
    }
}

export function parseToolRequest(text) {
    const trimmed = String(text ?? '').trim();
    const match = trimmed.match(/^\/(calc|data|search|file_list|file_read|bash)\s+([\s\S]+)$/i);

    if (!match)
        return null;

    const [, toolName, input] = match;
    const normalizedToolName = toolName.toLowerCase();
    const tool = BUILT_IN_TOOLS[normalizedToolName];

    return {
        name: normalizedToolName,
        input: input.trim(),
        requiresPermission: tool.requiresPermission,
        permissionPolicy: tool.permissionPolicy,
        label: tool.label,
    };
}

export function formatToolResultForTranscript(result) {
    if (result.name === 'calc')
        return `Calculator result\n\n${result.input} = ${result.output}`;

    if (result.name === 'data')
        return `Structured data summary\n\n${result.output}`;

    if (result.name === 'search' || result.name === 'x_search') {
        const citations = result.results.map((item, index) => (
            `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`
        )).join('\n\n');
        const searchLabel = result.name === 'x_search' ? 'X search' : 'Web search';
        const providerLabel = result.providerName ? ` via ${result.providerName}` : '';

        return `${searchLabel} results for "${result.input}"${providerLabel}\n\n${citations || 'No cited results returned.'}`;
    }

    if (result.name === 'file_list')
        return `File list for ${result.path}\n\n${result.output}`;

    if (result.name === 'file_read')
        return [
            `File read: ${result.path}`,
            `${result.size} bytes${result.truncated ? ' (truncated)' : ''}`,
            '```text',
            result.content,
            '```',
        ].join('\n');

    if (result.name === 'bash')
        return formatBashTranscript(result);

    if (result.name === 'image_gen')
        return [
            `Generated image`,
            `Prompt: ${result.prompt ?? result.input ?? ''}`,
            `Provider: ${result.providerName ?? result.providerId ?? 'unknown'}`,
            `Model: ${result.modelId ?? 'unknown'}`,
            `Saved image: ${result.imagePath ?? 'unknown'}`,
        ].join('\n');

    return result.output;
}

export class ToolManager {
    constructor(options = {}) {
        this._registeredTools = new Map();
        this._searchConfig = options.searchConfig ?? (() => ({}));
    }

    registerTool(tool) {
        const name = String(tool?.name ?? '').trim();

        if (!name)
            throw userVisibleError('Plugin tool name cannot be empty.');

        if (typeof tool.run !== 'function')
            throw userVisibleError(`Plugin tool ${name} does not provide a run function.`);

        const permissionPolicy = normalizePermissionPolicy(tool.permissionPolicy, {
            requiresPermission: tool.requiresPermission !== false,
        });

        this._registeredTools.set(name, {
            label: tool.label ?? name,
            description: String(tool.description ?? '').trim(),
            inputDescription: String(tool.inputDescription ?? '').trim(),
            inputSchema: tool.inputSchema ?? null,
            permissionPolicy,
            requiresPermission: permissionPolicy === TOOL_PERMISSION_ASK,
            concurrencySafe: Boolean(tool.concurrencySafe),
            run: tool.run,
        });
    }

    unregisterTool(name) {
        this._registeredTools.delete(String(name ?? '').trim());
    }

    clearRegisteredTools(predicate = null) {
        for (const name of [...this._registeredTools.keys()]) {
            const tool = this.getTool(name);

            if (!predicate || predicate(tool))
                this._registeredTools.delete(name);
        }
    }

    listTools() {
        return [
            ...Object.values(BUILT_IN_TOOLS).map((tool) => ({ ...tool })),
            ...[...this._registeredTools.entries()].map(([name, tool]) => ({
                name,
                label: tool.label,
                description: tool.description,
                inputDescription: tool.inputDescription,
                inputSchema: tool.inputSchema,
                permissionPolicy: tool.permissionPolicy,
                requiresPermission: tool.requiresPermission,
                concurrencySafe: tool.concurrencySafe,
            })),
        ];
    }

    getTool(name) {
        const normalizedName = String(name ?? '').trim();

        if (Object.hasOwn(BUILT_IN_TOOLS, normalizedName))
            return { ...BUILT_IN_TOOLS[normalizedName] };

        const registeredTool = this._registeredTools.get(normalizedName);

        if (!registeredTool)
            return null;

        return {
            name: normalizedName,
            label: registeredTool.label,
            description: registeredTool.description,
            inputDescription: registeredTool.inputDescription,
            inputSchema: registeredTool.inputSchema,
            permissionPolicy: registeredTool.permissionPolicy,
            requiresPermission: registeredTool.requiresPermission,
            concurrencySafe: registeredTool.concurrencySafe,
        };
    }

    createRequest(name, input) {
        const tool = this.getTool(name);

        if (!tool)
            throw userVisibleError(`Unknown tool: ${name}`);

        return {
            name: tool.name,
            input: String(input ?? '').trim(),
            requiresPermission: tool.requiresPermission,
            permissionPolicy: tool.permissionPolicy,
            label: tool.label,
        };
    }

    parseRequest(text) {
        const builtInRequest = parseToolRequest(text);

        if (builtInRequest)
            return this.createRequest(builtInRequest.name, builtInRequest.input);

        const trimmed = String(text ?? '').trim();
        const match = trimmed.match(/^\/([A-Za-z0-9_.:-]+)\s*([\s\S]*)$/);

        if (!match || !this._registeredTools.has(match[1]))
            return null;

        return this.createRequest(match[1], match[2]);
    }

    async runRequest(request, options = {}) {
        if (this._registeredTools.has(request.name)) {
            const tool = this._registeredTools.get(request.name);
            const result = await tool.run(request.input, options);

            if (result && typeof result === 'object' && !Array.isArray(result)) {
                return {
                    ...result,
                    ...request,
                    output: typeof result.output === 'string'
                        ? result.output
                        : JSON.stringify(result, null, 2),
                };
            }

            return {
                ...request,
                output: typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2),
            };
        }

        switch (request.name) {
        case 'calc':
            return {
                ...request,
                output: String(calculateExpression(request.input)),
            };
        case 'data':
            return {
                ...request,
                output: summarizeStructuredData(request.input),
            };
        case 'search': {
            const searchConfig = typeof this._searchConfig === 'function'
                ? this._searchConfig()
                : this._searchConfig;

            return {
                ...request,
                ...(await searchWeb(request.input, {
                    ...(searchConfig ?? {}),
                    ...options,
                })),
            };
        }
        case 'file_list':
            return {
                ...request,
                ...listLocalDirectory(request.input),
            };
        case 'file_read':
            return {
                ...request,
                ...readLocalTextFile(request.input),
            };
        case 'bash':
            return {
                ...request,
                ...(await runBashCommand(request.input, options)),
            };
        default:
            throw userVisibleError(`Unknown tool: ${request.name}`);
        }
    }
}
