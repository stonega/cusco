import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

export const SKILL_FILE_NAME = 'SKILL.md';
const moduleDirectory = Gio.File.new_for_uri(import.meta.url).get_parent();
const configuredRepositoryRoot = String(GLib.getenv('CUSCO_REPOSITORY_ROOT') ?? '').trim();
const defaultRepositoryRoot = GLib.canonicalize_filename(
    configuredRepositoryRoot || moduleDirectory.get_parent().get_parent().get_path(),
    null,
);

export const DEFAULT_GLOBAL_SKILLS_PATH = GLib.build_filenamev([
    GLib.get_home_dir(),
    '.agents',
    'skills',
]);
export const DEFAULT_CUSCO_SKILLS_PATH = GLib.build_filenamev([
    defaultRepositoryRoot,
    'skills',
]);
export const DEFAULT_CUSCO_PLUGINS_PATH = GLib.build_filenamev([
    defaultRepositoryRoot,
    'plugins',
]);

const MAX_SKILL_BYTES = 120000;
const MAX_IMPORTED_SKILL_FILES = 20_000;
const MAX_IMPORTED_SKILL_BYTES = 512 * 1024 * 1024;
const CUSCO_MCP_SETUP_SKILL_CONTENT = [
    '# Cusco MCP Setup',
    '',
    'Use this built-in skill when the user asks how to configure, add, troubleshoot, document, or explain Model Context Protocol (MCP) servers for Cusco.',
    '',
    'When the `mcp_server_configure`, `mcp_server_connect`, `mcp_server_status`, and `mcp_server_call` tools are available, use them for direct host configuration. Do not edit configuration with Bash, install a plugin, or register a plugin unless the user explicitly requested that different workflow.',
    '',
    '`mcp_server_configure` atomically adds or updates one entry in `~/.config/io.github.stonega.Cusco/mcp.json` while preserving unrelated settings. For Streamable HTTP, provide the server name, HTTPS URL, exact OAuth scopes, and raw `allowedTools` names requested by the user. `allowedTools` controls exposure; `permissionPolicy` separately controls whether calls ask for confirmation.',
    '',
    'After configuration, call `mcp_server_connect`. It may open the system browser for OAuth, waits for the loopback callback, stores tokens in Secret Service, reconnects, and refreshes Agent Mode tools. Never request, print, copy, return, or place credentials, authorization codes, access tokens, refresh tokens, client secrets, or encryption keys in chat or tool input.',
    '',
    'Do not claim success from a connected status alone. Use `mcp_server_status` to confirm the expected allowed tools are available, then use the direct namespaced tool or `mcp_server_call` to run the user-requested verification tool. Report a discovery or tool error instead of treating an empty list as success.',
    '',
    'MCP tools appear as `mcp__<namespace>__<tool>`. In the same response that creates a server, `mcp_server_call` can invoke a newly discovered allowed tool by its raw name even if the direct namespaced tool was absent from the initial prompt.',
    '',
    'For code-intelligence servers that expose `list_code_targets`, call it before other code tools. Carry the returned target, network, branch, commit SHA, file, line, and symbol provenance into code answers when the server provides those fields.',
    '',
    'When working inside the Cusco repo, verify MCP behavior with `gjs -m tests/mcp-smoke.js` and `gjs -m tests/mcp-management-smoke.js`.',
].join('\n');

const ALWAYS_AVAILABLE_SKILLS = Object.freeze([
    Object.freeze({
        id: 'cusco-mcp-setup',
        name: 'cusco-mcp-setup',
        description: 'Always-available Cusco guidance for configuring, adding, troubleshooting, documenting, or explaining MCP servers.',
        path: '',
        source: 'builtin',
        enabled: true,
        selectedByDefault: true,
        content: CUSCO_MCP_SETUP_SKILL_CONTENT,
        loadError: '',
    }),
]);

function now() {
    return new Date().toISOString();
}

function normalizePath(path) {
    const text = String(path ?? '').trim();

    if (!text)
        return '';

    const expanded = text === '~' || text.startsWith('~/')
        ? GLib.build_filenamev([GLib.get_home_dir(), text.slice(2)])
        : text;

    return GLib.canonicalize_filename(expanded, null);
}

function checksumId(prefix, value) {
    const checksum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, value, -1);
    return `${prefix}-${checksum.slice(0, 12)}`;
}

