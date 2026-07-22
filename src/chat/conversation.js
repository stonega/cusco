import GLib from 'gi://GLib?version=2.0';

import { normalizeArtifacts } from './artifacts.js';
import { DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from '../providers/thinking.js';
import { normalizeTokenUsage } from '../providers/usage.js';

const NEW_CHAT_TITLE = 'New chat';
const TITLE_MAX_LENGTH = 42;

function now() {
    return new Date().toISOString();
}

function createTitleFromMessage(content) {
    const normalized = content.replace(/\s+/g, ' ').trim();

    if (!normalized)
        return NEW_CHAT_TITLE;

    if (normalized.length <= TITLE_MAX_LENGTH)
        return normalized;

    return `${normalized.slice(0, TITLE_MAX_LENGTH - 1).trim()}...`;
}

function normalizeList(values) {
    return Array.isArray(values)
        ? values.map((value) => String(value).trim()).filter(Boolean)
        : [];
}

function normalizeMetadata(metadata) {
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...metadata }
        : {};
}

function normalizeMessage(message) {
    const toolCall = message.toolCall ? { ...message.toolCall } : null;

    if (toolCall)
        toolCall.artifacts = normalizeArtifacts(toolCall.artifacts);

    return {
        id: message.id ?? GLib.uuid_string_random(),
        role: message.role,
        content: String(message.content ?? ''),
        attachments: Array.isArray(message.attachments) ? message.attachments.map((attachment) => ({ ...attachment })) : [],
        artifacts: normalizeArtifacts(message.artifacts),
        reasoning: normalizeReasoning(message.reasoning),
        usage: normalizeUsage(message.usage),
        toolCall,
        cronRun: message.cronRun ? { ...message.cronRun } : null,
        metadata: normalizeMetadata(message.metadata),
        createdAt: message.createdAt ?? now(),
    };
}

function normalizeReasoning(reasoning) {
    if (typeof reasoning === 'string') {
        const content = reasoning.trim();
        return content ? { content } : null;
    }

    if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning))
        return null;

    const content = String(reasoning.content ?? reasoning.text ?? '').trim();

    if (!content)
        return null;

    return {
        content,
        providerId: String(reasoning.providerId ?? ''),
        modelId: String(reasoning.modelId ?? ''),
        thinkingLevel: reasoning.thinkingLevel
            ? normalizeThinkingLevel(reasoning.thinkingLevel)
            : '',
        agentMode: Boolean(reasoning.agentMode),
        createdAt: reasoning.createdAt ?? now(),
    };
}

function normalizeUsage(usage) {
    return normalizeTokenUsage(usage);
}

function normalizeConversationType(value) {
    return value === 'cron' ? 'cron' : 'chat';
}

export class ConversationManager {
    constructor({ providerId, modelId, thinkingLevel = DEFAULT_THINKING_LEVEL, store = null }) {
        this._store = store;
        this._usesLazyStore = Boolean(
            store?.supportsLazyLoading
            && typeof store.loadConversation === 'function'
            && typeof store.saveConversation === 'function'
            && typeof store.saveIndex === 'function',
        );
        this._hydratedConversationIds = new Set();
        this._conversationLoadErrors = new Map();
        this._dirtyConversationIds = new Set();
        this._storeLoadError = null;
        const stored = this._loadStoredConversations();

        this._conversations = stored.conversations.map((conversation) => (
            this._prepareConversation(conversation)
        ));
        this._activeConversationId = null;
        this._defaultProviderId = providerId;
        this._defaultModelId = modelId;
        this._defaultThinkingLevel = normalizeThinkingLevel(thinkingLevel);

        if (stored.activeConversationId && !this.getConversation(stored.activeConversationId)?.archived)
            this._activeConversationId = stored.activeConversationId;
        else
            this._activeConversationId = this._conversations.find((conversation) => !conversation.archived)?.id
                ?? null;
    }

    get conversations() {
        return this._conversations.filter((conversation) => !conversation.archived);
    }

    get archivedConversations() {
        return this._conversations.filter((conversation) => conversation.archived);
    }

    get allConversations() {
        return [...this._conversations];
    }

    get activeConversation() {
        return this.getConversation(this._activeConversationId);
    }

    get storageError() {
        return this._storeLoadError;
    }

