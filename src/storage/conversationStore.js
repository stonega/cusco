import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { normalizeArtifacts } from '../chat/artifacts.js';
import { DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from '../providers/thinking.js';
import { normalizeTokenUsage } from '../providers/usage.js';

const APP_ID = 'io.github.stonega.Cusco';
const DATABASE_VERSION = 2;
const CONVERSATION_RECORD_VERSION = 1;
const SELECTION_STATE_VERSION = 1;
// A fixed-size probabilistic filter keeps startup metadata bounded. Matches are
// always verified against the record, so filter false positives affect I/O only.
const SEARCH_BLOOM_BYTES = 256;
const SEARCH_BLOOM_HASH_SEEDS = [0, 0x9e3779b9, 0x85ebca6b];
const SEARCH_SNIPPET_LENGTH = 160;

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

function normalizeMetadata(metadata) {
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...metadata }
        : {};
}

function normalizeMessage(message) {
    const toolCall = message?.toolCall && typeof message.toolCall === 'object'
        ? { ...message.toolCall }
        : null;

    if (toolCall)
        toolCall.artifacts = normalizeArtifacts(toolCall.artifacts);

    return {
        id: normalizeString(message?.id, GLib.uuid_string_random()),
        role: normalizeString(message?.role, 'assistant'),
        content: normalizeString(message?.content),
        attachments: Array.isArray(message?.attachments)
            ? message.attachments.map((attachment) => ({ ...attachment }))
            : [],
        artifacts: normalizeArtifacts(message?.artifacts),
        reasoning: normalizeReasoning(message?.reasoning),
        usage: normalizeTokenUsage(message?.usage),
        toolCall,
        cronRun: message?.cronRun && typeof message.cronRun === 'object'
            ? { ...message.cronRun }
            : null,
        metadata: normalizeMetadata(message?.metadata),
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
        agentMode: Boolean(reasoning.agentMode),
        createdAt: normalizeString(reasoning.createdAt, new Date().toISOString()),
    };
}

function normalizeConversationType(value) {
    return value === 'cron' ? 'cron' : 'chat';
}

