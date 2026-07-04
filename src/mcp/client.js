import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import {
    MCP_PROTOCOL_VERSION,
    MCP_TRANSPORT_HTTP,
    MCP_TRANSPORT_STDIO,
} from './config.js';
import {
    createMcpAuthRequiredError,
    isMcpAuthRequiredStatus,
} from './auth.js';

const DEFAULT_MCP_TIMEOUT_SECONDS = 30;

function createUserVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isCancelled(cancellable) {
    return Boolean(cancellable?.is_cancelled?.());
}

function encodeJsonBody(body) {
    return new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)));
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

function isLoopbackHost(host) {
    return host === 'localhost'
        || host === '::1'
        || host === '127.0.0.1'
        || host?.startsWith('127.');
}

function shouldBypassProxy(url) {
    try {
        return isLoopbackHost(GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host());
    } catch (_error) {
        return false;
    }
}

function createHttpSession(url, timeoutSeconds) {
    const options = { timeout: timeoutSeconds };

    if (shouldBypassProxy(url))
        options.proxy_resolver = new Gio.SimpleProxyResolver({ default_proxy: null });

    return new Soup.Session(options);
}

function responseHeader(message, name) {
    try {
        return message.response_headers?.get_one?.(name)
            ?? message.get_response_headers?.()?.get_one?.(name)
            ?? '';
    } catch (_error) {
        return '';
    }
}

function hasHeader(headers, name) {
    const normalizedName = String(name ?? '').toLowerCase();

    return Object.keys(headers ?? {}).some((headerName) => headerName.toLowerCase() === normalizedName);
}

function rootToMcpRoot(root) {
    const text = String(root ?? '').trim();

    if (!text)
        return null;

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
        return { uri: text, name: text };

    try {
        const path = text === '~' || text.startsWith('~/')
            ? GLib.build_filenamev([GLib.get_home_dir(), text.slice(2)])
            : text;
        return {
            uri: GLib.filename_to_uri(GLib.canonicalize_filename(path, null), null),
            name: GLib.path_get_basename(path),
        };
    } catch (_error) {
        return { uri: text, name: text };
    }
}

function jsonRpcError(message, fallback = 'MCP request failed.') {
    const details = message?.error?.message ?? fallback;
    const error = createUserVisibleError(details, details);
    error.code = message?.error?.code;
    error.data = message?.error?.data;
    return error;
}

function parseHttpJsonRpcResponse(responseText) {
    try {
        return JSON.parse(responseText);
    } catch (_error) {
        const eventData = [];

        for (const line of responseText.split(/\r?\n/)) {
            if (line.startsWith('data:'))
                eventData.push(line.slice(5).trimStart());
        }

        for (const data of eventData) {
            if (!data || data === '[DONE]')
                continue;

            try {
                return JSON.parse(data);
            } catch (_error) {
            }
        }
    }

    throw createUserVisibleError('MCP server returned a non-JSON response.');
}

class McpJsonRpcSession {
    constructor(config) {
        this.config = config;
        this._nextId = 1;
        this._pending = new Map();
        this._closed = false;
    }

    request(method, params = {}, options = {}) {
        if (this._closed)
            throw createUserVisibleError(`${this.config.name} is not connected.`);

        const id = this._nextId++;
        const timeoutSeconds = Math.max(1, Math.round(
            options.timeoutSeconds ?? DEFAULT_MCP_TIMEOUT_SECONDS,
        ));
        const cancellable = options.cancellable ?? null;
        const payload = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        return new Promise((resolve, reject) => {
            let timeoutId = 0;
            let cancelHandlerId = 0;

            const cleanup = () => {
                if (timeoutId)
                    GLib.source_remove(timeoutId);

                if (cancelHandlerId)
                    cancellable.disconnect(cancelHandlerId);
            };

            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
                timeoutId = 0;
                this._pending.delete(id);
                reject(createUserVisibleError(
                    `${this.config.name} did not answer ${method} within ${timeoutSeconds} seconds.`,
                ));
                return GLib.SOURCE_REMOVE;
            });

            if (cancellable) {
                cancelHandlerId = cancellable.connect(() => {
                    this._pending.delete(id);
                    cleanup();
                    reject(createUserVisibleError(`${this.config.name} request was cancelled.`));
                });
            }

            this._pending.set(id, {
                resolve: (value) => {
                    cleanup();
                    resolve(value);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
            });

            try {
                this._send(payload, options);
            } catch (error) {
                this._pending.delete(id);
                cleanup();
                reject(error);
            }
        });
    }

    notification(method, params = {}, options = {}) {
        if (this._closed)
            return;

        this._send({
            jsonrpc: '2.0',
            method,
            params,
        }, options);
    }

    close() {
        this._closed = true;
        this._rejectAll(createUserVisibleError(`${this.config.name} connection closed.`));
    }

    _rejectAll(error) {
        for (const pending of this._pending.values())
            pending.reject(error);

        this._pending.clear();
    }

    _handleMessage(message) {
        if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
            const pending = this._pending.get(message.id);

            if (!pending)
                return;

            this._pending.delete(message.id);

            if (message.error)
                pending.reject(jsonRpcError(message));
            else
                pending.resolve(message.result ?? null);

            return;
        }

        if (Object.hasOwn(message, 'id') && message.method) {
            this._handleServerRequest(message);
            return;
        }

        this._handleNotification(message);
    }

    _handleServerRequest(message) {
        if (message.method === 'roots/list') {
            const roots = (this.config.roots ?? [])
                .map(rootToMcpRoot)
                .filter(Boolean);
            this._send({
                jsonrpc: '2.0',
                id: message.id,
                result: { roots },
            });
            return;
        }

        this._send({
            jsonrpc: '2.0',
            id: message.id,
            error: {
                code: -32601,
                message: `${message.method} is not supported by Cusco.`,
            },
        });
    }

    _handleNotification(_message) {
    }
}