    createConversation(options = {}) {
        const timestamp = now();
        const conversation = this._prepareConversation({
            id: GLib.uuid_string_random(),
            title: options.title ?? NEW_CHAT_TITLE,
            providerId: options.providerId ?? this._defaultProviderId,
            modelId: options.modelId ?? this._defaultModelId,
            thinkingLevel: normalizeThinkingLevel(options.thinkingLevel ?? this._defaultThinkingLevel),
            messages: options.messages ? options.messages.map(normalizeMessage) : [],
            archived: false,
            memoryEnabled: options.memoryEnabled !== false,
            agentModeEnabled: Boolean(options.agentModeEnabled),
            folderId: options.folderId ?? '',
            tags: normalizeList(options.tags),
            profileId: options.profileId ?? '',
            skillIds: normalizeList(options.skillIds),
            conversationType: normalizeConversationType(options.conversationType),
            cronJobId: String(options.cronJobId ?? ''),
            createdAt: timestamp,
            updatedAt: timestamp,
        });

        this._conversations.unshift(conversation);
        this._activeConversationId = conversation.id;
        this._persist(conversation);

        if (this._usesLazyStore)
            this._persistActiveConversationId();

        return conversation;
    }

    getConversation(conversationId) {
        return this._conversations.find((conversation) => conversation.id === conversationId) ?? null;
    }

    selectConversation(conversationId) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        if (this._activeConversationId === conversationId)
            return conversation;

