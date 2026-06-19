import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

export const SKILL_FILE_NAME = 'SKILL.md';
export const DEFAULT_GLOBAL_SKILLS_PATH = GLib.build_filenamev([
    GLib.get_home_dir(),
    '.agents',
    'skills',
]);

const MAX_SKILL_BYTES = 120000;

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

        if (match)
            metadata[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
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

export function buildSkillContext(skills) {
    const enabledSkills = (skills ?? []).filter((skill) => skill && !skill.loadError && skill.content);

    if (enabledSkills.length === 0)
        return '';

    const sections = enabledSkills.map((skill) => [
        `## ${skill.name}`,
        skill.description ? `Description: ${skill.description}` : '',
        skill.content,
    ].filter(Boolean).join('\n\n'));

    return [
        'The following local SKILL instructions are active for this response. Follow them when they are relevant to the user request.',
        ...sections,
    ].join('\n\n');
}
