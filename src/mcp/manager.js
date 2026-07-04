import {
    defaultMcpConfigFilePath,
    loadMcpConfigFile,
    normalizeMcpServerConfig,
    sanitizeMcpName,
} from './config.js';
import { McpClient } from './client.js';
import {
    authorizeMcpServer,
    createDefaultMcpTokenStore,
} from './auth.js';

const MAX_SCHEMA_DESCRIPTION_CHARS = 1200;
const MCP_TOOL_PREFIX = 'mcp__';

function now() {
    return new Date().toISOString();
}

function createUserVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

function serverKey(server) {
    return `${server.source}:${server.id}`;
}

function cloneServer(server) {
    return {
        ...server,
        args: [...(server.args ?? [])],
        env: { ...(server.env ?? {}) },
        headers: { ...(server.headers ?? {}) },
        roots: [...(server.roots ?? [])],
    };
}

function compactJson(value, maxChars = MAX_SCHEMA_DESCRIPTION_CHARS) {
    const text = JSON.stringify(value ?? {}, null, 2);
    return text.length > maxChars
        ? `${text.slice(0, maxChars)}...`
        : text;
}

function schemaProperties(inputSchema) {
    const properties = inputSchema?.properties;

    if (!properties || typeof properties !== 'object' || Array.isArray(properties))
        return [];

    return Object.entries(properties).map(([name, schema]) => ({
        name,
        type: Array.isArray(schema?.type) ? schema.type.join('|') : schema?.type ?? 'value',
        description: String(schema?.description ?? '').trim(),
    }));
}

function toolInputDescription(tool) {
    const properties = schemaProperties(tool.inputSchema);

    if (properties.length > 0) {
        return [
            'JSON object with fields:',
            ...properties.map((property) => (
                `- ${property.name} (${property.type})${property.description ? `: ${property.description}` : ''}`
            )),
        ].join('\n');
    }

    if (tool.inputSchema)
        return `JSON matching schema:\n${compactJson(tool.inputSchema)}`;

    return 'JSON object arguments for this MCP tool.';
}

function parseJsonObjectInput(input) {
    const text = String(input ?? '').trim();

    if (!text)
        return {};

    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : { value: parsed };
    } catch (_error) {
        return null;
    }
}

function parseMcpToolArguments(input, inputSchema) {
    const parsed = parseJsonObjectInput(input);

    if (parsed)
        return parsed;

    const properties = schemaProperties(inputSchema);

    if (properties.length === 1)
        return { [properties[0].name]: String(input ?? '') };

    return { input: String(input ?? '') };
}

function namespacedMcpToolName(server, toolName) {
    return `${MCP_TOOL_PREFIX}${server.namespace}__${sanitizeMcpName(toolName, 'tool')}`;
}

function contentText(item) {
    if (!item || typeof item !== 'object')
        return String(item ?? '');

    if (item.type === 'text')
        return String(item.text ?? '');

    if (item.type === 'image')
        return `[Image: ${item.mimeType ?? 'unknown MIME type'}, ${String(item.data ?? '').length} base64 chars]`;

    if (item.type === 'audio')
        return `[Audio: ${item.mimeType ?? 'unknown MIME type'}, ${String(item.data ?? '').length} base64 chars]`;

    if (item.type === 'resource' && item.resource)
        return resourceContentText(item.resource);

    return compactJson(item);
}

function resourceContentText(content) {
    if (!content || typeof content !== 'object')
        return String(content ?? '');

    const header = content.uri ? `Resource: ${content.uri}` : 'Resource';

    if (content.text !== undefined)
        return `${header}\n${content.text}`;

    if (content.blob !== undefined)
        return `${header}\n[Binary resource: ${content.mimeType ?? 'unknown MIME type'}, ${String(content.blob).length} base64 chars]`;

    return `${header}\n${compactJson(content)}`;
}

function formatMcpToolResult(result) {
    const lines = [];

    if (result?.isError)
        lines.push('MCP tool returned an error.');

    for (const item of result?.content ?? [])
        lines.push(contentText(item));

    if (result?.structuredContent !== undefined)
        lines.push(`Structured content\n${compactJson(result.structuredContent, 8000)}`);

    if (lines.length === 0)
        lines.push(compactJson(result, 8000));

    return lines.filter(Boolean).join('\n\n');
}

function formatMcpResourceList(resources, templates = []) {
    const resourceLines = resources.map((resource) => (
        `- ${resource.name ?? resource.uri}: ${resource.uri}${resource.description ? `\n  ${resource.description}` : ''}`
    ));
    const templateLines = templates.map((template) => (
        `- ${template.name ?? template.uriTemplate}: ${template.uriTemplate}${template.description ? `\n  ${template.description}` : ''}`
    ));

    return [
        'MCP resources:',
        resourceLines.length > 0 ? resourceLines.join('\n') : '- none',
        '',
        'MCP resource templates:',
        templateLines.length > 0 ? templateLines.join('\n') : '- none',
    ].join('\n');
}