function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeFrontMatterValue(value) {
    return String(value ?? '').replace(/^["']|["']$/g, '').trim();
}

function isFrontMatterKey(line) {
    return /^[A-Za-z0-9_-]+:\s*(.*)$/.test(line);
}

function isBlockScalarIndicator(value) {
    return /^[|>](?:[+-]?\d*|\d*[+-]?)$/.test(String(value ?? '').trim());
}

function dedentBlockScalarLines(lines) {
    const indentedLines = lines.filter((line) => line.trim().length > 0);
    const minIndent = indentedLines.reduce((minimum, line) => {
        const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
        return Math.min(minimum, indent);
    }, Number.MAX_SAFE_INTEGER);

    if (minIndent === Number.MAX_SAFE_INTEGER || minIndent === 0)
        return lines.map((line) => line.trimEnd());

    return lines.map((line) => line.trim() ? line.slice(minIndent).trimEnd() : '');
}

function foldBlockScalarLines(lines) {
    const paragraphs = [];
    let paragraph = [];

    for (const line of lines) {
        if (line.trim().length === 0) {
            if (paragraph.length > 0) {
                paragraphs.push(paragraph.join(' '));
                paragraph = [];
            }

            paragraphs.push('');
            continue;
        }

        paragraph.push(line.trim());
    }

    if (paragraph.length > 0)
        paragraphs.push(paragraph.join(' '));

    return paragraphs.join('\n');
}

function parseBlockScalar(lines, indicator) {
    const dedented = dedentBlockScalarLines(lines);
    const style = String(indicator ?? '').trim()[0];
    const value = style === '>' ? foldBlockScalarLines(dedented) : dedented.join('\n');

    return value.trim();
}

function activeSkillList(skills, { includeAlwaysAvailable = true } = {}) {
    const seen = new Set();
    const activeSkills = [];

    for (const skill of [
        ...(includeAlwaysAvailable ? ALWAYS_AVAILABLE_SKILLS : []),
        ...(skills ?? []),
    ]) {
        if (!skill || skill.loadError || !skill.content)
            continue;

        const keys = [skill.id, skill.name].map((key) => String(key ?? '').trim()).filter(Boolean);

        if (keys.some((key) => seen.has(key)))
            continue;

        for (const key of keys)
            seen.add(key);

        activeSkills.push(skill);
    }

    return activeSkills;
}

function parseFrontMatter(content) {
    const lines = String(content ?? '').split(/\r?\n/);

    if (lines[0] !== '---')
        return {};

    const metadata = {};

    for (let index = 1; index < lines.length; index++) {
        const line = lines[index];

        if (line === '---')
            return metadata;

        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);

        if (match) {
            const [, key, rawValue] = match;
            const value = String(rawValue ?? '').trim();

            if (isBlockScalarIndicator(value)) {
                const blockLines = [];

                for (index += 1; index < lines.length; index++) {
                    const blockLine = lines[index];

                    if (blockLine === '---') {
                        index -= 1;
                        break;
                    }

                    if (isFrontMatterKey(blockLine)) {
                        index -= 1;
                        break;
                    }

                    blockLines.push(blockLine);
                }

                metadata[key] = parseBlockScalar(blockLines, value);
            } else {
                metadata[key] = normalizeFrontMatterValue(rawValue);
            }
        }
    }

    return {};
}

function firstHeading(content) {
    const line = String(content ?? '').split(/\r?\n/).find((item) => item.startsWith('# '));
    return line ? line.replace(/^#\s+/, '').trim() : '';
}

function firstParagraph(content) {
    const withoutFrontMatter = String(content ?? '').replace(/^---[\s\S]*?---\s*/, '');
    const lines = withoutFrontMatter.split(/\r?\n/);
    const paragraph = [];

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) {
            if (paragraph.length > 0)
                break;

            continue;
        }

        paragraph.push(trimmed);
    }

    return normalizeWhitespace(paragraph.join(' '));
}

function readSkillFile(skillFilePath) {
    const file = Gio.File.new_for_path(skillFilePath);

    if (!file.query_exists(null))
        throw new Error(`Missing ${SKILL_FILE_NAME}`);

    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);

    if (info.get_size() > MAX_SKILL_BYTES)
        throw new Error(`${SKILL_FILE_NAME} is larger than ${MAX_SKILL_BYTES} bytes`);

    const [, contents] = GLib.file_get_contents(skillFilePath);
    return new TextDecoder().decode(contents);
}

function deleteRecursively(file, cancellable = null) {
    if (!file.query_exists(cancellable))
        return;

    const info = file.query_info(
        'standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        cancellable,
    );

    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            cancellable,
        );

        try {
            let childInfo = enumerator.next_file(cancellable);

            while (childInfo) {
                deleteRecursively(file.get_child(childInfo.get_name()), cancellable);
                childInfo = enumerator.next_file(cancellable);
            }
        } finally {
            enumerator.close(cancellable);
        }
    }

    file.delete(cancellable);
}

