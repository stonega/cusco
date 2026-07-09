import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

export const SKILL_FILE_NAME = 'SKILL.md';
export const DEFAULT_GLOBAL_SKILLS_PATH = GLib.build_filenamev([
    GLib.get_home_dir(),
    '.agents',
    'skills',
]);

const MAX_SKILL_BYTES = 120000;
const CUSCO_MCP_SETUP_SKILL_CONTENT = [
    '# Cusco MCP Setup',
    '',
    'Use this built-in skill when the user asks how to configure, add, troubleshoot, document, or explain Model Context Protocol (MCP) servers for Cusco.',
    '',
    'Cusco loads MCP servers from `~/.config/io.github.stonega.Cusco/mcp.json`. Prefer a top-level `mcpServers` object. Cusco also accepts `servers` or a bare object/array, but `mcpServers` is the clearest format.',
    '',
    'For a stdio MCP server, use `command`, `args`, optional `cwd`, optional `env`, `enabled: true`, and `permissionPolicy: "ask"` unless the user explicitly trusts the server. Use absolute paths for local scripts and working directories.',
    '',
    'For a Streamable HTTP MCP server, use `url`, optional `headers`, `enabled: true`, and `permissionPolicy: "ask"`. Do not place real bearer tokens or API keys in committed examples.',
    '',
    'Cusco infers the transport: `url` means `streamable-http`; no `url` means `stdio`. A `namespace` can be set to make tool names stable and easy to recognize.',
    '',
    'After editing `mcp.json`, tell the user to reload the MCP config from Cusco Preferences, then use Agent. MCP tools appear as `mcp__<namespace>__<tool>`. Resource helpers appear as `mcp__<namespace>__list_resources` and `mcp__<namespace>__read_resource`; prompt helpers appear as `mcp__<namespace>__list_prompts` and `mcp__<namespace>__get_prompt`.',
    '',
    'When working inside the Cusco repo, verify MCP behavior with `gjs -m tests/mcp-smoke.js`. The focused smoke test checks config parsing, stdio discovery, tool registration, resource helpers, prompt helpers, and tool calls.',
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

    return checksumId('custom-skill', normalizedPath);
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

export function discoverInstalledSkills({ rootPath = DEFAULT_GLOBAL_SKILLS_PATH } = {}) {
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
                    skills.push(loadSkillFromPath(skillPath, { source: 'global', id: name }));
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
