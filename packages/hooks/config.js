import GLib from 'gi://GLib?version=2.0';

const APP_ID = 'io.github.stonega.Cusco';
const MAX_HOOKS_FILE_BYTES = 1024 * 1024;
const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;
const MIN_HOOK_TIMEOUT_SECONDS = 1;
const MAX_HOOK_TIMEOUT_SECONDS = 3600;

export const HOOK_EVENTS = Object.freeze([
    'SessionStart',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'UserPromptSubmit',
    'Stop',
]);

const SUPPORTED_HOOK_EVENTS = new Set(HOOK_EVENTS);
const KNOWN_HOOK_EVENTS = new Set([
    ...HOOK_EVENTS,
    'SubagentStart',
    'SubagentStop',
]);

function isRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTimeout(value) {
    if (!Number.isFinite(value))
        return DEFAULT_HOOK_TIMEOUT_SECONDS;

    return Math.min(
        MAX_HOOK_TIMEOUT_SECONDS,
        Math.max(MIN_HOOK_TIMEOUT_SECONDS, Math.round(value)),
    );
}

function normalizeMatcher(value) {
    return typeof value === 'string' ? value : '';
}

function validateMatcher(matcher) {
    if (!matcher || matcher === '*')
        return '';

    try {
        new RegExp(matcher);
        return '';
    } catch (error) {
        return `Invalid matcher regular expression: ${error.message}`;
    }
}

function definitionFingerprint(definition) {
    const payload = JSON.stringify({
        sourcePath: definition.sourcePath,
        eventName: definition.eventName,
        matcher: definition.matcher,
        type: definition.type,
        command: definition.command,
        timeout: definition.timeout,
        statusMessage: definition.statusMessage,
        async: definition.async,
    });

    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, payload, -1);
}

function normalizeHandler(source, eventName, group, groupIndex, handler, handlerIndex) {
    const type = String(handler?.type ?? '').trim();
    const command = String(handler?.command ?? '').trim();
    const matcher = normalizeMatcher(group?.matcher);
    const errors = [];

    if (!isRecord(handler)) {
        errors.push('Hook handler must be an object.');
    } else {
        const matcherError = validateMatcher(matcher);

        if (matcherError)
            errors.push(matcherError);

        if (!type)
            errors.push('Hook handler type is required.');
        else if (type !== 'command')
            errors.push(`Hook handler type "${type}" is not supported.`);

        if (type === 'command' && !command)
            errors.push('Command hook must provide a command.');

        if (handler.async)
            errors.push('Asynchronous command hooks are not supported.');
    }

    const definition = {
        sourceScope: source.scope,
        sourcePath: source.path,
        sourceLabel: source.label,
        eventName,
        groupIndex,
        handlerIndex,
        matcher,
        type,
        command,
        timeout: normalizeTimeout(handler?.timeout),
        statusMessage: String(handler?.statusMessage ?? '').trim(),
        async: Boolean(handler?.async),
        errors,
        supported: errors.length === 0,
    };
    definition.fingerprint = definitionFingerprint(definition);
    return definition;
}

function normalizeSource(source, parsed) {
    const definitions = [];
    const errors = [];

    if (!isRecord(parsed)) {
        errors.push('Hooks file must contain a JSON object.');
        return { ...source, definitions, errors };
    }

    if (!isRecord(parsed.hooks)) {
        errors.push('Hooks file must contain a "hooks" object.');
        return { ...source, definitions, errors };
    }

    for (const [eventName, groups] of Object.entries(parsed.hooks)) {
        if (!KNOWN_HOOK_EVENTS.has(eventName)) {
            errors.push(`Unsupported hook event: ${eventName}`);
            continue;
        }

        if (!Array.isArray(groups)) {
            errors.push(`${eventName} must be an array of matcher groups.`);
            continue;
        }

        groups.forEach((group, groupIndex) => {
            if (!isRecord(group) || !Array.isArray(group.hooks)) {
                errors.push(`${eventName}[${groupIndex}] must contain a hooks array.`);
                return;
            }

            group.hooks.forEach((handler, handlerIndex) => {
                const definition = normalizeHandler(
                    source,
                    eventName,
                    group,
                    groupIndex,
                    handler,
                    handlerIndex,
                );

                if (!SUPPORTED_HOOK_EVENTS.has(eventName)) {
                    definition.errors.push(`${eventName} is not supported because Cusco does not have a subagent runtime.`);
                    definition.supported = false;
                }

                definitions.push(definition);
            });
        });
    }

    return {
        ...source,
        description: String(parsed.description ?? '').trim(),
        definitions,
        errors,
    };
}

function readSource(source) {
    if (!GLib.file_test(source.path, GLib.FileTest.EXISTS))
        return { ...source, exists: false, description: '', definitions: [], errors: [] };

    try {
        const [, bytes] = GLib.file_get_contents(source.path);

        if (bytes.length > MAX_HOOKS_FILE_BYTES) {
            return {
                ...source,
                exists: true,
                description: '',
                definitions: [],
                errors: [`Hooks file exceeds ${MAX_HOOKS_FILE_BYTES} bytes.`],
            };
        }

        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        return {
            ...normalizeSource(source, parsed),
            exists: true,
        };
    } catch (error) {
        return {
            ...source,
            exists: true,
            description: '',
            definitions: [],
            errors: [`Could not load hooks file: ${error.message}`],
        };
    }
}

export function defaultUserHooksPath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        APP_ID,
        'hooks.json',
    ]);
}

export function workspaceHooksPath(workingDirectory) {
    const path = String(workingDirectory ?? '').trim();

    if (!path || !GLib.path_is_absolute(path))
        return '';

    return GLib.build_filenamev([
        GLib.canonicalize_filename(path, null),
        '.cusco',
        'hooks.json',
    ]);
}

export function discoverHookSources(options = {}) {
    const sources = [{
        scope: 'user',
        label: 'User hooks',
        path: options.userHooksPath ?? defaultUserHooksPath(),
    }];
    const projectPath = workspaceHooksPath(options.workingDirectory);

    if (projectPath) {
        sources.push({
            scope: 'workspace',
            label: 'Working directory hooks',
            path: projectPath,
        });
    }

    return sources.map(readSource);
}

export function hookMatcherMatches(definition, value = '') {
    const matcher = String(definition?.matcher ?? '');

    if (!matcher || matcher === '*')
        return true;

    try {
        return new RegExp(matcher).test(String(value ?? ''));
    } catch (_error) {
        return false;
    }
}

export function canonicalHookToolName(name) {
    const normalized = String(name ?? '').trim();
    return normalized === 'bash' ? 'Bash' : normalized;
}
