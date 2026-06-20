import GLib from 'gi://GLib?version=2.0';

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

function normalizeMessage(message) {
    return {
        id: message.id ?? GLib.uuid_string_random(),
        role: message.role,
        content: String(message.content ?? ''),
        attachments: Array.isArray(message.attachments) ? message.attachments.map((attachment) => ({ ...attachment })) : [],
        toolCall: message.toolCall ? { ...message.toolCall } : null,
        createdAt: message.createdAt ?? now(),
    };
}

export class ConversationManager {
    constructor({ providerId, modelId, store = null }) {
        this._store = store;
        const stored = this._loadStoredConversations();

        this._conversations = stored.conversations;
        this._activeConversationId = null;
        this._defaultProviderId = providerId;
        this._defaultModelId = modelId;

        if (stored.activeConversationId && this.getConversation(stored.activeConversationId))
            this._activeConversationId = stored.activeConversationId;
        else
            this._activeConversationId = this._conversations.find((conversation) => !conversation.archived)?.id
                ?? this._conversations[0]?.id
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

    createConversation(options = {}) {
        const timestamp = now();
        const conversation = {
            id: GLib.uuid_string_random(),
            title: options.title ?? NEW_CHAT_TITLE,
            providerId: options.providerId ?? this._defaultProviderId,
            modelId: options.modelId ?? this._defaultModelId,
            messages: options.messages ? options.messages.map(normalizeMessage) : [],
            archived: false,
            memoryEnabled: options.memoryEnabled !== false,
            agentModeEnabled: Boolean(options.agentModeEnabled),
            folderId: options.folderId ?? '',
            tags: normalizeList(options.tags),
            profileId: options.profileId ?? '',
            skillIds: normalizeList(options.skillIds),
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        this._conversations.unshift(conversation);
        this._activeConversationId = conversation.id;
        this._persist();

        return conversation;
    }

    getConversation(conversationId) {
        return this._conversations.find((conversation) => conversation.id === conversationId) ?? null;
    }

    selectConversation(conversationId) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        this._activeConversationId = conversationId;
        this._persist();
        return conversation;
    }

    appendMessage(conversationId, message) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        const normalizedMessage = normalizeMessage(message);
        conversation.messages.push(normalizedMessage);
        conversation.updatedAt = now();

        if (normalizedMessage.role === 'user' && conversation.title === NEW_CHAT_TITLE)
            conversation.title = createTitleFromMessage(normalizedMessage.content);

        this._moveToTop(conversationId);
        this._persist();
        return conversation;
    }

    updateMessageContent(conversationId, messageId, content) {
        const { conversation, message } = this._getMessageRecord(conversationId, messageId);

        message.content = String(content ?? '');
        conversation.updatedAt = now();
        this._persist();
        return message;
    }

    truncateAfterMessage(conversationId, messageId, { includeMessage = false } = {}) {
        const { conversation, index } = this._getMessageRecord(conversationId, messageId);
        const deleteFrom = includeMessage ? index : index + 1;

        if (deleteFrom < conversation.messages.length)
            conversation.messages.splice(deleteFrom);

        conversation.updatedAt = now();
        this._persist();
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
        this._persist();
        return conversation;
    }

    archiveConversation(conversationId, archived = true) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.archived = Boolean(archived);
        conversation.updatedAt = now();

        if (this._activeConversationId === conversationId && conversation.archived)
            this._activeConversationId = this._conversations.find((item) => !item.archived)?.id
                ?? conversation.id;

        this._persist();
        return conversation;
    }

    deleteConversation(conversationId) {
        const index = this._conversations.findIndex((conversation) => conversation.id === conversationId);

        if (index < 0)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        const [conversation] = this._conversations.splice(index, 1);

        if (this._activeConversationId === conversationId)
            this._activeConversationId = this._conversations.find((item) => !item.archived)?.id
                ?? this._conversations[0]?.id
                ?? null;

        this._persist();
        return conversation;
    }

    searchConversations(query, { includeArchived = false } = {}) {
        const normalizedQuery = String(query ?? '').trim().toLowerCase();
        const conversations = includeArchived ? this._conversations : this.conversations;

        if (!normalizedQuery)
            return [...conversations];

        return conversations.filter((conversation) => {
            const titleMatches = conversation.title.toLowerCase().includes(normalizedQuery);
            const messageMatches = conversation.messages.some((message) => (
                message.content.toLowerCase().includes(normalizedQuery)
            ));
            return titleMatches || messageMatches;
        });
    }

    updateProviderConfig(conversationId, { providerId, modelId }) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.providerId = providerId;
        conversation.modelId = modelId;
        conversation.updatedAt = now();
        this._persist();
        return conversation;
    }

    setMemoryEnabled(conversationId, enabled) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.memoryEnabled = Boolean(enabled);
        conversation.updatedAt = now();
        this._persist();
        return conversation;
    }

    setAgentModeEnabled(conversationId, enabled) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.agentModeEnabled = Boolean(enabled);
        conversation.updatedAt = now();
        this._persist();
        return conversation;
    }

    setSkillIds(conversationId, skillIds) {
        const conversation = this.getConversation(conversationId);

        if (!conversation)
            throw new Error(`Conversation does not exist: ${conversationId}`);

        conversation.skillIds = normalizeList(skillIds);
        conversation.updatedAt = now();
        this._persist();
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
        this._persist();
        return conversation;
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
            logError(error, 'Failed to load local conversation database');
            return { conversations: [], activeConversationId: null };
        }
    }

    _persist() {
        if (!this._store)
            return;

        try {
            this._store.save({
                conversations: this._conversations,
                activeConversationId: this._activeConversationId,
            });
        } catch (error) {
            logError(error, 'Failed to save local conversation database');
        }
    }
}
