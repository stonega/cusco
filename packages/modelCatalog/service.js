import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { CatalogSnapshot } from './snapshot.js';
import { canonicalJson, validateCatalogUpgrade } from './validation.js';
import { MAX_CATALOG_BYTES } from './io.js';

const DAY_SECONDS = 24 * 60 * 60;
const DEFAULT_STATE = { enabled: true, lastAttemptAt: 0, lastSuccessAt: 0, nextAttemptAt: 0,
    retryNotBefore: 0, failures: 0, error: '' };

export class CatalogService {
    constructor({ bundled, schema, validationOptions = {}, storage, fetch,
        now = () => Math.floor(Date.now() / 1000), random = Math.random }) {
        this.snapshot = bundled;
        this._schema = schema;
        this._validationOptions = validationOptions;
        this._storage = storage;
        this._fetch = fetch;
        this._now = now;
        this._random = random;
        this._listeners = new Set();
        this._pending = null;
        this._timer = 0;
        this._started = false;
        this._accepted = null;
        this._state = { ...DEFAULT_STATE };
        try {
            const state = storage.loadState();
            if (typeof state?.enabled === 'boolean')
                this._state.enabled = state.enabled;
            for (const key of ['lastAttemptAt', 'lastSuccessAt', 'nextAttemptAt', 'retryNotBefore', 'failures']) {
                if (Number.isSafeInteger(state?.[key]) && state[key] >= 0)
                    this._state[key] = state[key];
            }
            if (typeof state?.error === 'string')
                this._state.error = state.error.slice(0, 1024);
        } catch (_) { /* A damaged settings file uses the documented defaults. */ }
        try {
            const cache = storage.loadCache();
            for (const entry of [cache?.current, cache?.previous]) {
                try {
                    if (!entry)
                        continue;
                    const snapshot = new CatalogSnapshot(entry.data, schema, validationOptions);
                    if (snapshot.revision < this.snapshot.revision)
                        continue;
                    if (snapshot.revision === this.snapshot.revision
                        && canonicalJson(snapshot.data) !== canonicalJson(this.snapshot.data))
                        continue;
                    this.snapshot = snapshot;
                    this._accepted = this._entry(entry, snapshot);
                } catch (_) { /* Try the previous accepted revision. */ }
            }
        } catch (_) { /* Offline startup always has the bundled snapshot. */ }
    }

    _entry(entry, snapshot) {
        return { data: snapshot.data, etag: typeof entry.etag === 'string' ? entry.etag.slice(0, 1024) : '',
            acceptedAt: Number.isSafeInteger(entry.acceptedAt) ? entry.acceptedAt : 0 };
    }

    getStatus() {
        return { ...this._state, revision: this.snapshot.revision, updating: Boolean(this._pending),
            source: this._accepted ? 'github' : 'bundled' };
    }