class McpStdioSession extends McpJsonRpcSession {
    constructor(config) {
        super(config);
        this._process = null;
        this._input = null;
        this._output = null;
    }

    connect() {
        if (this._process)
            return;

        const argv = [this.config.command, ...(this.config.args ?? [])].filter(Boolean);

        if (!argv[0])
            throw createUserVisibleError(`${this.config.name} does not have a command configured.`);

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE
                | Gio.SubprocessFlags.STDOUT_PIPE
                | Gio.SubprocessFlags.STDERR_SILENCE,
        });

        if (this.config.cwd)
            launcher.set_cwd(this.config.cwd);

        for (const [name, value] of Object.entries(this.config.env ?? {}))
            launcher.setenv(name, value, true);

        this._process = launcher.spawnv(argv);
        this._input = new Gio.DataInputStream({
            base_stream: this._process.get_stdout_pipe(),
        });
        this._output = this._process.get_stdin_pipe();
        this._startReadLoop();
    }

    close() {
        super.close();

        try {
            this._output?.close(null);
        } catch (_error) {
        }

        try {
            this._process?.force_exit();
        } catch (_error) {
        }
    }

    _send(payload, _options = {}) {
        const line = `${JSON.stringify(payload)}\n`;
        const [ok] = this._output.write_all(new TextEncoder().encode(line), null);

        if (!ok)
            throw createUserVisibleError(`Failed to write to ${this.config.name}.`);
    }

    _startReadLoop() {
        const readNext = () => {
            if (this._closed || !this._input)
                return;

            this._input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                if (this._closed)
                    return;

                try {
                    const [line] = stream.read_line_finish_utf8(result);

                    if (line === null) {
                        this.close();
                        return;
                    }

                    if (line.trim())
                        this._handleMessage(JSON.parse(line));
                } catch (error) {
                    this._rejectAll(error);
                }

                readNext();
            });
        };

        readNext();
    }
}

class McpHttpSession extends McpJsonRpcSession {
    constructor(config) {
        super(config);
        this._sessionId = '';
        this.protocolVersion = '';
    }

    connect() {
        if (!this.config.url)
            throw createUserVisibleError(`${this.config.name} does not have an MCP URL configured.`);
    }

    async request(method, params = {}, options = {}) {
        const id = this._nextId++;
        const result = await this._postJson({
            jsonrpc: '2.0',
            id,
            method,
            params,
        }, options);

        if (Array.isArray(result))
            throw createUserVisibleError(`${this.config.name} returned a batch response that Cusco cannot use.`);

        if (result?.error)
            throw jsonRpcError(result);

        return result?.result ?? null;
    }

    async notification(method, params = {}, options = {}) {
        await this._postJson({
            jsonrpc: '2.0',
            method,
            params,
        }, options).catch(() => {});
    }

    _send(_payload, _options = {}) {
        throw createUserVisibleError('HTTP MCP requests must use request().');
    }

