import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

export const MAX_CATALOG_BYTES = 1024 * 1024;

function readJson(path, maximum = MAX_CATALOG_BYTES * 3) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;
    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_size() > maximum)
        throw new Error('Catalog cache exceeds its size limit.');
    const [, contents] = file.load_contents(null);
    if (contents.length > maximum)
        throw new Error('Catalog cache exceeds its size limit.');
    return JSON.parse(new TextDecoder().decode(contents));
}

function atomicJson(path, value) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    const file = Gio.File.new_for_path(path);
    file.replace_contents(new TextEncoder().encode(`${JSON.stringify(value)}\n`), null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

export class FileCatalogStorage {
    constructor(directory, settingsPath = GLib.build_filenamev([directory, 'state.json'])) {
        this.cachePath = GLib.build_filenamev([directory, 'catalog.json']);
        this.settingsPath = settingsPath;
    }
    loadCache() { return readJson(this.cachePath); }
    saveCache(value) { atomicJson(this.cachePath, value); }
    loadState() { return readJson(this.settingsPath, 16384); }
    saveState(value) { atomicJson(this.settingsPath, value); }
}

function send(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
            try { resolve(session.send_finish(result)); } catch (error) { reject(error); }
        });
    });
}

function readBytes(stream, size, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(size, GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
            try { resolve(stream.read_bytes_finish(result).get_data()); } catch (error) { reject(error); }
        });
    });
}

function closeStream(stream) {
    return new Promise(resolve => {
        stream.close_async(GLib.PRIORITY_DEFAULT, null, (_stream, result) => {
            try { stream.close_finish(result); } catch (_) { /* Already closed or cancelled. */ }
            resolve();
        });
    });
}

function allowedUrl(url) {
    const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    return uri.get_scheme() === 'https' && !uri.get_userinfo()
        && [443, -1].includes(uri.get_port())
        && ['api.github.com', 'raw.githubusercontent.com'].includes(uri.get_host());
}

export async function fetchCatalog(url, { etag = '', cancellable = new Gio.Cancellable(), timeoutSeconds = 15,
    urlPolicy = allowedUrl, sessionFactory = options => new Soup.Session(options) } = {}) {
    const session = sessionFactory({ timeout: timeoutSeconds, user_agent: 'Cusco-Model-Catalog/1' });
    // The deadline also covers a server that continuously sends tiny chunks.
    let deadlineFired = false;
    const deadline = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
        deadlineFired = true;
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        for (let redirects = 0; redirects <= 3; redirects++) {
            if (!urlPolicy(url))
                throw new Error('The catalog download redirected outside the approved GitHub hosts.');
            const message = Soup.Message.new('GET', url);
            message.add_flags(Soup.MessageFlags.NO_REDIRECT);
            message.request_headers.replace('Accept', 'application/vnd.github.raw+json');
            if (etag)
                message.request_headers.replace('If-None-Match', etag);
            const stream = await send(session, message, cancellable);
            try {
                // Some GI typelibs do not include newer HTTP enum values (e.g. 429).
                const status = Number(message.status_code);
                if ([301, 302, 303, 307, 308].includes(status)) {
                    const location = message.response_headers.get_one('Location');
                    if (!location || redirects === 3)
                        throw new Error('Too many catalog download redirects.');
                    url = GLib.Uri.resolve_relative(url, location, GLib.UriFlags.NONE);
                    continue;
                }
                const headers = {};
                for (const name of ['etag', 'retry-after', 'x-ratelimit-reset', 'x-ratelimit-remaining', 'x-poll-interval'])
                    headers[name] = message.response_headers.get_one(name) ?? '';
                if (status !== 200)
                    return { status, headers, text: '' };
                if (message.response_headers.get_content_length() > MAX_CATALOG_BYTES)
                    throw new Error('The model catalog is larger than 1 MiB.');
                const chunks = [];
                let length = 0;
                while (true) {
                    const chunk = await readBytes(stream, 16384, cancellable);
                    if (chunk.length === 0)
                        break;
                    length += chunk.length;
                    if (length > MAX_CATALOG_BYTES)
                        throw new Error('The model catalog is larger than 1 MiB.');
                    chunks.push(chunk);
                }
                const contents = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                    contents.set(chunk, offset);
                    offset += chunk.length;
                }
                return { status, headers, text: new TextDecoder('utf-8', { fatal: true }).decode(contents) };
            } finally {
                await closeStream(stream);
            }
        }
        throw new Error('Catalog download did not complete.');
    } finally {
        if (!deadlineFired)
            GLib.Source.remove(deadline);
        session.abort();
    }
}