function formatMcpResourceRead(result) {
    const contents = Array.isArray(result?.contents) ? result.contents : [];

    if (contents.length === 0)
        return compactJson(result, 8000);

    return contents.map(resourceContentText).filter(Boolean).join('\n\n');
}

function formatPromptContent(content) {
    if (typeof content === 'string')
        return content;

    if (!content || typeof content !== 'object')
        return String(content ?? '');

    if (content.type === 'text')
        return String(content.text ?? '');

    return contentText(content);
}

function formatMcpPromptList(prompts) {
    const lines = prompts.map((prompt) => (
        `- ${prompt.name}${prompt.description ? `: ${prompt.description}` : ''}`
    ));

    return ['MCP prompts:', lines.length > 0 ? lines.join('\n') : '- none'].join('\n');
}

function formatMcpPrompt(result) {
    const lines = [];

    if (result?.description)
        lines.push(result.description);

    for (const message of result?.messages ?? []) {
        lines.push([
            `${String(message.role ?? 'user').toUpperCase()}:`,
            formatPromptContent(message.content),
        ].join('\n'));
    }

    if (lines.length === 0)
        lines.push(compactJson(result, 8000));

    return lines.join('\n\n');
}

function parsePromptInput(input) {
    const parsed = parseJsonObjectInput(input);

    if (parsed?.name)
        return {
            name: String(parsed.name),
            arguments: parsed.arguments && typeof parsed.arguments === 'object'
                ? parsed.arguments
                : {},
        };

    return {
        name: String(input ?? '').trim(),
        arguments: {},
    };
}

export class McpManager {
    constructor({
        workspaceManager = null,
        configPath = defaultMcpConfigFilePath(),
        tokenStore = createDefaultMcpTokenStore(),
    } = {}) {
        this._workspaceManager = workspaceManager;
        this._configPath = configPath;
        this._tokenStore = tokenStore;
        this._servers = [];
        this._clients = new Map();
        this._status = new Map();
        this._serverTools = new Map();
        this._serverResources = new Map();
        this._serverResourceTemplates = new Map();
        this._serverPrompts = new Map();
        this._toolIndex = new Map();
        this._configError = '';
        this.reloadConfig();
    }

    get configPath() {
        return this._configPath;
    }

    get configError() {
        return this._configError;
    }

    reloadConfig() {
        const workspaceServers = (this._workspaceManager?.mcpServers ?? [])
            .map((server) => normalizeMcpServerConfig(server, { source: 'workspace' }));
        let fileServers = [];

        this._configError = '';

        try {
            fileServers = loadMcpConfigFile(this._configPath);
        } catch (error) {
            this._configError = error.message;
            fileServers = [];
        }

        const usedNamespaces = new Map();
        this._servers = [...workspaceServers, ...fileServers].map((server) => {
            const normalized = normalizeMcpServerConfig(server, {
                source: server.source,
                sourcePath: server.sourcePath,
            });
            const baseNamespace = normalized.namespace;
            const count = usedNamespaces.get(baseNamespace) ?? 0;
            usedNamespaces.set(baseNamespace, count + 1);

            return {
                ...normalized,
                key: serverKey(normalized),
                namespace: count === 0 ? baseNamespace : `${baseNamespace}_${count + 1}`,
            };
        });

        return this.listServers();
    }

    listServers() {
        return this._servers.map((server) => ({
            ...cloneServer(server),
            status: this._status.get(server.key) ?? {
                state: server.enabled ? 'idle' : 'disabled',
                message: server.enabled ? 'Not connected.' : 'Disabled.',
                updatedAt: '',
                auth: null,
            },
            toolCount: this._serverTools.get(server.key)?.length ?? 0,
            resourceCount: (this._serverResources.get(server.key)?.length ?? 0)
                + (this._serverResourceTemplates.get(server.key)?.length ?? 0),
            promptCount: this._serverPrompts.get(server.key)?.length ?? 0,
        }));
    }

    addWorkspaceServer(server) {
        if (!this._workspaceManager)
            throw createUserVisibleError('Workspace settings are not available.');

        const added = this._workspaceManager.addMcpServer(server);
        this.reloadConfig();
        return added;
    }

    setServerEnabled(key, enabled) {
        const server = this._servers.find((item) => item.key === key);

        if (!server)
            throw createUserVisibleError(`Unknown MCP server: ${key}`);

        if (server.source !== 'workspace')
            throw createUserVisibleError('Config-file MCP servers must be enabled or disabled in the config file.');

        this._workspaceManager.setMcpServerEnabled(server.id, enabled);
        this.reloadConfig();
    }

