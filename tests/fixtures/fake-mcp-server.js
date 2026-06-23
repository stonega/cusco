import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const input = new Gio.DataInputStream({
    base_stream: new Gio.UnixInputStream({
        fd: 0,
        close_fd: false,
    }),
});
const loop = new GLib.MainLoop(null, false);

function send(message) {
    print(JSON.stringify({
        jsonrpc: '2.0',
        ...message,
    }));
}

function resultFor(message) {
    switch (message.method) {
    case 'initialize':
        return {
            protocolVersion: '2025-11-25',
            capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false },
            },
            serverInfo: {
                name: 'Fake MCP',
                version: '1.0.0',
            },
        };
    case 'tools/list':
        return {
            tools: [{
                name: 'echo',
                title: 'Echo',
                description: 'Echo a message.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        message: {
                            type: 'string',
                            description: 'Message to echo.',
                        },
                    },
                    required: ['message'],
                },
            }],
        };
    case 'tools/call':
        return {
            content: [{
                type: 'text',
                text: `echo: ${message.params?.arguments?.message ?? ''}`,
            }],
            structuredContent: {
                ok: true,
            },
        };
    case 'resources/list':
        return {
            resources: [{
                uri: 'memory://note',
                name: 'Note',
                description: 'A fake note.',
                mimeType: 'text/plain',
            }],
        };
    case 'resources/templates/list':
        return {
            resourceTemplates: [{
                uriTemplate: 'memory://{name}',
                name: 'Memory item',
            }],
        };
    case 'resources/read':
        return {
            contents: [{
                uri: message.params?.uri,
                mimeType: 'text/plain',
                text: `resource: ${message.params?.uri}`,
            }],
        };
    case 'prompts/list':
        return {
            prompts: [{
                name: 'review',
                description: 'Review content.',
                arguments: [{
                    name: 'topic',
                    required: false,
                }],
            }],
        };
    case 'prompts/get':
        return {
            description: 'Review content.',
            messages: [{
                role: 'user',
                content: {
                    type: 'text',
                    text: `Review ${message.params?.arguments?.topic ?? 'this'}.`,
                },
            }],
        };
    default:
        throw new Error(`Unsupported method: ${message.method}`);
    }
}

function readNext() {
    input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, asyncResult) => {
        const [line] = stream.read_line_finish_utf8(asyncResult);

        if (line === null) {
            loop.quit();
            return;
        }

        if (!line.trim()) {
            readNext();
            return;
        }

        const message = JSON.parse(line);

        if (message.id !== undefined) {
            try {
                send({
                    id: message.id,
                    result: resultFor(message),
                });
            } catch (error) {
                send({
                    id: message.id,
                    error: {
                        code: -32601,
                        message: error.message,
                    },
                });
            }
        }

        readNext();
    });
}

readNext();
loop.run();