function copySkillDirectory(source, destination, cancellable = null, state = { files: 0, bytes: 0 }) {
    const info = source.query_info(
        'standard::type,standard::size',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        cancellable,
    );
    const fileType = info.get_file_type();

    state.files += 1;

    if (state.files > MAX_IMPORTED_SKILL_FILES)
        throw new Error('Skill exceeds Cusco import limits.');

    if (fileType === Gio.FileType.REGULAR) {
        state.bytes += Number(info.get_size());

        if (state.bytes > MAX_IMPORTED_SKILL_BYTES)
            throw new Error('Skill exceeds Cusco import limits.');

        source.copy(destination, Gio.FileCopyFlags.NONE, cancellable, null);
        return;
    }

    if (fileType !== Gio.FileType.DIRECTORY)
        throw new Error(`Skill contains an unsupported file type: ${source.get_path()}`);

    destination.make_directory(cancellable);
    const enumerator = source.enumerate_children(
        'standard::name',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        cancellable,
    );

    try {
        let childInfo = enumerator.next_file(cancellable);

        while (childInfo) {
            const name = childInfo.get_name();
            copySkillDirectory(
                source.get_child(name),
                destination.get_child(name),
                cancellable,
                state,
            );
            childInfo = enumerator.next_file(cancellable);
        }
    } finally {
        enumerator.close(cancellable);
    }
}

function createSkillRecord({
    id,
    name,
    description,
    path,
    source,
    enabled = false,
    selectedByDefault = false,
    content = '',
    loadError = '',
    discoveredAt = now(),
    updatedAt = discoveredAt,
}) {
    return {
        id,
        name: normalizeWhitespace(name) || id,
        description: normalizeWhitespace(description),
        path,
        source,
        enabled: Boolean(enabled),
        selectedByDefault: Boolean(selectedByDefault),
        content,
        loadError: normalizeWhitespace(loadError),
        discoveredAt,
        updatedAt,
    };
}

export function createSkillId(path, source = 'custom') {
    const normalizedPath = normalizePath(path);
    const basename = GLib.path_get_basename(normalizedPath);

    if (source === 'global')
        return basename;

    const prefix = source === 'cusco'
        ? 'cusco-skill'
        : source === 'plugin' ? 'plugin-skill' : 'custom-skill';

    return checksumId(prefix, normalizedPath);
}

export function loadSkillFromPath(path, { source = 'custom', id = null, enabled = false, selectedByDefault = false } = {}) {
    const normalizedPath = normalizePath(path);
    const skillId = id ?? (normalizedPath ? createSkillId(normalizedPath, source) : checksumId('custom-skill', 'empty'));

    if (!normalizedPath) {
        return createSkillRecord({
            id: skillId,
            name: 'Skill',
            path: '',
            source,
            enabled: false,
            selectedByDefault: false,
            loadError: 'Skill path cannot be empty.',
        });
    }

    const skillFilePath = GLib.build_filenamev([normalizedPath, SKILL_FILE_NAME]);

    try {
        const content = readSkillFile(skillFilePath);
        const metadata = parseFrontMatter(content);
        const timestamp = now();

        return createSkillRecord({
            id: skillId,
            name: metadata.name || firstHeading(content) || GLib.path_get_basename(normalizedPath),
            description: metadata.description || firstParagraph(content),
            path: normalizedPath,
            source,
            enabled,
            selectedByDefault,
            content,
            discoveredAt: timestamp,
            updatedAt: timestamp,
        });
    } catch (error) {
        const timestamp = now();

        return createSkillRecord({
            id: skillId,
            name: GLib.path_get_basename(normalizedPath),
            path: normalizedPath,
            source,
            enabled: false,
            selectedByDefault: false,
            loadError: error.message,
            discoveredAt: timestamp,
            updatedAt: timestamp,
        });
    }
}

