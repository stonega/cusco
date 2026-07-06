import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import { normalizePermissionPolicy, TOOL_PERMISSION_ALLOW, TOOL_PERMISSION_ASK } from './permissions.js';

const DEFAULT_SEARCH_TIMEOUT_SECONDS = 15;
const DEFAULT_BASH_TIMEOUT_SECONDS = 30;
const MAX_FILE_READ_BYTES = 120000;
const MAX_FILE_LIST_ITEMS = 200;
const MAX_TOOL_OUTPUT_CHARS = 60000;
const MAX_BASH_OUTPUT_CHARS = 40000;
const BASH_READ_CHUNK_BYTES = 4096;

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
        description: 'Search the web through DuckDuckGo and return cited results.',
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
        description: 'Run a shell command with timeout and bounded output.',
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

function flattenRelatedTopics(topics, output = []) {
    for (const topic of topics ?? []) {
        if (Array.isArray(topic.Topics)) {
            flattenRelatedTopics(topic.Topics, output);
            continue;
        }

        if (topic.FirstURL && topic.Text) {
            output.push({
                title: topic.Text.split(' - ')[0],
                url: topic.FirstURL,
                snippet: topic.Text,
            });
        }
    }

    return output;
}

export function extractSearchResults(response) {
    const results = [];

    if (response?.AbstractText && response?.AbstractURL) {
        results.push({
            title: response.Heading || response.AbstractSource || response.AbstractURL,
            url: response.AbstractURL,
            snippet: response.AbstractText,
        });
    }

    for (const relatedTopic of flattenRelatedTopics(response?.RelatedTopics))
        results.push(relatedTopic);

    const seenUrls = new Set();
    return results.filter((result) => {
        if (!result.url || seenUrls.has(result.url))
            return false;

        seenUrls.add(result.url);
        return true;
    }).slice(0, 5);
}

async function fetchJson(url, { timeoutSeconds = DEFAULT_SEARCH_TIMEOUT_SECONDS, cancellable = null } = {}) {
    const session = new Soup.Session({
        timeout: timeoutSeconds,
    });
    const message = Soup.Message.new('GET', url);
    const bytes = await sendAndRead(session, message, cancellable);
    const text = new TextDecoder().decode(bytes.get_data());
    const status = message.get_status();

    if (status < 200 || status >= 300)
        throw userVisibleError(`Web search failed with HTTP ${status}.`);

    return JSON.parse(text);
}

export async function searchWeb(query, options = {}) {
    const normalizedQuery = String(query ?? '').trim();

    if (!normalizedQuery)
        throw userVisibleError('Search query cannot be empty.');

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(normalizedQuery)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetchJson(url, options);
    const results = extractSearchResults(response);

    return {
        query: normalizedQuery,
        results,
    };
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

function readTextPipe(stream, onChunk = null) {
    const collector = createBoundedTextCollector(MAX_BASH_OUTPUT_CHARS);

    return new Promise((resolve, reject) => {
        const readNext = () => {
            stream.read_bytes_async(BASH_READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null, (source, result) => {
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

export async function runBashCommand(command, options = {}) {
    const normalizedCommand = String(command ?? '').trim();

    if (!normalizedCommand)
        throw userVisibleError('Bash command cannot be empty.');

    const timeoutSeconds = Math.min(
        DEFAULT_BASH_TIMEOUT_SECONDS,
        Math.max(1, Math.round(options.timeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS)),
    );
    const externalCancellable = options.cancellable ?? null;
    let externalCancelHandlerId = 0;
    let timedOut = false;
    let cancelled = Boolean(externalCancellable?.is_cancelled?.());
    const subprocess = Gio.Subprocess.new(
        [bashProgram(), '-lc', normalizedCommand],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    );

    const cancelSubprocess = () => {
        cancelled = true;
        subprocess.force_exit();
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
        subprocess.force_exit();
        return GLib.SOURCE_REMOVE;
    });

    const stdoutPromise = readTextPipe(subprocess.get_stdout_pipe(), (text) => {
        notifyBashOutput(options.onOutput, 'stdout', text);
    });
    const stderrPromise = readTextPipe(subprocess.get_stderr_pipe(), (text) => {
        notifyBashOutput(options.onOutput, 'stderr', text);
    });

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
            output: [
                `exit status: ${normalizedExitStatus}`,
                cancelled ? 'cancelled: true' : '',
                stdoutResult.text ? `stdout:\n${stdoutResult.text}` : 'stdout: <empty>',
                stderrResult.text ? `stderr:\n${stderrResult.text}` : 'stderr: <empty>',
            ].filter(Boolean).join('\n\n'),
        };
    } finally {
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

    if (result.name === 'search') {
        const citations = result.results.map((item, index) => (
            `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`
        )).join('\n\n');

        return `Web search results for "${result.input}"\n\n${citations || 'No cited results returned.'}`;
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
        return [
            `Bash command`,
            '```sh',
            result.command,
            '```',
            `Exit status: ${result.exitStatus}${result.timedOut ? ' (timed out)' : ''}${result.cancelled ? ' (cancelled)' : ''}`,
            result.stdout ? `\nstdout\n\`\`\`text\n${result.stdout}\n\`\`\`` : '\nstdout: <empty>',
            result.stderr ? `\nstderr\n\`\`\`text\n${result.stderr}\n\`\`\`` : '\nstderr: <empty>',
        ].join('\n');

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
    constructor() {
        this._registeredTools = new Map();
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
        case 'search':
            return {
                ...request,
                ...(await searchWeb(request.input, options)),
            };
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