function normalizeConversationFields(conversation) {
    const timestamp = new Date().toISOString();

    return {
        id: normalizeString(conversation?.id, GLib.uuid_string_random()),
        title: normalizeString(conversation?.title, 'New chat'),
        providerId: normalizeString(conversation?.providerId),
        modelId: normalizeString(conversation?.modelId),
        thinkingLevel: normalizeThinkingLevel(conversation?.thinkingLevel, DEFAULT_THINKING_LEVEL),
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

function normalizeConversation(conversation) {
    return {
        ...normalizeConversationFields(conversation),
        messages: Array.isArray(conversation?.messages)
            ? conversation.messages.map(normalizeMessage)
            : [],
    };
}

function normalizedSearchText(value) {
    return String(value ?? '').toLowerCase();
}

function collapseSearchSnippet(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();

    return text.length > SEARCH_SNIPPET_LENGTH
        ? `${text.slice(0, SEARCH_SNIPPET_LENGTH - 3)}...`
        : text;
}

function bloomHash(value, seed) {
    let hash = (2166136261 ^ seed) >>> 0;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }

    return hash;
}

function gramValues(value, size) {
    const characters = Array.from(value);

    if (characters.length < size)
        return [];

    const grams = [];

    for (let index = 0; index <= characters.length - size; index += 1)
        grams.push(characters.slice(index, index + size).join(''));

    return grams;
}

function addBloomValue(bytes, value) {
    const bitCount = bytes.length * 8;

    for (const seed of SEARCH_BLOOM_HASH_SEEDS) {
        const bit = bloomHash(value, seed) % bitCount;
        bytes[Math.floor(bit / 8)] |= 1 << (bit % 8);
    }
}

function addSearchTextToBloom(bytes, value) {
    const text = normalizedSearchText(value);
    const characterCount = Array.from(text).length;

    for (let size = 1; size <= Math.min(3, characterCount); size += 1) {
        for (const gram of gramValues(text, size))
            addBloomValue(bytes, gram);
    }
}

function conversationSearchBloom(conversation, messages) {
    const bytes = new Uint8Array(SEARCH_BLOOM_BYTES);
    addSearchTextToBloom(bytes, conversation.title);

    for (const message of messages)
        addSearchTextToBloom(bytes, message.content);

    return GLib.base64_encode(bytes);
}

function bloomMightContain(encodedBloom, query) {
    if (!encodedBloom)
        return true;

    try {
        const bytes = GLib.base64_decode(encodedBloom);
        const characters = Array.from(query);
        const gramSize = Math.min(3, characters.length);

        if (bytes.length !== SEARCH_BLOOM_BYTES || gramSize === 0)
            return true;

        return gramValues(query, gramSize).every((gram) => {
            const bitCount = bytes.length * 8;

            return SEARCH_BLOOM_HASH_SEEDS.every((seed) => {
                const bit = bloomHash(gram, seed) % bitCount;
                return (bytes[Math.floor(bit / 8)] & (1 << (bit % 8))) !== 0;
            });
        });
    } catch (_error) {
        return true;
    }
}

function normalizeConversationSummary(conversation, options = {}) {
    const messages = Array.isArray(options.messages) ? options.messages : null;
    const lastMessage = messages?.at(-1) ?? null;

    return {
        ...normalizeConversationFields(conversation),
        messageCount: messages
            ? messages.length
            : Math.max(0, Number(conversation?.messageCount) || 0),
        lastMessagePreview: messages
            ? collapseSearchSnippet(lastMessage?.content)
            : collapseSearchSnippet(conversation?.lastMessagePreview),
        searchBloom: messages
            ? conversationSearchBloom(conversation, messages)
            : normalizeString(conversation?.searchBloom),
    };
}

function normalizeLegacyDatabase(value) {
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

function normalizeSummaryDatabase(value) {
    const conversations = Array.isArray(value?.conversations)
        ? value.conversations.map((conversation) => normalizeConversationSummary(conversation))
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

    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error(`Could not create conversation data directory: ${directory}`);
    if (GLib.chmod(directory, 0o700) !== 0)
        throw new Error(`Could not secure conversation data directory: ${directory}`);

    GLib.file_set_contents(tempPath, contents);

    try {
        if (GLib.chmod(tempPath, 0o600) !== 0)
            throw new Error(`Could not secure temporary conversation data: ${tempPath}`);

        Gio.File.new_for_path(tempPath).move(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null,
        );

        if (GLib.chmod(path, 0o600) !== 0)
            throw new Error(`Could not secure conversation data: ${path}`);
    } finally {
        if (GLib.file_test(tempPath, GLib.FileTest.EXISTS))
            GLib.unlink(tempPath);
    }
}

function readJsonFile(path) {
    const [, contents] = GLib.file_get_contents(path);
    return JSON.parse(new TextDecoder().decode(contents));
}

function messageSearchMatch(conversation, query) {
    return conversation.messages.find((message) => (
        normalizedSearchText(message.content).includes(query)
    )) ?? null;
}

export class ConversationFileStore {
    constructor(options = {}) {
        this.path = options.path ?? defaultConversationDatabasePath();
        this.selectionPath = options.selectionPath ?? `${this.path}.state`;
        this.recordsPath = options.recordsPath ?? `${this.path}.d`;
        this.pendingIndexPath = options.pendingIndexPath ?? `${this.path}.pending-index.d`;
        this._pendingSummaries = new Map();
        this.supportsLazyLoading = true;
    }

    load() {
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS))
            return { conversations: [], activeConversationId: null };

        const parsed = readJsonFile(this.path);
        let database;

        if (parsed?.version === DATABASE_VERSION) {
            database = normalizeSummaryDatabase(parsed);
        } else {
            const legacyDatabase = normalizeLegacyDatabase(parsed);
            this.save(legacyDatabase, { normalized: true });
            database = {
                conversations: legacyDatabase.conversations.map((conversation) => (
                    normalizeConversationSummary(conversation, { messages: conversation.messages })
                )),
                activeConversationId: legacyDatabase.activeConversationId,
            };
        }

        const reconciliation = this._reconcilePendingIndex(database);
        database = reconciliation.database;

        if (reconciliation.hadPendingUpdates) {
            this._writeIndex(database);
            this._writePendingConversationIds(reconciliation.unresolvedIds);
        }

        const selectedConversationId = this._loadActiveConversationId();

        if (database.conversations.some((conversation) => conversation.id === selectedConversationId))
            database.activeConversationId = selectedConversationId;

        return database;
    }

    loadConversation(conversationId) {
        const id = String(conversationId ?? '').trim();

        if (!id)
            throw new Error('Conversation ID is required.');

        const path = this._conversationRecordPath(id);

        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            throw new Error(`Conversation transcript is missing: ${id}`);

        const parsed = readJsonFile(path);
        const conversation = normalizeConversation(parsed?.conversation ?? parsed);

        if (conversation.id !== id)
            throw new Error(`Conversation transcript ID does not match its index entry: ${id}`);

        return conversation;
    }

    save(database, options = {}) {
        const normalized = options.normalized ? database : normalizeLegacyDatabase(database);
        const summaries = [];

        for (const conversation of normalized.conversations ?? []) {
            summaries.push(this.saveConversation(conversation, {
                messagesLoaded: Array.isArray(conversation?.messages),
            }));
        }

        this.saveIndex({
            conversations: summaries,
            activeConversationId: normalized.activeConversationId,
        });
        this.saveActiveConversationId(normalized.activeConversationId);
    }

    saveConversation(conversation, { messagesLoaded = true } = {}) {
        const id = String(conversation?.id ?? '').trim();

        if (!id)
            throw new Error('Conversation ID is required.');

        let messages;

        if (messagesLoaded) {
            messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        } else {
            messages = this.loadConversation(id).messages;
        }

        const normalized = {
            ...normalizeConversationFields(conversation),
            messages: messages.map(normalizeMessage),
        };
        const payload = JSON.stringify({
            version: CONVERSATION_RECORD_VERSION,
            conversation: normalized,
        });
        const summary = normalizeConversationSummary(normalized, { messages: normalized.messages });

        this._markIndexUpdatePending(id);
        writeFileAtomically(this._conversationRecordPath(id), `${payload}\n`);
        this._pendingSummaries.set(id, summary);
        return summary;
    }

    saveIndex(database) {
        const normalized = normalizeSummaryDatabase(database);
        const reconciliation = this._reconcilePendingIndex(normalized);
        this._writeIndex(reconciliation.database);
        this._writePendingConversationIds(reconciliation.unresolvedIds);

        for (const conversationId of this._pendingSummaries.keys()) {
            if (!reconciliation.unresolvedIds.includes(conversationId))
                this._pendingSummaries.delete(conversationId);
        }
    }

    _writeIndex(database) {
        const payload = JSON.stringify({
            version: DATABASE_VERSION,
            activeConversationId: database.activeConversationId,
            conversations: database.conversations,
        });

        writeFileAtomically(this.path, `${payload}\n`);
    }

    deleteConversation(conversationId) {
        const path = this._conversationRecordPath(conversationId);

        if (GLib.file_test(path, GLib.FileTest.EXISTS) && GLib.unlink(path) !== 0)
            throw new Error(`Could not delete conversation transcript: ${conversationId}`);
    }

    discardPendingConversation(conversationId) {
        const id = String(conversationId ?? '').trim();

        if (!id)
            return;

        this._pendingSummaries.delete(id);
        this._writePendingConversationIds(
            this._loadPendingConversationIds().filter((pendingId) => pendingId !== id),
        );
    }

    hasPendingIndexUpdates() {
        return this._loadPendingConversationIds().length > 0;
    }

    search(query, options = {}) {
        const normalizedQuery = normalizedSearchText(query).trim();

        if (!normalizedQuery)
            return [];

        const source = Array.isArray(options.conversations)
            ? options.conversations
            : this.load().conversations;
        const includeArchived = Boolean(options.includeArchived);
        const limit = Math.max(0, Number(options.limit ?? Number.MAX_SAFE_INTEGER) || 0);
        const summaries = source
            .map((conversation) => normalizeConversationSummary(conversation))
            .filter((conversation) => includeArchived || !conversation.archived);

        if (options.sortByUpdatedAt) {
            summaries.sort((left, right) => (
                String(right.updatedAt).localeCompare(String(left.updatedAt))
            ));
        }

        const matches = [];

        for (const summary of summaries) {
            if (matches.length >= limit)
                break;

            const titleMatches = normalizedSearchText(summary.title).includes(normalizedQuery);

            if (titleMatches) {
                matches.push({
                    id: summary.id,
                    snippet: summary.lastMessagePreview || 'Cusco conversation',
                });
                continue;
            }

            if (summary.messageCount === 0
                || !bloomMightContain(summary.searchBloom, normalizedQuery)) {
                continue;
            }

            try {
                const message = messageSearchMatch(this.loadConversation(summary.id), normalizedQuery);

                if (message) {
                    matches.push({
                        id: summary.id,
                        snippet: collapseSearchSnippet(message.content),
                    });
                }
            } catch (error) {
                logError(error, `Failed to search conversation ${summary.id}`);
            }
        }

        return matches;
    }

    saveActiveConversationId(activeConversationId) {
        const payload = JSON.stringify({
            version: SELECTION_STATE_VERSION,
            activeConversationId: normalizeString(activeConversationId, null),
        });

        writeFileAtomically(this.selectionPath, `${payload}\n`);
    }

    _loadActiveConversationId() {
        if (!GLib.file_test(this.selectionPath, GLib.FileTest.EXISTS))
            return null;

        try {
            return normalizeString(readJsonFile(this.selectionPath)?.activeConversationId, null);
        } catch (error) {
            logError(error, 'Failed to load active conversation state');
            return null;
        }
    }

    _conversationRecordPath(conversationId) {
        const digest = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256,
            String(conversationId ?? ''),
            -1,
        );

        return GLib.build_filenamev([this.recordsPath, `${digest}.json`]);
    }

    _markIndexUpdatePending(conversationId) {
        // The marker is durable before the record replacement. Startup can then
        // repair the index whether the process stopped before or after that write.
        const id = String(conversationId);
        writeFileAtomically(this._pendingMarkerPath(id), `${JSON.stringify({
            version: 1,
            conversationId: id,
        })}\n`);
    }

    _loadPendingConversationIds() {
        return this._pendingMarkerEntries().map((entry) => entry.id);
    }

    _writePendingConversationIds(conversationIds) {
        const desiredIds = new Set(conversationIds.map((id) => String(id).trim()).filter(Boolean));
        const entries = this._pendingMarkerEntries();
        const existingIds = new Set(entries.map((entry) => entry.id));

        for (const entry of entries) {
            if (!desiredIds.has(entry.id) && GLib.unlink(entry.path) !== 0)
                throw new Error(`Could not clear pending index update for ${entry.id}.`);
        }

        for (const id of desiredIds) {
            if (!existingIds.has(id))
                this._markIndexUpdatePending(id);
        }
    }

    _reconcilePendingIndex(database) {
        const pendingIds = this._loadPendingConversationIds();

        if (pendingIds.length === 0) {
            return {
                database,
                hadPendingUpdates: false,
                unresolvedIds: [],
            };
        }

        const conversations = [...database.conversations];
        const indexesById = new Map(conversations.map((conversation, index) => [
            conversation.id,
            index,
        ]));
        const unresolvedIds = [];

        for (const conversationId of pendingIds) {
            const recordPath = this._conversationRecordPath(conversationId);

            if (!GLib.file_test(recordPath, GLib.FileTest.EXISTS))
                continue;

            try {
                const pendingSummary = this._pendingSummaries.get(conversationId);
                const conversation = pendingSummary
                    ? null
                    : this.loadConversation(conversationId);
                const summary = pendingSummary ?? normalizeConversationSummary(conversation, {
                    messages: conversation.messages,
                });
                const index = indexesById.get(conversationId);

                if (index === undefined) {
                    indexesById.set(conversationId, conversations.length);
                    conversations.push(summary);
                } else {
                    conversations[index] = summary;
                }
            } catch (error) {
                unresolvedIds.push(conversationId);
                logError(error, `Failed to reconcile conversation index ${conversationId}`);
            }
        }

        return {
            database: {
                conversations,
                activeConversationId: database.activeConversationId,
            },
            hadPendingUpdates: true,
            unresolvedIds,
        };
    }

    _pendingMarkerEntries() {
        if (!GLib.file_test(this.pendingIndexPath, GLib.FileTest.IS_DIR))
            return [];

        const entries = [];
        const directory = Gio.File.new_for_path(this.pendingIndexPath);
        const enumerator = directory.enumerate_children(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
        );

        try {
            let info;

            while ((info = enumerator.next_file(null)) !== null) {
                const path = GLib.build_filenamev([this.pendingIndexPath, info.get_name()]);

                try {
                    const id = String(readJsonFile(path)?.conversationId ?? '').trim();

                    if (id)
                        entries.push({ id, path });
                } catch (error) {
                    logError(error, `Failed to read pending index marker ${path}`);
                }
            }
        } finally {
            enumerator.close(null);
        }

        return entries;
    }

    _pendingMarkerPath(conversationId) {
        const digest = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256,
            String(conversationId ?? ''),
            -1,
        );

        return GLib.build_filenamev([this.pendingIndexPath, `${digest}.json`]);
    }
}
