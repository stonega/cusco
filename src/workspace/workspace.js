import GLib from 'gi://GLib?version=2.0';

import {
    buildSkillContext,
    DEFAULT_GLOBAL_SKILLS_PATH,
    discoverInstalledSkills,
    loadSkillFromPath,
} from '../skills/skills.js';
import { normalizeMcpServerConfig } from '../mcp/config.js';

function now() {
    return new Date().toISOString();
}

function normalizeList(values) {
    return Array.isArray(values)
        ? values.map((value) => String(value).trim()).filter(Boolean)
        : [];
}

function normalizeRecord(record, defaults = {}) {
    const timestamp = now();

    return {
        id: record.id ?? GLib.uuid_string_random(),
        createdAt: record.createdAt ?? timestamp,
        updatedAt: record.updatedAt ?? timestamp,
        ...defaults,
        ...record,
    };
}

function defaultWorkspaceData() {
    return {
        prompts: [],
        profiles: [],
        folders: [],
        skills: [],
        pluginTools: [],
        mcpServers: [],
        cacheEntries: [],
    };
}

function normalizeSkillRecord(skill) {
    const normalized = normalizeRecord(skill, {
        name: 'Skill',
        description: '',
        path: '',
        source: 'custom',
        enabled: false,
        selectedByDefault: false,
        loadError: '',
    });

    delete normalized.content;

    return {
        ...normalized,
        name: String(normalized.name ?? '').trim() || 'Skill',
        description: String(normalized.description ?? '').trim(),
        path: String(normalized.path ?? '').trim(),
        source: normalized.source === 'global' ? 'global' : 'custom',
        enabled: Boolean(normalized.enabled),
        selectedByDefault: Boolean(normalized.selectedByDefault),
        loadError: String(normalized.loadError ?? '').trim(),
    };
}

function mergeSkillState(discoveredSkill, existingSkill = null) {
    return normalizeSkillRecord({
        ...discoveredSkill,
        enabled: existingSkill?.enabled ?? discoveredSkill.enabled,
        selectedByDefault: existingSkill?.selectedByDefault ?? discoveredSkill.selectedByDefault,
        createdAt: existingSkill?.createdAt ?? discoveredSkill.createdAt,
    });
}

export class WorkspaceManager {
    constructor({ store = null, globalSkillsPath = DEFAULT_GLOBAL_SKILLS_PATH, autoDiscoverSkills = true } = {}) {
        this._store = store;
        this._globalSkillsPath = globalSkillsPath;
        const stored = {
            ...defaultWorkspaceData(),
            ...this._load(),
        };
        this._prompts = stored.prompts.map((prompt) => normalizeRecord(prompt, {
            title: 'Untitled Prompt',
            content: '',
            tags: [],
        }));
        this._profiles = stored.profiles.map((profile) => normalizeRecord(profile, {
            name: 'Agent Profile',
            systemPrompt: '',
            providerId: '',
            modelId: '',
            memoryEnabled: true,
            toolsEnabled: true,
            skillIds: [],
        }));
        this._profiles = this._profiles.map((profile) => ({
            ...profile,
            skillIds: normalizeList(profile.skillIds),
        }));
        this._folders = stored.folders.map((folder) => normalizeRecord(folder, {
            name: 'Folder',
            color: 'blue',
        }));
        this._skills = stored.skills.map(normalizeSkillRecord).filter((skill) => skill.id && skill.path);
        this._pluginTools = stored.pluginTools.map((tool) => normalizeRecord(tool, {
            name: 'Plugin Tool',
            command: '',
            enabled: false,
        }));
        this._mcpServers = stored.mcpServers.map((server) => normalizeRecord(
            normalizeMcpServerConfig(server, { source: 'workspace' }),
            {
                name: 'MCP Server',
                command: '',
                args: [],
                enabled: false,
            },
        ));
        this._cacheEntries = stored.cacheEntries.map((entry) => normalizeRecord(entry, {
            key: '',
            value: null,
            expiresAt: '',
        })).filter((entry) => entry.key);

        if (autoDiscoverSkills)
            this.refreshInstalledSkills({ persist: false });
    }

    get prompts() {
        return [...this._prompts];
    }

    get profiles() {
        return [...this._profiles];
    }

    get folders() {
        return [...this._folders];
    }

    get skills() {
        return this._skills.map((skill) => ({ ...skill }));
    }

    get enabledSkills() {
        return this._skills.filter((skill) => skill.enabled && !skill.loadError).map((skill) => ({ ...skill }));
    }

    get pluginTools() {
        return [...this._pluginTools];
    }

    get mcpServers() {
        return this._mcpServers.map((server) => ({
            ...server,
            args: [...server.args],
            env: { ...server.env },
            headers: { ...server.headers },
            roots: [...server.roots],
        }));
    }

    createPrompt({ title, content, tags = [] }) {
        const prompt = normalizeRecord({
            title: String(title ?? '').trim() || 'Untitled Prompt',
            content: String(content ?? ''),
            tags: normalizeList(tags),
        });
        this._prompts.unshift(prompt);
        this._persist();
        return prompt;
    }

