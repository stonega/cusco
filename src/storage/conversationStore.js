import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from '../providers/thinking.js';
import { normalizeTokenUsage } from '../providers/usage.js';

const APP_ID = 'io.github.stonega.Cusco';
const DATABASE_VERSION = 1;

function defaultConversationDatabasePath() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        APP_ID,
        'conversations.json',
    ]);
}

function normalizeString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function normalizeStringList(value) {
    return Array.isArray(value)
        ? value.map((item) => String(item).trim()).filter(Boolean)
        : [];
}

function normalizeMessage(message) {
    return {
        id: normalizeString(message?.id, GLib.uuid_string_random()),
        role: normalizeString(message?.role, 'assistant'),
        content: normalizeString(message?.content),
        attachments: Array.isArray(message?.attachments)
            ? message.attachments.map((attachment) => ({ ...attachment }))
            : [],
        reasoning: normalizeReasoning(message?.reasoning),
        usage: normalizeTokenUsage(message?.usage),
        toolCall: message?.toolCall && typeof message.toolCall === 'object'
            ? { ...message.toolCall }
            : null,
        cronRun: message?.cronRun && typeof message.cronRun === 'object'
            ? { ...message.cronRun }
            : null,
        createdAt: normalizeString(message?.createdAt, new Date().toISOString()),
    };
}

function normalizeReasoning(reasoning) {
    if (typeof reasoning === 'string') {
        const content = reasoning.trim();
        return content ? { content } : null;
    }

    if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning))
        return null;

    const content = normalizeString(reasoning.content ?? reasoning.text).trim();

    if (!content)
        return null;

    return {
        content,
        providerId: normalizeString(reasoning.providerId),
        modelId: normalizeString(reasoning.modelId),
        thinkingLevel: reasoning.thinkingLevel
            ? normalizeThinkingLevel(reasoning.thinkingLevel)
            : '',
        createdAt: normalizeString(reasoning.createdAt, new Date().toISOString()),
    };
}

function normalizeConversationType(value) {
    return value === 'cron' ? 'cron' : 'chat';
}

function normalizeConversation(conversation) {
    const timestamp = new Date().toISOString();

    return {
        id: normalizeString(conversation?.id, GLib.uuid_string_random()),
        title: normalizeString(conversation?.title, 'New chat'),
        providerId: normalizeString(conversation?.providerId),
        modelId: normalizeString(conversation?.modelId),
        thinkingLevel: normalizeThinkingLevel(conversation?.thinkingLevel, DEFAULT_THINKING_LEVEL),
        messages: Array.isArray(conversation?.messages)
            ? conversation.messages.map(normalizeMessage)
            : [],
        archived: Boolean(conversation?.archived),
        memoryEnabled: conversation?.memoryEnabled !== false,
        agentModeEnabled: Boolean(conversation?.agentModeEnabled),
        folderId: normalizeString(conversation?.folderId),
        tags: normalizeStringList(conversation?.tags),
        profileId: normalizeString(conversation?.profileId),
        skillIds: normalizeStringList(conversation?.skillIds),
        conversationType: normalizeConversationType(conversation?.conversationType),
        cronJobId: normalizeString(conversation?.cronJobId),
        createdAt: normalizeString(conversation?.createdAt, timestamp),
        updatedAt: normalizeString(conversation?.updatedAt, timestamp),
    };
}

function normalizeDatabase(value) {
    const conversations = Array.isArray(value?.conversations)
        ? value.conversations.map(normalizeConversation)
        : [];
    const activeConversationId = normalizeString(value?.activeConversationId, null);

    return {
        conversations,
        activeConversationId: conversations.some((conversation) => conversation.id === activeConversationId)
            ? activeConversationId
            : conversations[0]?.id ?? null,
    };
}

function writeFileAtomically(path, contents) {
    const directory = GLib.path_get_dirname(path);
    const basename = GLib.path_get_basename(path);
    const tempPath = GLib.build_filenamev([
        directory,
        `.${basename}.${GLib.uuid_string_random()}.tmp`,
    ]);

    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(tempPath, contents);

    try {
        Gio.File.new_for_path(tempPath).move(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null,
        );
    } finally {
        if (GLib.file_test(tempPath, GLib.FileTest.EXISTS))
            GLib.unlink(tempPath);
    }
}

export class ConversationFileStore {
    constructor(options = {}) {
        this.path = options.path ?? defaultConversationDatabasePath();
    }

    load() {
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS))
            return { conversations: [], activeConversationId: null };

        const [, contents] = GLib.file_get_contents(this.path);
        const decoded = new TextDecoder().decode(contents);
        const parsed = JSON.parse(decoded);

        return normalizeDatabase(parsed);
    }

    save(database) {
        const normalized = normalizeDatabase(database);
        const payload = JSON.stringify({
            version: DATABASE_VERSION,
            activeConversationId: normalized.activeConversationId,
            conversations: normalized.conversations,
        }, null, 2);

        writeFileAtomically(this.path, `${payload}\n`);
    }
}
