import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';
import { fetchCatalog } from '../packages/modelCatalog/io.js';

function assert(value, message) { if (!value) throw new Error(message); }
async function rejects(callback, expected) {
    let error;
    try { await callback(); } catch (failure) { error = failure; }
    assert(error && (!expected || error.message.includes(expected)), `Expected ${expected ?? 'request failure'}: ${error?.message}`);
}

const server = new Soup.Server();
let requests = 0;
let paused = null;
server.add_handler(null, (_server, message, path) => {
    requests++;
    const headers = message.get_request_headers();
    assert(!headers.get_one('Authorization') && !headers.get_one('Cookie'), 'Catalog request included credentials');
    assert(headers.get_one('Accept') === 'application/vnd.github.raw+json', 'Incorrect GitHub media type');
    if (path === '/redirect' || path === '/outside' || path === '/loop') {
        const location = path === '/redirect' ? '/catalog' : path === '/outside' ? 'https://example.invalid/catalog' : '/loop';
        message.set_redirect(302, location);
    } else if (path === '/catalog') {
        message.get_response_headers().replace('ETag', '"catalog-test"');
        if (headers.get_one('If-None-Match') === '"catalog-test"')
            message.set_status(304, null);
        else {
            message.set_status(200, null);
            message.set_response('application/json', Soup.MemoryUse.COPY, '{"revision":1}');
        }
    } else if (path === '/large' || path === '/chunked') {
        message.set_status(200, null);
        message.set_response('application/json', Soup.MemoryUse.COPY, 'x'.repeat(1024 * 1024 + 1));
        if (path === '/chunked')
            message.get_response_headers().set_encoding(Soup.Encoding.CHUNKED);
    } else if (path === '/slow') {
        paused = message;
        message.pause();
    } else {
        message.get_response_headers().replace('Retry-After', '300');
        message.set_status(429, null);
    }
});

try {
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
} catch (error) {
    throw new Error(`Catalog HTTP smoke requires local sockets: ${error.message}`);
}
const base = server.get_uris()[0].to_string().replace(/\/$/, '');
const options = {
    urlPolicy: url => url.startsWith(`${base}/`),
    sessionFactory: settings => new Soup.Session({ ...settings,
        proxy_resolver: new Gio.SimpleProxyResolver({ default_proxy: null }) }),
};
try {
    // The production policy must reject HTTP before opening a connection.
    await rejects(() => fetchCatalog(`${base}/catalog`), 'approved GitHub hosts');
    assert(requests === 0, 'Production URL policy allowed a local HTTP request');
    const initial = await fetchCatalog(`${base}/catalog`, options);
    assert(initial.status === 200 && initial.text === '{"revision":1}' && initial.headers.etag === '"catalog-test"', 'Response body or headers were lost');
    const unchanged = await fetchCatalog(`${base}/catalog`, { ...options, etag: initial.headers.etag });
    assert(unchanged.status === 304 && unchanged.text === '', 'Conditional HTTP request failed');
    assert((await fetchCatalog(`${base}/redirect`, options)).status === 200, 'Approved redirect failed');
    await rejects(() => fetchCatalog(`${base}/outside`, options), 'approved GitHub hosts');
    await rejects(() => fetchCatalog(`${base}/loop`, options), 'Too many');
    await rejects(() => fetchCatalog(`${base}/large`, options), 'larger than 1 MiB');
    await rejects(() => fetchCatalog(`${base}/chunked`, options), 'larger than 1 MiB');
    const limited = await fetchCatalog(`${base}/limited`, options);
    assert(limited.status === 429 && limited.headers['retry-after'] === '300', 'Rate limit headers were discarded');
    await rejects(() => fetchCatalog(`${base}/slow`, { ...options, timeoutSeconds: 1 }));
} finally {
    if (paused) {
        paused.set_status(503, null);
        paused.unpause();
    }
    server.disconnect();
}
print('Cusco model catalog HTTP smoke passed');
