export class ChatProvider {
    constructor({ id, name }) {
        this.id = id;
        this.name = name;
    }

    async *streamChat(_messages, _options = {}) {
        throw new Error(`${this.name} does not implement streamChat()`);
    }
}

export function createMessage(role, content) {
    return {
        role,
        content,
        createdAt: new Date().toISOString(),
    };
}
