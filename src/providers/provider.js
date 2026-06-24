import GLib from 'gi://GLib?version=2.0';

export class ChatProvider {
    constructor({ id, name }) {
        this.id = id;
        this.name = name;
    }

    async *streamChat(_messages, _options = {}) {
        throw new Error(`${this.name} does not implement streamChat()`);
    }
}

export function createMessage(role, content, options = {}) {
    return {
        id: GLib.uuid_string_random(),
        role,
        content,
        attachments: Array.isArray(options.attachments) ? options.attachments : [],
        toolCall: options.toolCall ?? null,
        cronRun: options.cronRun ?? null,
        createdAt: new Date().toISOString(),
    };
}
