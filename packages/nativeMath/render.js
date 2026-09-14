import { typeset } from './mathjax.js';

const cache = new Map();
const MAX_CACHE_ENTRIES = 128;
const MAX_SOURCE_LENGTH = 8192;

// No HTML, external resources, or runtime extension loading is enabled.
export function renderMath(source, display = false) {
    const text = String(source ?? '');
    if (!text.trim() || text.length > MAX_SOURCE_LENGTH)
        return null;

    const key = `${display}\0${text}`;
    if (cache.has(key))
        return cache.get(key);

    let result = null;
    try {
        result = typeset(text, display);
        const [, , width, height] = result.viewBox;
        if (!Number.isFinite(width) || !Number.isFinite(height)
            || width <= 0 || height <= 0 || width > 100000 || height > 100000
            || !Number.isFinite(result.depthRatio)) {
            result = null;
        }
    } catch (_error) {
        // Incomplete or unsupported TeX remains readable and copyable.
    }

    if (cache.size >= MAX_CACHE_ENTRIES)
        cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
}
