import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

const DEFAULT_SEARCH_TIMEOUT_SECONDS = 15;

function userVisibleError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
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

export function parseToolRequest(text) {
    const trimmed = String(text ?? '').trim();
    const match = trimmed.match(/^\/(calc|data|search)\s+([\s\S]+)$/i);

    if (!match)
        return null;

    const [, toolName, input] = match;
    const normalizedToolName = toolName.toLowerCase();

    return {
        name: normalizedToolName,
        input: input.trim(),
        requiresPermission: normalizedToolName === 'search',
        label: normalizedToolName === 'calc'
            ? 'Calculator'
            : normalizedToolName === 'data'
                ? 'Structured Data'
                : 'Web Search',
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

        this._registeredTools.set(name, {
            label: tool.label ?? name,
            requiresPermission: tool.requiresPermission !== false,
            run: tool.run,
        });
    }

    listTools() {
        return [
            { name: 'calc', label: 'Calculator', requiresPermission: false },
            { name: 'data', label: 'Structured Data', requiresPermission: false },
            { name: 'search', label: 'Web Search', requiresPermission: true },
            ...[...this._registeredTools.entries()].map(([name, tool]) => ({
                name,
                label: tool.label,
                requiresPermission: tool.requiresPermission,
            })),
        ];
    }

    parseRequest(text) {
        const builtInRequest = parseToolRequest(text);

        if (builtInRequest)
            return builtInRequest;

        const trimmed = String(text ?? '').trim();
        const match = trimmed.match(/^\/([\w-]+)\s+([\s\S]+)$/);

        if (!match || !this._registeredTools.has(match[1]))
            return null;

        const tool = this._registeredTools.get(match[1]);
        return {
            name: match[1],
            input: match[2].trim(),
            requiresPermission: tool.requiresPermission,
            label: tool.label,
        };
    }

    async runRequest(request, options = {}) {
        if (this._registeredTools.has(request.name)) {
            const tool = this._registeredTools.get(request.name);
            return {
                ...request,
                output: String(await tool.run(request.input, options)),
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
        default:
            throw userVisibleError(`Unknown tool: ${request.name}`);
        }
    }
}
