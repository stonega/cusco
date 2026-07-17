import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

const HOME_FILE_ATTRIBUTES = [
    Gio.FILE_ATTRIBUTE_STANDARD_NAME,
    Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
    Gio.FILE_ATTRIBUTE_STANDARD_IS_HIDDEN,
].join(',');
const COMMAND_ATTRIBUTES = [
    Gio.FILE_ATTRIBUTE_STANDARD_NAME,
    Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
    Gio.FILE_ATTRIBUTE_ACCESS_CAN_EXECUTE,
].join(',');
const DEFAULT_FILE_LIMIT = 100000;
const FILE_BATCH_SIZE = 96;
const SKIPPED_DIRECTORY_NAMES = new Set([
    '.cache',
    '.git',
    '.Trash',
    '__pycache__',
    'node_modules',
]);

function characterLength(value) {
    return [...String(value ?? '')].length;
}

function normalizedSearchText(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

function searchTextMasks(value) {
    let primary = 0;
    let secondary = 0;

    for (const character of value) {
        const codePoint = character.codePointAt(0);
        const mixed = Math.imul(codePoint ^ (codePoint >>> 16), 0x45d9f3b);
        primary |= 1 << (codePoint & 31);
        secondary |= 1 << ((mixed ^ (mixed >>> 16)) & 31);
    }

    return {
        primary: primary >>> 0,
        secondary: secondary >>> 0,
    };
}

function fuzzyMatchScore(candidate, needle) {
    if (!needle)
        return 0;

    if (candidate === needle)
        return 0;

    if (candidate.startsWith(needle))
        return 10 + (candidate.length - needle.length) / 1000;

    const substringIndex = candidate.indexOf(needle);

    if (substringIndex >= 0)
        return 20 + substringIndex + (candidate.length - needle.length) / 1000;

    let candidateIndex = 0;
    let firstMatch = -1;
    let lastMatch = -1;

    for (const character of needle) {
        const matchIndex = candidate.indexOf(character, candidateIndex);

        if (matchIndex < 0)
            return Number.POSITIVE_INFINITY;

        if (firstMatch < 0)
            firstMatch = matchIndex;

        lastMatch = matchIndex;
        candidateIndex = matchIndex + 1;
    }

    return 40 + firstMatch + (lastMatch - firstMatch - needle.length + 1);
}

function itemMatchScore(item, query, queryMasks) {
    if (Number.isInteger(item.searchMaskPrimary)
        && Number.isInteger(item.searchMaskSecondary)
        && (((item.searchMaskPrimary & queryMasks.primary) >>> 0) !== queryMasks.primary
            || ((item.searchMaskSecondary & queryMasks.secondary) >>> 0) !== queryMasks.secondary))
        return Number.POSITIVE_INFINITY;

    const title = item.normalizedTitle ?? normalizedSearchText(item.title);
    const searchText = item.normalizedSearchText
        ?? normalizedSearchText(item.searchText ?? item.subtitle);
    const titleScore = fuzzyMatchScore(title, query);
    const searchScore = fuzzyMatchScore(searchText, query);

    return Math.min(titleScore, searchScore + 5);
}

function insertRankedItem(items, rankedItem, compare, limit) {
    let start = 0;
    let end = items.length;

    while (start < end) {
        const middle = Math.floor((start + end) / 2);

        if (compare(rankedItem, items[middle]) < 0)
            end = middle;
        else
            start = middle + 1;
    }

    if (start >= limit)
        return;

    items.splice(start, 0, rankedItem);

    if (items.length > limit)
        items.pop();
}

function compareRankedItems(left, right) {
    return left.score - right.score
        || String(left.item.title).localeCompare(String(right.item.title))
        || left.index - right.index;
}

function rankedItemFor(item, index, query, queryMasks) {
    return { item, index, score: itemMatchScore(item, query, queryMasks) };
}

function isPathInsideHome(path, homePath) {
    return path === homePath || path.startsWith(`${homePath}${GLib.DIR_SEPARATOR_S}`);
}

function homeDisplayPath(path, homePath) {
    if (path === homePath)
        return '~';

    return isPathInsideHome(path, homePath)
        ? `~${path.slice(homePath.length)}`
        : path;
}

function userDirectoryPaths(homePath) {
    const directoryTypes = [
        GLib.UserDirectory.DIRECTORY_DOCUMENTS,
        GLib.UserDirectory.DIRECTORY_DOWNLOAD,
        GLib.UserDirectory.DIRECTORY_DESKTOP,
        GLib.UserDirectory.DIRECTORY_PICTURES,
        GLib.UserDirectory.DIRECTORY_MUSIC,
        GLib.UserDirectory.DIRECTORY_VIDEOS,
        GLib.UserDirectory.DIRECTORY_TEMPLATES,
        GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE,
    ];

    return directoryTypes
        .map((directoryType) => GLib.get_user_special_dir(directoryType))
        .filter((path) => path && path !== homePath && isPathInsideHome(path, homePath));
}

export function findComposerTrigger(text, cursorOffset = characterLength(text)) {
    const characters = [...String(text ?? '')];
    const safeCursorOffset = Math.max(0, Math.min(Number(cursorOffset) || 0, characters.length));
    const beforeCursor = characters.slice(0, safeCursorOffset).join('');
    const match = /(^|[\s([{])([$@#])([^\s$@#]*)$/u.exec(beforeCursor);

    if (!match)
        return null;

    const query = match[3];
    const startOffset = safeCursorOffset - characterLength(query) - 1;
    let endOffset = safeCursorOffset;

    while (endOffset < characters.length && !/[\s$@#]/u.test(characters[endOffset]))
        endOffset += 1;

    return {
        trigger: match[2],
        query,
        startOffset,
        endOffset,
    };
}

export function filterComposerSuggestions(items, query, limit = 8) {
    const safeItems = Array.isArray(items) ? items : [];
    const safeLimit = Math.max(0, Number(limit) || 0);
    const normalizedQuery = normalizedSearchText(query);

    if (safeLimit === 0)
        return [];

    if (!normalizedQuery)
        return safeItems.slice(0, safeLimit);

    const rankedItems = [];
    const queryMasks = searchTextMasks(normalizedQuery);

    safeItems.forEach((item, index) => {
        const rankedItem = rankedItemFor(item, index, normalizedQuery, queryMasks);

        if (!Number.isFinite(rankedItem.score))
            return;

        insertRankedItem(rankedItems, rankedItem, compareRankedItems, safeLimit);
    });

    return rankedItems.map(({ item }) => item);
}

export function listPathExecutables(pathValue = GLib.getenv('PATH') ?? '') {
    const commands = new Map();
    const inspectedDirectories = new Set();

    for (const directoryPath of String(pathValue).split(GLib.SEARCHPATH_SEPARATOR_S)) {
        if (!directoryPath || inspectedDirectories.has(directoryPath))
            continue;

        inspectedDirectories.add(directoryPath);

        let enumerator = null;

        try {
            const directory = Gio.File.new_for_path(directoryPath);
            enumerator = directory.enumerate_children(
                COMMAND_ATTRIBUTES,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null,
            );
            let info = null;

            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                const type = info.get_file_type();
                const canExecute = info.get_attribute_boolean(Gio.FILE_ATTRIBUTE_ACCESS_CAN_EXECUTE);

                if (!name || commands.has(name) || !canExecute)
                    continue;

                if (type !== Gio.FileType.REGULAR && type !== Gio.FileType.SYMBOLIC_LINK)
                    continue;

                commands.set(name, {
                    kind: 'command',
                    value: name,
                    title: name,
                    subtitle: directoryPath,
                    searchText: `${name} ${directoryPath}`,
                    insertText: `#${name}`,
                });
            }
        } catch (error) {
            if (!error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)
                && !error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.PERMISSION_DENIED)
                && !error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_DIRECTORY)) {
                logError(error, `Failed to inspect commands in ${directoryPath}`);
            }
        } finally {
            try {
                enumerator?.close(null);
            } catch (_error) {
                // The directory may have disappeared while PATH was being inspected.
            }
        }
    }

    return [...commands.values()];
}

export class HomeFileIndex {
    constructor({
        homePath = GLib.get_home_dir(),
        onChanged = null,
        maxFiles = DEFAULT_FILE_LIMIT,
    } = {}) {
        this.homePath = GLib.canonicalize_filename(homePath, null);
        this.maxFiles = Math.max(1, Number(maxFiles) || DEFAULT_FILE_LIMIT);
        this._onChanged = typeof onChanged === 'function' ? onChanged : null;
        this._items = [];
        this._seenFiles = new Set();
        this._seenDirectories = new Set();
        this._directories = [];
        this._cancellable = null;
        this._lastChangeTime = 0;
        this._searchCache = null;
        this.loading = false;
        this.complete = false;
        this.truncated = false;
    }

    get items() {
        return this._items;
    }

    search(query, limit = 8) {
        const safeLimit = Math.max(0, Number(limit) || 0);
        const normalizedQuery = normalizedSearchText(query);

        if (safeLimit === 0)
            return [];

        if (!normalizedQuery)
            return this._items.slice(0, safeLimit);

        const previous = this._searchCache;
        const queryMasks = searchTextMasks(normalizedQuery);

        if (previous?.query === normalizedQuery && previous.limit === safeLimit) {
            for (let index = previous.itemCount; index < this._items.length; index += 1) {
                const rankedItem = rankedItemFor(
                    this._items[index],
                    index,
                    normalizedQuery,
                    queryMasks,
                );

                if (!Number.isFinite(rankedItem.score))
                    continue;

                previous.matches.push(index);
                insertRankedItem(
                    previous.rankedItems,
                    rankedItem,
                    compareRankedItems,
                    safeLimit,
                );
            }

            previous.itemCount = this._items.length;
            return previous.rankedItems.map(({ item }) => item);
        }

        const canNarrowPreviousSearch = previous?.query
            && normalizedQuery.startsWith(previous.query);
        const matches = [];
        const rankedItems = [];
        const considerItem = (index) => {
            const rankedItem = rankedItemFor(this._items[index], index, normalizedQuery, queryMasks);

            if (!Number.isFinite(rankedItem.score))
                return;

            matches.push(index);
            insertRankedItem(rankedItems, rankedItem, compareRankedItems, safeLimit);
        };

        if (canNarrowPreviousSearch) {
            for (const index of previous.matches)
                considerItem(index);

            for (let index = previous.itemCount; index < this._items.length; index += 1)
                considerItem(index);
        } else {
            for (let index = 0; index < this._items.length; index += 1)
                considerItem(index);
        }

        this._searchCache = {
            query: normalizedQuery,
            limit: safeLimit,
            itemCount: this._items.length,
            matches,
            rankedItems,
        };
        return rankedItems.map(({ item }) => item);
    }

    start() {
        if (this.loading || this.complete)
            return;

        this.loading = true;
        this._cancellable = new Gio.Cancellable();

        for (const path of [...userDirectoryPaths(this.homePath), this.homePath])
            this._queueDirectory(path);

        this._emitChanged();
        this._enumerateNextDirectory();
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this.loading = false;
    }

    _queueDirectory(path) {
        const canonicalPath = GLib.canonicalize_filename(path, null);

        if (this._seenDirectories.has(canonicalPath))
            return;

        this._seenDirectories.add(canonicalPath);
        this._directories.push(canonicalPath);
    }

    _shouldSkip(name, info) {
        return !name
            || name.startsWith('.')
            || info.get_is_hidden()
            || SKIPPED_DIRECTORY_NAMES.has(name);
    }

    _enumerateNextDirectory() {
        if (!this.loading || this._cancellable?.is_cancelled())
            return;

        if (this._items.length >= this.maxFiles) {
            this.truncated = true;
            this._finish();
            return;
        }

        const directoryPath = this._directories.shift();

        if (!directoryPath) {
            this._finish();
            return;
        }

        const directory = Gio.File.new_for_path(directoryPath);
        directory.enumerate_children_async(
            HOME_FILE_ATTRIBUTES,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT_IDLE,
            this._cancellable,
            (source, result) => {
                let enumerator = null;

                try {
                    enumerator = source.enumerate_children_finish(result);
                } catch (error) {
                    if (!error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED))
                        this._enumerateNextDirectory();
                    return;
                }

                if (!this.loading || this._cancellable?.is_cancelled()) {
                    try {
                        enumerator.close(null);
                    } catch (_error) {
                        // Cancellation can race with directory teardown.
                    }
                    return;
                }

                this._readDirectoryBatch(directoryPath, directory, enumerator);
            },
        );
    }

    _readDirectoryBatch(directoryPath, directory, enumerator) {
        if (!this.loading || this._cancellable?.is_cancelled()) {
            try {
                enumerator.close(null);
            } catch (_error) {
                // Cancellation can race with directory teardown.
            }
            return;
        }

        enumerator.next_files_async(
            FILE_BATCH_SIZE,
            GLib.PRIORITY_DEFAULT_IDLE,
            this._cancellable,
            (source, result) => {
                let infos = [];

                try {
                    infos = source.next_files_finish(result);
                } catch (error) {
                    if (!error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED))
                        this._enumerateNextDirectory();
                    return;
                }

                if (!this.loading || this._cancellable?.is_cancelled()) {
                    try {
                        enumerator.close(null);
                    } catch (_error) {
                        // Cancellation can race with directory teardown.
                    }
                    return;
                }

                if (infos.length === 0) {
                    try {
                        enumerator.close(null);
                    } catch (_error) {
                        // The directory may have disappeared during indexing.
                    }

                    this._enumerateNextDirectory();
                    return;
                }

                let changed = false;

                for (const info of infos) {
                    const name = info.get_name();

                    if (this._shouldSkip(name, info))
                        continue;

                    const child = directory.get_child(name);
                    const path = child.get_path();

                    if (!path)
                        continue;

                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        this._queueDirectory(path);
                        continue;
                    }

                    if (info.get_file_type() !== Gio.FileType.REGULAR
                        && info.get_file_type() !== Gio.FileType.SYMBOLIC_LINK)
                        continue;

                    if (this._seenFiles.has(path))
                        continue;

                    this._seenFiles.add(path);
                    const displayPath = homeDisplayPath(path, this.homePath);
                    const searchText = `${name} ${displayPath}`;
                    const normalizedTitle = normalizedSearchText(name);
                    const normalizedFileSearchText = normalizedSearchText(searchText);
                    const searchMasks = searchTextMasks(normalizedFileSearchText);
                    this._items.push({
                        kind: 'file',
                        value: path,
                        title: name,
                        subtitle: displayPath,
                        searchText,
                        normalizedTitle,
                        normalizedSearchText: normalizedFileSearchText,
                        searchMaskPrimary: searchMasks.primary,
                        searchMaskSecondary: searchMasks.secondary,
                        insertText: `@${displayPath}`,
                    });
                    changed = true;

                    if (this._items.length >= this.maxFiles)
                        break;
                }

                if (changed)
                    this._emitChanged(false);

                if (this._items.length >= this.maxFiles) {
                    this.truncated = true;
                    try {
                        enumerator.close(null);
                    } catch (_error) {
                        // The directory may have disappeared during indexing.
                    }
                    this._finish();
                    return;
                }

                this._readDirectoryBatch(directoryPath, directory, enumerator);
            },
        );
    }

    _finish() {
        this.loading = false;
        this.complete = true;
        this._cancellable = null;
        this._emitChanged();
    }

    _emitChanged(force = true) {
        const now = GLib.get_monotonic_time();

        if (!force && now - this._lastChangeTime < 150000)
            return;

        this._lastChangeTime = now;
        this._onChanged?.(this);
    }
}