    deleteServer(key) {
        const server = this._servers.find((item) => item.key === key);

        if (!server)
            throw createUserVisibleError(`Unknown MCP server: ${key}`);

        if (server.source !== 'workspace')
            throw createUserVisibleError('Config-file MCP servers must be removed from the config file.');

        this._workspaceManager.deleteRecord('mcpServers', server.id);
        this.disconnectServer(key);
        this.reloadConfig();
    }

    async refreshTools(toolManager, options = {}) {
        this.reloadConfig();
        toolManager?.clearRegisteredTools?.((tool) => tool.name.startsWith(MCP_TOOL_PREFIX));
        this._toolIndex.clear();

        for (const server of this._servers) {
            if (!server.enabled) {
                this._setStatus(server.key, 'disabled', 'Disabled.');
                continue;
            }

            try {
                await this.refreshServer(server.key, options);
                this._registerServerTools(toolManager, server);
            } catch (error) {
                this._setErrorStatus(server.key, error);
            }
        }

        return this.listServers();
    }

    async refreshServers(options = {}) {
        this.reloadConfig();

        for (const server of this._servers) {
            if (!server.enabled) {
                this._setStatus(server.key, 'disabled', 'Disabled.');
                continue;
            }

            try {
                await this.refreshServer(server.key, options);
            } catch (error) {
                this._setErrorStatus(server.key, error);
            }
        }

        return this.listServers();
    }

    async refreshServer(key, options = {}) {
        const server = this._servers.find((item) => item.key === key);

        if (!server)
            throw createUserVisibleError(`Unknown MCP server: ${key}`);

        if (!server.enabled) {
            this._setStatus(key, 'disabled', 'Disabled.');
            return;
        }

        const client = this._clientFor(server);
        this._setStatus(key, 'connecting', 'Connecting...');

        await client.connect(options);
        const tools = await this._tryList(() => client.listTools(options));
        const resources = await this._tryList(() => client.listResources(options));
        const templates = await this._tryList(() => client.listResourceTemplates(options));
        const prompts = await this._tryList(() => client.listPrompts(options));

        this._serverTools.set(key, tools);
        this._serverResources.set(key, resources);
        this._serverResourceTemplates.set(key, templates);
        this._serverPrompts.set(key, prompts);
        this._setStatus(
            key,
            'connected',
            `${tools.length} tools, ${resources.length + templates.length} resources, ${prompts.length} prompts.`,
        );
    }

    async authorizeServer(key, options = {}) {
        const server = this._servers.find((item) => item.key === key);

        if (!server)
            throw createUserVisibleError(`Unknown MCP server: ${key}`);

        const status = this._status.get(key);
        await authorizeMcpServer(server, status?.auth ?? {}, this._tokenStore, options);
        this.disconnectServer(key);
        await this.refreshServer(key, options);
        return this.listServers().find((item) => item.key === key);
    }

    async callTool(serverKeyValue, toolName, input, options = {}) {
        const server = this._servers.find((item) => item.key === serverKeyValue);

        if (!server)
            throw createUserVisibleError(`Unknown MCP server: ${serverKeyValue}`);

        const tools = this._serverTools.get(server.key) ?? [];
        const tool = tools.find((item) => item.name === toolName);
        const args = parseMcpToolArguments(input, tool?.inputSchema);
        try {
            const result = await this._clientFor(server).callTool(toolName, args, options);
            return formatMcpToolResult(result);
        } catch (error) {
            this._setErrorStatus(server.key, error);
            throw error;
        }
    }

    async listResources(serverKeyValue) {
        const resources = this._serverResources.get(serverKeyValue) ?? [];
        const templates = this._serverResourceTemplates.get(serverKeyValue) ?? [];
        return formatMcpResourceList(resources, templates);
    }

    async readResource(serverKeyValue, input, options = {}) {
        const server = this._servers.find((item) => item.key === serverKeyValue);
        const uri = String(input ?? '').trim();

        if (!server)
            throw createUserVisibleError(`Unknown MCP server: ${serverKeyValue}`);

        if (!uri)
            throw createUserVisibleError('MCP resource URI cannot be empty.');

        try {
            return formatMcpResourceRead(await this._clientFor(server).readResource(uri, options));
        } catch (error) {
            this._setErrorStatus(server.key, error);
            throw error;
        }
    }

    async listPrompts(serverKeyValue) {
        return formatMcpPromptList(this._serverPrompts.get(serverKeyValue) ?? []);
    }