    subscribe(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    _emit(changed = false) {
        for (const listener of this._listeners) {
            try { listener(this.getStatus(), changed); } catch (error) { logError(error, 'Catalog listener failed'); }
        }
    }

    setEnabled(enabled) {
        const state = { ...this._state, enabled: Boolean(enabled) };
        this._storage.saveState(state);
        this._state = state;
        this._schedule();
        this._emit();
    }

    start() {
        if (this._started)
            return;
        this._started = true;
        this._schedule();
    }

    stop() {
        this._started = false;
        this._clearTimer();
        this._cancellable?.cancel();
    }

    _clearTimer() {
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = 0;
    }

    _schedule() {
        this._clearTimer();
        if (!this._started || !this._state.enabled || this._pending)
            return;
        // Clamp clock changes and always yield startup to the first app surface.
        const delay = Math.max(5, Math.min(DAY_SECONDS, this._state.nextAttemptAt - this._now()));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timer = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh({ force = false } = {}) {
        if (this._pending)
            return this._pending;
        if (this._now() < this._state.retryNotBefore) {
            this._schedule();
            return Promise.resolve({ updated: false, error: this._state.error });
        }
        if (!force && (!this._state.enabled || this._now() < this._state.nextAttemptAt)) {
            this._schedule();
            return Promise.resolve({ updated: false });
        }
        this._clearTimer();
        this._cancellable = new Gio.Cancellable();
        this._pending = Promise.resolve().then(() => this._refresh()).finally(() => {
            this._pending = null;
            this._cancellable = null;
            this._schedule();
            this._emit();
        });
        this._emit();
        return this._pending;
    }

    _cacheEtag() {
        if (!this._accepted?.etag)
            return '';
        try {
            const cache = this._storage.loadCache();
            if (canonicalJson(cache?.current?.data) === canonicalJson(this._accepted.data))
                return this._accepted.etag;
        } catch (_) { /* Re-download if the accepted cache is gone. */ }
        return '';
    }

    async _refresh() {
        const previousState = this._state;
        this._state = { ...this._state, lastAttemptAt: this._now() };
        let retryAt = 0;
        let response;
        try {
            // Persist the attempt before networking, including across app restarts.
            this._storage.saveState({ ...this._state, nextAttemptAt: this._now() + 60 });
            const etag = this._cacheEtag();
            response = await this._fetch({ etag, cancellable: this._cancellable });
            if (this._cancellable.is_cancelled())
                throw new Error('Catalog update was cancelled.');
            if (response.status === 304 && (!etag || !this._cacheEtag()))
                response = await this._fetch({ etag: '', cancellable: this._cancellable });
            if (this._cancellable.is_cancelled())
                throw new Error('Catalog update was cancelled.');
            let changed = false;
            if (response.status === 200) {
                if (new TextEncoder().encode(response.text).length > MAX_CATALOG_BYTES)
                    throw new Error('The model catalog is larger than 1 MiB.');
                const next = new CatalogSnapshot(JSON.parse(response.text), this._schema, this._validationOptions);
                validateCatalogUpgrade(this.snapshot.data, next.data);
                const entry = { data: next.data, etag: response.headers?.etag ?? '', acceptedAt: this._now() };
                this._storage.saveCache({ current: entry, previous: this._accepted });
                changed = next.revision !== this.snapshot.revision;
                this._accepted = entry;
                this.snapshot = next;
            } else if (response.status !== 304) {
                const headers = response.headers ?? {};
                const retryAfter = Number(headers['retry-after']);
                retryAt = Number.isFinite(retryAfter) && retryAfter > 0 ? this._now() + retryAfter
                    : Math.floor(Date.parse(headers['retry-after']) / 1000) || 0;
                if (headers['x-ratelimit-remaining'] === '0')
                    retryAt = Math.max(retryAt, Number(headers['x-ratelimit-reset']) || 0);
                if ([403, 429].includes(response.status))
                    retryAt = Math.max(retryAt, this._now() + 60);
                this._state.retryNotBefore = Math.ceil(retryAt);
                if (response.status === 404)
                    retryAt = Math.max(retryAt, this._now() + DAY_SECONDS);
                throw new Error(`Catalog download failed (HTTP ${response.status}).`);
            }
            this._state = { ...this._state, lastSuccessAt: this._now(), retryNotBefore: 0, failures: 0, error: '',
                nextAttemptAt: this._now() + Math.max(DAY_SECONDS, Number(response.headers?.['x-poll-interval']) || 0) };
            try { this._storage.saveState(this._state); } catch (error) {
                this._state.error = `Catalog loaded; update status could not be saved: ${error.message}`;
            }
            this._emit(changed);
            return { updated: changed };
        } catch (error) {
            const failures = Math.min(20, previousState.failures + 1);
            const backoff = Math.min(DAY_SECONDS, 60 * 2 ** (failures - 1)) * (1 + this._random() * 0.2);
            this._state = { ...this._state, failures, error: String(error.message).slice(0, 1024),
                nextAttemptAt: Math.ceil(Math.max(retryAt, this._now() + backoff)) };
            try { this._storage.saveState(this._state); } catch (_) { /* Keep the active snapshot even when storage fails. */ }
            return { updated: false, error: this._state.error };
        }
    }
}
