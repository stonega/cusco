import GLib from 'gi://GLib?version=2.0';

const MEMORY_PROPOSAL_PATTERNS = [
    {
        reason: 'The message explicitly asks Cusco to remember this.',
        pattern: /\bremember(?: that)?\s+(.+?)(?:[.!?]+)?$/i,
        format: (match) => match[1],
    },
    {
        reason: 'The message appears to share the user name.',
        pattern: /\bmy name is\s+([^.!?]+)(?:[.!?]+)?$/i,
        format: (match) => `The user's name is ${match[1].trim()}.`,
    },
    {
        reason: 'The message appears to share a preference.',
        pattern: /\bi prefer\s+([^.!?]+)(?:[.!?]+)?$/i,
        format: (match) => `The user prefers ${match[1].trim()}.`,
    },
    {
        reason: 'The message appears to share something the user likes.',
        pattern: /\bi like\s+([^.!?]+)(?:[.!?]+)?$/i,
        format: (match) => `The user likes ${match[1].trim()}.`,
    },
    {
        reason: 'The message appears to share work context.',
        pattern: /\bi work (?:at|for|with)\s+([^.!?]+)(?:[.!?]+)?$/i,
        format: (match) => `The user works with ${match[1].trim()}.`,
    },
];

function now() {
    return new Date().toISOString();
}

function normalizeMemory(memory) {
    const timestamp = now();

    return {
        id: memory.id ?? GLib.uuid_string_random(),
        content: String(memory.content ?? '').trim(),
        enabled: memory.enabled !== false,
        pinned: Boolean(memory.pinned),
        sourceConversationId: String(memory.sourceConversationId ?? ''),
        sourceMessageId: String(memory.sourceMessageId ?? ''),
        createdAt: memory.createdAt ?? timestamp,
        updatedAt: memory.updatedAt ?? timestamp,
        lastUsedAt: memory.lastUsedAt ?? '',
    };
}

function normalizeUsageLogEntry(entry) {
    return {
        id: entry.id ?? GLib.uuid_string_random(),
        memoryId: String(entry.memoryId ?? ''),
        conversationId: String(entry.conversationId ?? ''),
        messageId: String(entry.messageId ?? ''),
        usedAt: entry.usedAt ?? now(),
    };
}

function searchableText(value) {
    return String(value ?? '').toLowerCase();
}

function memoryMatches(memory, query) {
    const normalizedQuery = searchableText(query).trim();

    if (!normalizedQuery)
        return true;

    return searchableText(memory.content).includes(normalizedQuery);
}

function scoreMemory(memory, query) {
    let score = memory.pinned ? 100 : 0;
    const normalizedQuery = searchableText(query).trim();

    if (normalizedQuery && searchableText(memory.content).includes(normalizedQuery))
        score += 10;

    if (memory.lastUsedAt)
        score += 1;

    return score;
}

export class MemoryManager {
    constructor({ store = null } = {}) {
        this._store = store;
        const stored = this._loadStoredMemories();
        this._memories = stored.memories.map(normalizeMemory).filter((memory) => memory.content);
        this._usageLog = stored.usageLog.map(normalizeUsageLogEntry).filter((entry) => entry.memoryId);
    }

    get memories() {
        return [...this._memories];
    }

    get usageLog() {
        return [...this._usageLog];
    }

    createProposalFromMessage(message, conversation) {
        const content = String(message?.content ?? '').trim();

        if (!content)
            return null;

        for (const proposalPattern of MEMORY_PROPOSAL_PATTERNS) {
            const match = content.match(proposalPattern.pattern);

            if (!match)
                continue;

            const proposedContent = proposalPattern.format(match).replace(/\s+/g, ' ').trim();

            if (!proposedContent || this._hasSimilarMemory(proposedContent))
                return null;

            return {
                content: proposedContent,
                reason: proposalPattern.reason,
                sourceConversationId: conversation?.id ?? '',
                sourceMessageId: message?.id ?? '',
            };
        }

        return null;
    }

    addMemory(memory) {
        const normalized = normalizeMemory(memory);

        if (!normalized.content)
            throw new Error('Memory content cannot be empty');

        const existing = this._memories.find((item) => (
            searchableText(item.content) === searchableText(normalized.content)
        ));

        if (existing) {
            existing.enabled = true;
            existing.updatedAt = now();
            this._persist();
            return existing;
        }

        this._memories.unshift(normalized);
        this._persist();
        return normalized;
    }

    updateMemory(memoryId, updates) {
        const memory = this.getMemory(memoryId);

        if (!memory)
            throw new Error(`Memory does not exist: ${memoryId}`);

        if (Object.hasOwn(updates, 'content')) {
            const content = String(updates.content ?? '').trim();

            if (!content)
                throw new Error('Memory content cannot be empty');

            memory.content = content;
        }

        if (Object.hasOwn(updates, 'enabled'))
            memory.enabled = Boolean(updates.enabled);

        if (Object.hasOwn(updates, 'pinned'))
            memory.pinned = Boolean(updates.pinned);

        memory.updatedAt = now();
        this._persist();
        return memory;
    }