    async _postJson(payload, options = {}) {
        const timeoutSeconds = Math.max(1, Math.round(
            options.timeoutSeconds ?? DEFAULT_MCP_TIMEOUT_SECONDS,
        ));
        const session = createHttpSession(this.config.url, timeoutSeconds);
        const message = Soup.Message.new('POST', this.config.url);

        message.request_headers.append('Content-Type', 'application/json');
        message.request_headers.append('Accept', 'application/json, text/event-stream');

        if (this.protocolVersion)
            message.request_headers.append('MCP-Protocol-Version', this.protocolVersion);

        if (this._sessionId)
            message.request_headers.append('Mcp-Session-Id', this._sessionId);

        for (const [name, value] of Object.entries(this.config.headers ?? {}))
            message.request_headers.append(name, value);

        if (this.config.authToken && !hasHeader(this.config.headers, 'Authorization'))
            message.request_headers.append('Authorization', `Bearer ${this.config.authToken}`);

        message.set_request_body_from_bytes('application/json', encodeJsonBody(payload));

        let bytes;

        try {
            bytes = await sendAndRead(session, message, options.cancellable ?? null);
        } catch (error) {
            if (isCancelled(options.cancellable) || isGioError(error, Gio.IOErrorEnum.CANCELLED))
                error.userMessage = `${this.config.name} request was cancelled.`;
            else if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
                error.userMessage = `${this.config.name} did not respond within ${timeoutSeconds} seconds.`;

            throw error;
        }

        const sessionId = responseHeader(message, 'Mcp-Session-Id')
            || responseHeader(message, 'mcp-session-id');

        if (sessionId)
            this._sessionId = sessionId;

        const status = message.get_status();
        const responseText = new TextDecoder().decode(bytes.get_data()).trim();

        if (status < 200 || status >= 300) {
            const wwwAuthenticate = responseHeader(message, 'WWW-Authenticate');

            if (isMcpAuthRequiredStatus(status, wwwAuthenticate)) {
                throw createMcpAuthRequiredError(this.config.name, {
                    status,
                    wwwAuthenticate,
                    serverUrl: this.config.url,
                });
            }

            let responseJson = null;

            try {
                responseJson = parseHttpJsonRpcResponse(responseText);
            } catch (_error) {
            }

            const messageText = responseJson?.error?.message ?? responseJson?.message ?? responseText;
            throw createUserVisibleError(
                `${this.config.name} request failed (${status}): ${messageText}`,
                `${this.config.name} request failed with HTTP ${status}.`,
            );
        }

        if (status === 202 || !responseText)
            return null;

        const responseJson = parseHttpJsonRpcResponse(responseText);

        return responseJson;
    }
}

async function listPaginated(session, method, resultKey, options = {}) {
    const items = [];
    let cursor = null;

    do {
        const params = cursor ? { cursor } : {};
        const result = await session.request(method, params, options);
        items.push(...(Array.isArray(result?.[resultKey]) ? result[resultKey] : []));
        cursor = result?.nextCursor ?? null;
    } while (cursor);

    return items;
}

export class McpClient {
    constructor(config) {
        this.config = config;
        this.capabilities = {};
        this.serverInfo = {};
        this._session = null;
        this._initialized = false;
    }

    async connect(options = {}) {
        if (this._initialized)
            return this;

        this._session = this.config.transport === MCP_TRANSPORT_HTTP
            ? new McpHttpSession(this.config)
            : new McpStdioSession(this.config);
        this._session.connect();

        const result = await this._session.request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
                roots: {
                    listChanged: false,
                },
            },
            clientInfo: {
                name: 'Cusco',
                version: '0.1.0',
            },
        }, options);

        if (result?.protocolVersion && result.protocolVersion !== MCP_PROTOCOL_VERSION) {
            this.disconnect();
            throw createUserVisibleError(
                `${this.config.name} negotiated unsupported MCP protocol version ${result.protocolVersion}.`,
            );
        }

        if (this._session && this.config.transport === MCP_TRANSPORT_HTTP)
            this._session.protocolVersion = result?.protocolVersion ?? MCP_PROTOCOL_VERSION;

        this.capabilities = result?.capabilities ?? {};
        this.serverInfo = result?.serverInfo ?? {};
        await this._session.notification('notifications/initialized', {}, options);
        this._initialized = true;
        return this;
    }

    async listTools(options = {}) {
        await this.connect(options);
        return listPaginated(this._session, 'tools/list', 'tools', options);
    }

    async callTool(name, args = {}, options = {}) {
        await this.connect(options);
        return this._session.request('tools/call', {
            name,
            arguments: args,
        }, options);
    }

    async listResources(options = {}) {
        await this.connect(options);
        return listPaginated(this._session, 'resources/list', 'resources', options);
    }

    async listResourceTemplates(options = {}) {
        await this.connect(options);
        return listPaginated(this._session, 'resources/templates/list', 'resourceTemplates', options);
    }

    async readResource(uri, options = {}) {
        await this.connect(options);
        return this._session.request('resources/read', { uri }, options);
    }

    async listPrompts(options = {}) {
        await this.connect(options);
        return listPaginated(this._session, 'prompts/list', 'prompts', options);
    }

    async getPrompt(name, args = {}, options = {}) {
        await this.connect(options);
        return this._session.request('prompts/get', {
            name,
            arguments: args,
        }, options);
    }

    disconnect() {
        this._initialized = false;
        this._session?.close();
        this._session = null;
    }
}

export { MCP_TRANSPORT_HTTP, MCP_TRANSPORT_STDIO };