export function importSkillFolder(
    path,
    {
        destinationRoot = DEFAULT_CUSCO_SKILLS_PATH,
        enabled = true,
        cancellable = null,
    } = {},
) {
    const sourcePath = normalizePath(path);
    const rootPath = normalizePath(destinationRoot);

    if (!sourcePath)
        throw new Error('Select a skill folder to import.');
    if (!rootPath)
        throw new Error('Cusco skill storage is unavailable.');

    const directoryName = GLib.path_get_basename(sourcePath);

    if (directoryName.startsWith('.') || directoryName === '.' || directoryName === '..')
        throw new Error('Hidden skill folders cannot be imported.');
    if (rootPath === sourcePath || rootPath.startsWith(`${sourcePath}/`))
        throw new Error('Cusco’s skill storage cannot be inside the selected skill folder.');

    const sourceSkill = loadSkillFromPath(sourcePath);

    if (sourceSkill.loadError)
        throw new Error(`Cannot import skill: ${sourceSkill.loadError}`);

    const destinationPath = GLib.build_filenamev([rootPath, directoryName]);

    if (sourcePath === destinationPath) {
        return loadSkillFromPath(destinationPath, {
            source: 'cusco',
            enabled,
        });
    }

    const destination = Gio.File.new_for_path(destinationPath);

    if (destination.query_exists(cancellable))
        throw new Error(`A Cusco skill folder named ${directoryName} already exists.`);

    GLib.mkdir_with_parents(rootPath, 0o755);
    const stagingPath = GLib.build_filenamev([
        rootPath,
        `.${directoryName}.installing-${GLib.uuid_string_random()}`,
    ]);
    const source = Gio.File.new_for_path(sourcePath);
    const staging = Gio.File.new_for_path(stagingPath);

    try {
        copySkillDirectory(source, staging, cancellable);

        const stagedSkill = loadSkillFromPath(stagingPath, { source: 'cusco' });

        if (stagedSkill.loadError)
            throw new Error(`Copied skill failed validation: ${stagedSkill.loadError}`);

        staging.move(destination, Gio.FileCopyFlags.NONE, cancellable, null);
    } catch (error) {
        if (staging.query_exists(null)) {
            try {
                deleteRecursively(staging, null);
            } catch (cleanupError) {
                logError(cleanupError, `Failed to remove skill staging directory: ${stagingPath}`);
            }
        }

        throw error;
    }

    return loadSkillFromPath(destinationPath, {
        source: 'cusco',
        enabled,
    });
}

export function discoverInstalledSkills({
    rootPath = DEFAULT_GLOBAL_SKILLS_PATH,
    source = 'global',
    enabled = false,
} = {}) {
    const normalizedRoot = normalizePath(rootPath);

    if (!normalizedRoot)
        return [];

    const root = Gio.File.new_for_path(normalizedRoot);

    if (!root.query_exists(null))
        return [];

    const enumerator = root.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NONE,
        null,
    );
    const skills = [];

    try {
        let info = enumerator.next_file(null);

        while (info) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                const name = info.get_name();
                const skillPath = GLib.build_filenamev([normalizedRoot, name]);
                const skillFilePath = GLib.build_filenamev([skillPath, SKILL_FILE_NAME]);

                if (GLib.file_test(skillFilePath, GLib.FileTest.EXISTS))
                    skills.push(loadSkillFromPath(skillPath, {
                        source,
                        id: createSkillId(skillPath, source),
                        enabled,
                    }));
            }

            info = enumerator.next_file(null);
        }
    } finally {
        enumerator.close(null);
    }

    return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverPluginSkills({
    pluginsRootPath = DEFAULT_CUSCO_PLUGINS_PATH,
    enabled = true,
} = {}) {
    const normalizedRoot = normalizePath(pluginsRootPath);

    if (!normalizedRoot)
        return [];

    const root = Gio.File.new_for_path(normalizedRoot);

    if (!root.query_exists(null))
        return [];

    const enumerator = root.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
    );
    const skills = [];

    try {
        let info = enumerator.next_file(null);

        while (info) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY && !info.get_name().startsWith('.')) {
                const pluginSkillsPath = GLib.build_filenamev([
                    normalizedRoot,
                    info.get_name(),
                    'skills',
                ]);
                skills.push(...discoverInstalledSkills({
                    rootPath: pluginSkillsPath,
                    source: 'plugin',
                    enabled,
                }));
            }

            info = enumerator.next_file(null);
        }
    } finally {
        enumerator.close(null);
    }

    return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export function getAlwaysAvailableSkills() {
    return ALWAYS_AVAILABLE_SKILLS.map((skill) => ({ ...skill }));
}

export function buildSkillContext(skills, options = {}) {
    const enabledSkills = activeSkillList(skills, options);

    if (enabledSkills.length === 0)
        return '';

    const sections = enabledSkills.map((skill) => [
        `## ${skill.name}`,
        skill.description ? `Description: ${skill.description}` : '',
        skill.content,
    ].filter(Boolean).join('\n\n'));

    return [
        'The following SKILL instructions are active for this response. Follow them when they are relevant to the user request.',
        ...sections,
    ].join('\n\n');
}