    deleteMemory(memoryId) {
        const index = this._memories.findIndex((memory) => memory.id === memoryId);

        if (index < 0)
            throw new Error(`Memory does not exist: ${memoryId}`);

        const [memory] = this._memories.splice(index, 1);
        this._usageLog = this._usageLog.filter((entry) => entry.memoryId !== memoryId);
        this._persist();
        return memory;
    }

    getMemory(memoryId) {
        return this._memories.find((memory) => memory.id === memoryId) ?? null;
    }

    searchMemories(query, { includeDisabled = true } = {}) {
        return this._memories
            .filter((memory) => includeDisabled || memory.enabled)
            .filter((memory) => memoryMatches(memory, query))
            .sort((left, right) => (
                scoreMemory(right, query) - scoreMemory(left, query)
                || right.updatedAt.localeCompare(left.updatedAt)
            ));
    }

    getMemoriesForConversation(conversation, { latestText = '', limit = 6 } = {}) {
        if (conversation?.memoryEnabled === false)
            return [];

        const enabledMemories = this._memories.filter((memory) => memory.enabled);
        const pinnedMemories = enabledMemories.filter((memory) => memory.pinned);
        const matchingMemories = enabledMemories.filter((memory) => (
            !memory.pinned && memoryMatches(memory, latestText)
        ));
        const selected = [...pinnedMemories, ...matchingMemories];

        if (selected.length === 0)
            return enabledMemories.slice(0, limit);

        return selected.slice(0, limit);
    }

    recordMemoryUse(memoryIds, { conversationId = '', messageId = '' } = {}) {
        const usedAt = now();
        const entries = [];

        for (const memoryId of memoryIds) {
            const memory = this.getMemory(memoryId);

            if (!memory)
                continue;

            memory.lastUsedAt = usedAt;
            const entry = normalizeUsageLogEntry({
                memoryId,
                conversationId,
                messageId,
                usedAt,
            });
            this._usageLog.unshift(entry);
            entries.push(entry);
        }

        this._persist();
        return entries;
    }

    getAuditLog(memoryId = null) {
        if (!memoryId)
            return this.usageLog;

        return this._usageLog.filter((entry) => entry.memoryId === memoryId);
    }

    exportData() {
        return JSON.stringify({
            version: 1,
            memories: this._memories,
            usageLog: this._usageLog,
        }, null, 2);
    }

    importData(contents, { merge = true } = {}) {
        const parsed = JSON.parse(String(contents ?? '{}'));
        const incomingMemories = Array.isArray(parsed.memories)
            ? parsed.memories.map(normalizeMemory).filter((memory) => memory.content)
            : [];
        const incomingUsageLog = Array.isArray(parsed.usageLog)
            ? parsed.usageLog.map(normalizeUsageLogEntry).filter((entry) => entry.memoryId)
            : [];

        if (!merge) {
            this._memories = incomingMemories;
            this._usageLog = incomingUsageLog;
            this._persist();
            return {
                importedMemories: incomingMemories.length,
                importedUsageLogEntries: incomingUsageLog.length,
            };
        }

        let importedMemories = 0;
        const existingIds = new Set(this._memories.map((memory) => memory.id));
        const existingContent = new Set(this._memories.map((memory) => searchableText(memory.content)));

        for (const memory of incomingMemories) {
            if (existingIds.has(memory.id) || existingContent.has(searchableText(memory.content)))
                continue;

            this._memories.push(memory);
            importedMemories++;
        }

        const existingLogIds = new Set(this._usageLog.map((entry) => entry.id));
        let importedUsageLogEntries = 0;

        for (const entry of incomingUsageLog) {
            if (existingLogIds.has(entry.id))
                continue;

            this._usageLog.push(entry);
            importedUsageLogEntries++;
        }

        this._persist();
        return { importedMemories, importedUsageLogEntries };
    }

    _hasSimilarMemory(content) {
        const normalizedContent = searchableText(content);
        return this._memories.some((memory) => searchableText(memory.content) === normalizedContent);
    }

    _loadStoredMemories() {
        if (!this._store)
            return { memories: [], usageLog: [] };

        try {
            return this._store.load();
        } catch (error) {
            logError(error, 'Failed to load local memory database');
            return { memories: [], usageLog: [] };
        }
    }

    _persist() {
        if (!this._store)
            return;

        try {
            this._store.save({
                memories: this._memories,
                usageLog: this._usageLog,
            });
        } catch (error) {
            logError(error, 'Failed to save local memory database');
        }
    }
}