    updatePrompt(promptId, updates = {}) {
        const index = this._prompts.findIndex((prompt) => prompt.id === promptId);

        if (index < 0)
            throw new Error(`Prompt does not exist: ${promptId}`);

        const existing = this._prompts[index];
        const prompt = {
            ...existing,
            ...updates,
            id: existing.id,
            createdAt: existing.createdAt,
            updatedAt: now(),
        };

        prompt.title = String(prompt.title ?? '').trim() || 'Untitled Prompt';
        prompt.content = String(prompt.content ?? '');
        prompt.tags = normalizeList(prompt.tags);

        this._prompts[index] = prompt;
        this._persist();
        return { ...prompt };
    }

    searchPrompts(query) {
        const normalizedQuery = String(query ?? '').trim().toLowerCase();
        return this._prompts.filter((prompt) => !normalizedQuery
            || prompt.title.toLowerCase().includes(normalizedQuery)
            || prompt.content.toLowerCase().includes(normalizedQuery)
            || prompt.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery)));
    }

    createProfile(profile) {
        const normalized = normalizeRecord({
            name: String(profile.name ?? '').trim() || 'Agent Profile',
            systemPrompt: String(profile.systemPrompt ?? ''),
            providerId: String(profile.providerId ?? ''),
            modelId: String(profile.modelId ?? ''),
            memoryEnabled: profile.memoryEnabled !== false,
            toolsEnabled: profile.toolsEnabled !== false,
            skillIds: normalizeList(profile.skillIds),
        });
        this._profiles.unshift(normalized);
        this._persist();
        return normalized;
    }

    getProfile(profileId) {
        return this._profiles.find((profile) => profile.id === profileId) ?? null;
    }

    createFolder(folder) {
        const normalized = normalizeRecord({
            name: String(folder.name ?? '').trim() || 'Folder',
            color: String(folder.color ?? 'blue'),
        });
        this._folders.unshift(normalized);
        this._persist();
        return normalized;
    }

    registerPluginTool(tool) {
        const normalized = normalizeRecord({
            name: String(tool.name ?? '').trim() || 'Plugin Tool',
            command: String(tool.command ?? ''),
            enabled: Boolean(tool.enabled),
        });
        this._pluginTools.unshift(normalized);
        this._persist();
        return normalized;
    }

    refreshInstalledSkills({ persist = true } = {}) {
        const discoveredSkills = discoverInstalledSkills({ rootPath: this._globalSkillsPath });
        const existingById = new Map(this._skills.map((skill) => [skill.id, skill]));
        const discoveredIds = new Set(discoveredSkills.map((skill) => skill.id));
        const customSkills = this._skills.filter((skill) => skill.source !== 'global');
        const missingGlobalSkills = this._skills
            .filter((skill) => skill.source === 'global' && !discoveredIds.has(skill.id))
            .map((skill) => normalizeSkillRecord({
                ...skill,
                enabled: false,
                selectedByDefault: false,
                loadError: 'Skill is no longer installed.',
                updatedAt: now(),
            }));

        this._skills = [
            ...discoveredSkills.map((skill) => mergeSkillState(skill, existingById.get(skill.id))),
            ...missingGlobalSkills,
            ...customSkills,
        ];

        if (persist)
            this._persist();

        return this.skills;
    }

    addSkillPath(path, { enabled = true } = {}) {
        const skill = loadSkillFromPath(path, {
            source: 'custom',
            enabled,
        });
        const existingIndex = this._skills.findIndex((item) => item.id === skill.id);
        const normalized = mergeSkillState(skill, existingIndex >= 0 ? this._skills[existingIndex] : null);

        normalized.enabled = enabled && !normalized.loadError;

        if (existingIndex >= 0)
            this._skills[existingIndex] = normalized;
        else
            this._skills.unshift(normalized);

        this._persist();
        return { ...normalized };
    }

    refreshSkill(skillId) {
        const index = this._skills.findIndex((skill) => skill.id === skillId);

        if (index < 0)
            throw new Error(`Skill does not exist: ${skillId}`);

        const existing = this._skills[index];
        const loaded = loadSkillFromPath(existing.path, {
            id: existing.id,
            source: existing.source,
            enabled: existing.enabled,
            selectedByDefault: existing.selectedByDefault,
        });
        const normalized = mergeSkillState(loaded, existing);

        if (normalized.loadError) {
            normalized.enabled = false;
            normalized.selectedByDefault = false;
        }

        this._skills[index] = normalized;
        this._persist();
        return { ...normalized };
    }

    setSkillEnabled(skillId, enabled) {
        const skill = this._getSkillRecord(skillId);

        skill.enabled = Boolean(enabled) && !skill.loadError;

        if (!skill.enabled)
            skill.selectedByDefault = false;

        skill.updatedAt = now();
        this._persist();
        return { ...skill };
    }

    setSkillSelectedByDefault(skillId, selectedByDefault) {
        const skill = this._getSkillRecord(skillId);

        if (skill.loadError)
            throw new Error(`Skill cannot be selected while it has a load error: ${skillId}`);

        skill.enabled = skill.enabled || Boolean(selectedByDefault);
        skill.selectedByDefault = Boolean(selectedByDefault);
        skill.updatedAt = now();
        this._persist();
        return { ...skill };
    }

    getSkill(skillId) {
        const skill = this._skills.find((item) => item.id === skillId);
        return skill ? { ...skill } : null;
    }

    loadSkill(skillId) {
        const skill = this._getSkillRecord(skillId);
        return loadSkillFromPath(skill.path, {
            id: skill.id,
            source: skill.source,
            enabled: skill.enabled,
            selectedByDefault: skill.selectedByDefault,
        });
    }

    resolveSkillIdsForConversation(conversation) {
        const conversationSkillIds = normalizeList(conversation?.skillIds);

        if (conversationSkillIds.length > 0) {
            const skillIds = new Set(conversationSkillIds);

            for (const skill of this._skills) {
                if (skill.enabled && !skill.loadError)
                    skillIds.add(skill.id);
            }

            return [...skillIds];
        }

        const profile = this.getProfile(conversation?.profileId);

        if (profile?.skillIds?.length > 0)
            return normalizeList(profile.skillIds);

        return this._skills
            .filter((skill) => skill.enabled && skill.selectedByDefault)
            .map((skill) => skill.id);
    }

    getSkillsForConversation(conversation) {
        return this.resolveSkillIdsForConversation(conversation)
            .map((skillId) => {
                const skill = this.getSkill(skillId);

                if (!skill?.enabled)
                    return null;

                return this.loadSkill(skillId);
            })
            .filter((skill) => skill && skill.enabled && !skill.loadError && skill.content);
    }

    buildSkillContextForConversation(conversation) {
        return buildSkillContext(this.getSkillsForConversation(conversation));
    }

    addMcpServer(server) {
        const normalized = normalizeRecord(normalizeMcpServerConfig({
            id: server.id ?? GLib.uuid_string_random(),
            ...server,
            enabled: Boolean(server.enabled),
        }, { source: 'workspace' }));
        this._mcpServers.unshift(normalized);
        this._persist();
        return normalized;
    }

    updateMcpServer(serverId, updates = {}) {
        const index = this._mcpServers.findIndex((server) => server.id === serverId);

        if (index < 0)
            throw new Error(`MCP server does not exist: ${serverId}`);

        const existing = this._mcpServers[index];
        const normalized = normalizeRecord(normalizeMcpServerConfig({
            ...existing,
            ...updates,
            id: existing.id,
            source: 'workspace',
            createdAt: existing.createdAt,
            updatedAt: now(),
        }, { source: 'workspace' }));

        this._mcpServers[index] = normalized;
        this._persist();
        return { ...normalized };
    }

    setMcpServerEnabled(serverId, enabled) {
        return this.updateMcpServer(serverId, { enabled: Boolean(enabled) });
    }

    deleteRecord(collectionName, recordId) {
        const collection = this[`_${collectionName}`];

        if (!Array.isArray(collection))
            throw new Error(`Unknown workspace collection: ${collectionName}`);

        const index = collection.findIndex((item) => item.id === recordId);

        if (index < 0)
            throw new Error(`Workspace record does not exist: ${recordId}`);

        const [record] = collection.splice(index, 1);
        this._persist();
        return record;
    }

    setCache(key, value, { ttlSeconds = 0 } = {}) {
        const normalizedKey = String(key ?? '').trim();

        if (!normalizedKey)
            throw new Error('Cache key cannot be empty');

        const existing = this._cacheEntries.find((entry) => entry.key === normalizedKey);
        const entry = existing ?? normalizeRecord({ key: normalizedKey });
        entry.value = value;
        entry.updatedAt = now();
        entry.expiresAt = ttlSeconds > 0
            ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
            : '';

        if (!existing)
            this._cacheEntries.unshift(entry);

        this._persist();
        return entry;
    }

    getCache(key) {
        const entry = this._cacheEntries.find((item) => item.key === key);

        if (!entry)
            return null;

        if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) {
            this._cacheEntries = this._cacheEntries.filter((item) => item.key !== key);
            this._persist();
            return null;
        }

        return entry.value;
    }

    _load() {
        if (!this._store)
            return {};

        try {
            return this._store.load();
        } catch (error) {
            logError(error, 'Failed to load workspace database');
            return {};
        }
    }

    _persist() {
        if (!this._store)
            return;

        this._store.save({
            prompts: this._prompts,
            profiles: this._profiles,
            folders: this._folders,
            skills: this._skills.map(normalizeSkillRecord),
            pluginTools: this._pluginTools,
            mcpServers: this._mcpServers,
            cacheEntries: this._cacheEntries,
        });
    }

    _getSkillRecord(skillId) {
        const skill = this._skills.find((item) => item.id === skillId);

        if (!skill)
            throw new Error(`Skill does not exist: ${skillId}`);

        return skill;
    }
}