        this._activeConversationId = conversationId;
        this._persistActiveConversationId();
        return conversation;
    }

    appendMessage(conversationId, message, options = {}) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        const normalizedMessage = normalizeMessage(message);
        conversation.messages.push(normalizedMessage);
        conversation.messageCount = conversation.messages.length;
        conversation.updatedAt = now();

        if (normalizedMessage.role === 'user' && conversation.title === NEW_CHAT_TITLE)
            conversation.title = createTitleFromMessage(normalizedMessage.content);

        this._moveToTop(conversationId);
        this._persistMutation(options, conversation);
        return conversation;
    }

    updateMessageContent(conversationId, messageId, content, options = {}) {
        const { conversation, message } = this._getMessageRecord(conversationId, messageId);

        message.content = String(content ?? '');
        conversation.updatedAt = now();
        this._persistMutation(options, conversation);
        return message;
    }

    updateMessageMetadata(conversationId, messageId, metadata, options = {}) {
        const { conversation, message } = this._getMessageRecord(conversationId, messageId);

        message.metadata = normalizeMetadata(metadata);
        conversation.updatedAt = now();
        this._persistMutation(options, conversation);
        return message;
    }

    truncateAfterMessage(conversationId, messageId, { includeMessage = false } = {}) {
        const { conversation, index } = this._getMessageRecord(conversationId, messageId);
        const deleteFrom = includeMessage ? index : index + 1;

        if (deleteFrom < conversation.messages.length)
            conversation.messages.splice(deleteFrom);

        conversation.messageCount = conversation.messages.length;
        conversation.updatedAt = now();
        this._persist(conversation);
        return conversation;
    }

    branchFromMessage(conversationId, messageId) {
        const { conversation, index } = this._getMessageRecord(conversationId, messageId);
        const messages = conversation.messages.slice(0, index + 1).map((message) => ({
            ...message,
            id: GLib.uuid_string_random(),
        }));

        return this.createConversation({
            title: `${conversation.title} branch`,
            providerId: conversation.providerId,
            modelId: conversation.modelId,
            memoryEnabled: conversation.memoryEnabled !== false,
            agentModeEnabled: Boolean(conversation.agentModeEnabled),
            thinkingLevel: normalizeThinkingLevel(conversation.thinkingLevel),
            folderId: conversation.folderId,
            tags: conversation.tags,
            profileId: conversation.profileId,
            skillIds: conversation.skillIds,
            messages,
        });
    }

    renameConversation(conversationId, title) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        const normalizedTitle = String(title ?? '').replace(/\s+/g, ' ').trim();
        conversation.title = normalizedTitle || NEW_CHAT_TITLE;
        conversation.updatedAt = now();
        this._persist(conversation);
        return conversation;
    }

    archiveConversation(conversationId, archived = true) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.archived = Boolean(archived);
        conversation.updatedAt = now();

        const activeConversationChanged = this._activeConversationId === conversationId
            && conversation.archived;

        if (activeConversationChanged)
            this._activeConversationId = this._conversations.find((item) => !item.archived)?.id
                ?? null;

        this._persist(conversation);

        if (activeConversationChanged && this._usesLazyStore)
            this._persistActiveConversationId();
        return conversation;
    }

    deleteConversation(conversationId) {
        const index = this._conversations.findIndex((conversation) => conversation.id === conversationId);

        if (index < 0)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        const [conversation] = this._conversations.splice(index, 1);

        const activeConversationChanged = this._activeConversationId === conversationId;

        if (activeConversationChanged)
            this._activeConversationId = this._conversations.find((item) => !item.archived)?.id
                ?? null;

        this._persistDeletion(conversationId);

        if (activeConversationChanged && this._usesLazyStore)
            this._persistActiveConversationId();
        return conversation;
    }

    searchConversations(query, { includeArchived = false, limit = Number.MAX_SAFE_INTEGER } = {}) {
        const normalizedQuery = String(query ?? '').trim().toLowerCase();
        const safeLimit = Math.max(0, Number(limit) || 0);

        if (safeLimit === 0)
            return [];

        if (!normalizedQuery) {
            const results = [];

            for (const conversation of this._conversations) {
                if (!includeArchived && conversation.archived)
                    continue;

                results.push(conversation);

                if (results.length >= safeLimit)
                    break;
            }

            return results;
        }

        const conversations = includeArchived ? this._conversations : this.conversations;

        if (this._usesLazyStore
            && !this._storeLoadError
            && typeof this._store.search === 'function') {
            const hydratedMatches = new Set();
            const persistedConversations = [];

            for (const conversation of conversations) {
                if (!this._hydratedConversationIds.has(conversation.id)) {
                    persistedConversations.push(conversation);
                    continue;
                }

                const titleMatches = conversation.title.toLowerCase().includes(normalizedQuery);
                const messageMatches = conversation.messages.some((message) => (
                    message.content.toLowerCase().includes(normalizedQuery)
                ));

                if (titleMatches || messageMatches)
                    hydratedMatches.add(conversation.id);
            }

            const matches = this._store.search(normalizedQuery, {
                conversations: persistedConversations,
                includeArchived,
                limit,
            });
            const matchedIds = new Set([
                ...hydratedMatches,
                ...matches.map((match) => match.id),
            ]);

            return conversations
                .filter((conversation) => matchedIds.has(conversation.id))
                .slice(0, safeLimit);
        }

        return conversations.filter((conversation) => {
            const titleMatches = conversation.title.toLowerCase().includes(normalizedQuery);
            const messageMatches = conversation.messages.some((message) => (
                message.content.toLowerCase().includes(normalizedQuery)
            ));
            return titleMatches || messageMatches;
        }).slice(0, safeLimit);
    }

    conversationPage(query = '', options = {}) {
        const offset = Math.max(0, Number(options.offset) || 0);
        const limit = Math.max(1, Number(options.limit) || 50);
        const candidates = this.searchConversations(query, {
            includeArchived: Boolean(options.includeArchived),
            limit: offset + limit + 1,
        });

        return {
            conversations: candidates.slice(offset, offset + limit),
            hasMore: candidates.length > offset + limit,
        };
    }

    conversationPosition(conversationId, { includeArchived = false } = {}) {
        let position = 0;

        for (const conversation of this._conversations) {
            if (!includeArchived && conversation.archived)
                continue;

            if (conversation.id === conversationId)
                return position;

            position += 1;
        }

        return -1;
    }

    updateProviderConfig(conversationId, { providerId, modelId }) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.providerId = providerId;
        conversation.modelId = modelId;
        conversation.updatedAt = now();
        this._persist(conversation);
        return conversation;
    }

    setMemoryEnabled(conversationId, enabled) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.memoryEnabled = Boolean(enabled);
        conversation.updatedAt = now();
        this._persist(conversation);
        return conversation;
    }

    setAgentModeEnabled(conversationId, enabled) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.agentModeEnabled = Boolean(enabled);
        conversation.updatedAt = now();
        this._persist(conversation);
        return conversation;
    }

    setThinkingLevel(conversationId, level) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.thinkingLevel = normalizeThinkingLevel(level);
        conversation.updatedAt = now();
        this._persist(conversation);
        return conversation;
    }

    setSkillIds(conversationId, skillIds) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.skillIds = normalizeList(skillIds);
        conversation.updatedAt = now();
        this._persist(conversation);
        return conversation;
    }

    setCronMetadata(conversationId, { cronJobId = null, conversationType = null } = {}) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        if (conversationType !== null)
            conversation.conversationType = normalizeConversationType(conversationType);

        if (cronJobId !== null)
            conversation.cronJobId = String(cronJobId ?? '');

        conversation.updatedAt = now();
        this._persist(conversation);
        return conversation;
    }

    updateWorkspaceMetadata(conversationId, { folderId = null, tags = null, profileId = null }) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        if (folderId !== null)
            conversation.folderId = String(folderId ?? '');

        if (tags !== null) {
            conversation.tags = Array.isArray(tags)
                ? normalizeList(tags)
                : normalizeList(String(tags ?? '').split(','));
        }

        if (profileId !== null)
            conversation.profileId = String(profileId ?? '');

        conversation.updatedAt = now();
        this._persist(conversation);
        return conversation;
    }

    updateMessageReasoning(conversationId, messageId, reasoning, options = {}) {
        const { conversation, message } = this._getMessageRecord(conversationId, messageId);

        message.reasoning = normalizeReasoning(reasoning);
        conversation.updatedAt = now();
        this._persistMutation(options, conversation);
        return message;
    }

    updateMessageArtifacts(conversationId, messageId, artifacts, options = {}) {
        const { conversation, message } = this._getMessageRecord(conversationId, messageId);

        message.artifacts = normalizeArtifacts(artifacts);
        conversation.updatedAt = now();
        this._persistMutation(options, conversation);
        return message;
    }

    updateMessageUsage(conversationId, messageId, usage, options = {}) {
        const { conversation, message } = this._getMessageRecord(conversationId, messageId);

        message.usage = normalizeUsage(usage);
        conversation.updatedAt = now();
        this._persistMutation(options, conversation);
        return message;
    }

    updateMessageToolCall(conversationId, messageId, toolCall, content = null) {
        const { conversation, message } = this._getMessageRecord(conversationId, messageId);

        if (content !== null)
            message.content = String(content ?? '');

        if (toolCall && typeof toolCall === 'object') {
            message.toolCall = {
                ...toolCall,
                artifacts: normalizeArtifacts(toolCall.artifacts),
            };
        } else {
            message.toolCall = null;
        }
        conversation.updatedAt = now();
        this._persist(conversation);
        return message;
    }

    replaceMessages(conversationId, messages) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.messages = Array.isArray(messages)
            ? messages.map(normalizeMessage)
            : [];
        conversation.messageCount = conversation.messages.length;
        conversation.updatedAt = now();
        this._moveToTop(conversationId);
        this._persist(conversation);
        return conversation;
    }

    persist() {
        this._persist(null, { allHydrated: true });
    }

    isConversationHydrated(conversationId) {
        return this._hydratedConversationIds.has(conversationId);
    }

    conversationLoadError(conversationId) {
        return this._conversationLoadErrors.get(conversationId) ?? null;
    }

    _moveToTop(conversationId) {
        const index = this._conversations.findIndex((conversation) => conversation.id === conversationId);

        if (index <= 0)
            return;

        const [conversation] = this._conversations.splice(index, 1);
        this._conversations.unshift(conversation);
    }

    _getMessageRecord(conversationId, messageId) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        const index = conversation.messages.findIndex((message) => message.id === messageId);

        if (index < 0)
            throw new Error(`Message does not exist: ${messageId}`);

        return {
            conversation,
            message: conversation.messages[index],
            index,
        };
    }

    _loadStoredConversations() {
        if (!this._store)
            return { conversations: [], activeConversationId: null };

        try {
            return this._store.load();
        } catch (error) {
            this._storeLoadError = error;
            logError(error, 'Failed to load local conversation database');
            return { conversations: [], activeConversationId: null };
        }
    }

    _prepareConversation(source) {
        const hasMessages = Array.isArray(source?.messages);
        let messages = hasMessages
            ? source.messages.map(normalizeMessage)
            : null;
        const conversation = { ...source };
        delete conversation.messages;

        // Preserve the public object shape while deferring the record read until
        // a transcript consumer actually touches messages.
        Object.defineProperty(conversation, 'messages', {
            enumerable: true,
            configurable: false,
            get: () => {
                if (messages === null) {
                    const loadedMessages = this._loadConversationMessages(conversation.id);
                    messages = loadedMessages ?? [];
                    conversation.messageCount = messages.length;

                    if (loadedMessages !== null) {
                        this._conversationLoadErrors.delete(conversation.id);
                        this._hydratedConversationIds.add(conversation.id);
                    }
                }

                return messages;
            },
            set: (value) => {
                messages = Array.isArray(value)
                    ? value.map(normalizeMessage)
                    : [];
                conversation.messageCount = messages.length;
                this._conversationLoadErrors.delete(conversation.id);
                this._hydratedConversationIds.add(conversation.id);
            },
        });

        if (hasMessages) {
            conversation.messageCount = messages.length;
            this._hydratedConversationIds.add(conversation.id);
        } else {
            conversation.messageCount = Math.max(0, Number(conversation.messageCount) || 0);
        }

        return conversation;
    }

    _loadConversationMessages(conversationId) {
        if (!this._usesLazyStore)
            return [];

        try {
            return this._store.loadConversation(conversationId).messages.map(normalizeMessage);
        } catch (error) {
            logError(error, `Failed to load conversation transcript ${conversationId}`);
            this._conversationLoadErrors.set(conversationId, error);
            return null;
        }
    }

    _persist(conversation = null, { allHydrated = false } = {}) {
        if (!this._store || this._storeLoadError)
            return;

        try {
            if (this._usesLazyStore) {
                if (conversation)
                    this._dirtyConversationIds.add(conversation.id);

                const conversationIds = new Set(this._dirtyConversationIds);

                if (allHydrated) {
                    for (const conversationId of this._hydratedConversationIds)
                        conversationIds.add(conversationId);
                }

                for (const conversationId of conversationIds) {
                    const storedConversation = this._conversations.find((item) => (
                        item.id === conversationId
                    ));

                    if (!storedConversation)
                        continue;

                    const summary = this._store.saveConversation(storedConversation, {
                        messagesLoaded: this._hydratedConversationIds.has(conversationId),
                    });
                    this._applyPersistedSummary(storedConversation, summary);
                }

                this._store.saveIndex({
                    conversations: this._conversations,
                    activeConversationId: this._activeConversationId,
                });

                for (const conversationId of conversationIds)
                    this._dirtyConversationIds.delete(conversationId);
            } else {
                this._store.save({
                    conversations: this._conversations,
                    activeConversationId: this._activeConversationId,
                }, { normalized: true });
            }
        } catch (error) {
            logError(error, 'Failed to save local conversation database');
        }
    }

    _persistMutation(options, conversation) {
        if (options.persist === false) {
            if (this._usesLazyStore)
                this._dirtyConversationIds.add(conversation.id);
            return;
        }

        this._persist(conversation);
    }

    _persistDeletion(conversationId) {
        if (this._storeLoadError)
            return;

        if (!this._usesLazyStore) {
            this._persist();
            return;
        }

        this._dirtyConversationIds.delete(conversationId);
        this._hydratedConversationIds.delete(conversationId);
        this._conversationLoadErrors.delete(conversationId);

        try {
            this._store.discardPendingConversation?.(conversationId);
            this._store.saveIndex({
                conversations: this._conversations,
                activeConversationId: this._activeConversationId,
            });
            this._store.deleteConversation(conversationId);
        } catch (error) {
            logError(error, `Failed to delete conversation ${conversationId}`);
        }
    }

    _applyPersistedSummary(conversation, summary) {
        for (const [key, value] of Object.entries(summary ?? {})) {
            if (key !== 'id' && key !== 'messages')
                conversation[key] = value;
        }
    }

    _persistActiveConversationId() {
        if (!this._store || this._storeLoadError)
            return;

        try {
            if (typeof this._store.saveActiveConversationId === 'function')
                this._store.saveActiveConversationId(this._activeConversationId);
            else
                this._persist();
        } catch (error) {
            logError(error, 'Failed to save active conversation state');
        }
    }
}