    async getPrompt(serverKeyValue, input, options = {}) {
        const server = this._servers.find((item) => item.key === serverKeyValue);
        const { name, arguments: args } = parsePromptInput(input);

        if (!server)
            throw createUserVisibleError(`Unknown MCP server: ${serverKeyValue}`);

        if (!name)
            throw createUserVisibleError('MCP prompt name cannot be empty.');

        try {
            return formatMcpPrompt(await this._clientFor(server).getPrompt(name, args, options));
        } catch (error) {
            this._setErrorStatus(server.key, error);
            throw error;
        }
    }

    disconnectServer(key) {
        this._clients.get(key)?.disconnect();
        this._clients.delete(key);
        this._serverTools.delete(key);
        this._serverResources.delete(key);
        this._serverResourceTemplates.delete(key);
        this._serverPrompts.delete(key);
        this._setStatus(key, 'idle', 'Disconnected.');
    }

    shutdown() {
        for (const client of this._clients.values())
            client.disconnect();

        this._clients.clear();
    }

    _clientFor(server) {
        let client = this._clients.get(server.key);

        if (!client) {
            const token = this._tokenStore?.lookup?.(server.key);
            const authToken = token?.accessToken && String(token.tokenType ?? 'Bearer').toLowerCase() === 'bearer'
                ? token.accessToken
                : '';
            client = new McpClient({
                ...server,
                authToken,
            });
            this._clients.set(server.key, client);
        }

        return client;
    }

    async _tryList(callback) {
        try {
            return await callback();
        } catch (_error) {
            return [];
        }
    }

    _registerServerTools(toolManager, server) {
        if (!toolManager)
            return;

        const tools = this._serverTools.get(server.key) ?? [];

        for (const tool of tools) {
            const name = namespacedMcpToolName(server, tool.name);
            this._toolIndex.set(name, {
                serverKey: server.key,
                toolName: tool.name,
            });
            toolManager.registerTool({
                name,
                label: `${server.name}: ${tool.title ?? tool.name}`,
                description: tool.description ?? `Run ${tool.name} on ${server.name}.`,
                inputDescription: toolInputDescription(tool),
                inputSchema: tool.inputSchema ?? null,
                permissionPolicy: server.permissionPolicy,
                requiresPermission: server.permissionPolicy !== 'allow',
                concurrencySafe: false,
                run: async (input, options) => this.callTool(server.key, tool.name, input, options),
            });
        }

        if ((this._serverResources.get(server.key)?.length ?? 0) > 0
            || (this._serverResourceTemplates.get(server.key)?.length ?? 0) > 0) {
            toolManager.registerTool({
                name: `${MCP_TOOL_PREFIX}${server.namespace}__list_resources`,
                label: `${server.name}: List Resources`,
                description: `List MCP resources exposed by ${server.name}.`,
                inputDescription: 'No input is required.',
                permissionPolicy: 'allow',
                requiresPermission: false,
                concurrencySafe: true,
                run: async () => this.listResources(server.key),
            });
            toolManager.registerTool({
                name: `${MCP_TOOL_PREFIX}${server.namespace}__read_resource`,
                label: `${server.name}: Read Resource`,
                description: `Read one MCP resource from ${server.name}.`,
                inputDescription: 'Resource URI.',
                permissionPolicy: server.permissionPolicy,
                requiresPermission: server.permissionPolicy !== 'allow',
                concurrencySafe: false,
                run: async (input, options) => this.readResource(server.key, input, options),
            });
        }

        if ((this._serverPrompts.get(server.key)?.length ?? 0) > 0) {
            toolManager.registerTool({
                name: `${MCP_TOOL_PREFIX}${server.namespace}__list_prompts`,
                label: `${server.name}: List Prompts`,
                description: `List MCP prompts exposed by ${server.name}.`,
                inputDescription: 'No input is required.',
                permissionPolicy: 'allow',
                requiresPermission: false,
                concurrencySafe: true,
                run: async () => this.listPrompts(server.key),
            });
            toolManager.registerTool({
                name: `${MCP_TOOL_PREFIX}${server.namespace}__get_prompt`,
                label: `${server.name}: Get Prompt`,
                description: `Get one MCP prompt from ${server.name}.`,
                inputDescription: 'Prompt name, or JSON: {"name":"prompt_name","arguments":{}}',
                permissionPolicy: server.permissionPolicy,
                requiresPermission: server.permissionPolicy !== 'allow',
                concurrencySafe: false,
                run: async (input, options) => this.getPrompt(server.key, input, options),
            });
        }
    }

    _setErrorStatus(key, error) {
        if (error?.mcpAuth) {
            this._setStatus(key, 'auth_required', error.userMessage ?? error.message, {
                auth: error.mcpAuth,
            });
            return;
        }

        this._setStatus(key, 'error', error.userMessage ?? error.message);
    }

    _setStatus(key, state, message, details = {}) {
        this._status.set(key, {
            state,
            message,
            auth: details.auth ?? null,
            updatedAt: now(),
        });
    }
}
