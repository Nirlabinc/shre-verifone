const _allCaches = [];
export function getAllCacheStats() {
    return _allCaches.map((c) => c.stats());
}
export class TTLCache {
    map = new Map();
    maxEntries;
    ttlMs;
    cacheName;
    sweepTimer = null;
    _hits = 0;
    _misses = 0;
    _evictions = 0;
    _expired = 0;
    constructor(opts = {}) {
        this.maxEntries = opts.maxEntries ?? 1000;
        this.ttlMs = opts.ttlMs ?? 300_000;
        this.cacheName = opts.name ?? 'unnamed';
        const shouldSweep = opts.sweep !== false;
        if (shouldSweep) {
            const interval = opts.sweepIntervalMs ?? this.ttlMs;
            this.sweepTimer = setInterval(() => this.sweep(), interval);
            if (this.sweepTimer.unref)
                this.sweepTimer.unref();
        }
        _allCaches.push(this);
    }
    get(key) {
        const entry = this.map.get(key);
        if (!entry) {
            this._misses++;
            return undefined;
        }
        if (Date.now() - entry.createdAt > this.ttlMs) {
            this.map.delete(key);
            this._expired++;
            this._misses++;
            return undefined;
        }
        entry.lastAccessedAt = Date.now();
        this._hits++;
        return entry.value;
    }
    has(key) {
        const entry = this.map.get(key);
        if (!entry)
            return false;
        if (Date.now() - entry.createdAt > this.ttlMs) {
            this.map.delete(key);
            this._expired++;
            return false;
        }
        return true;
    }
    set(key, value) {
        if (this.map.has(key)) {
            this.map.delete(key);
        }
        else if (this.map.size >= this.maxEntries) {
            this.evictLRU();
        }
        const now = Date.now();
        this.map.set(key, {
            value,
            createdAt: now,
            lastAccessedAt: now,
        });
    }
    delete(key) {
        return this.map.delete(key);
    }
    deleteByPrefix(prefix) {
        let count = 0;
        for (const key of this.map.keys()) {
            if (key.startsWith(prefix)) {
                this.map.delete(key);
                count++;
            }
        }
        return count;
    }
    clear() {
        this.map.clear();
    }
    get size() {
        return this.map.size;
    }
    *entries() {
        const now = Date.now();
        for (const [key, entry] of this.map) {
            if (now - entry.createdAt <= this.ttlMs) {
                yield [key, entry.value];
            }
        }
    }
    sweep() {
        const now = Date.now();
        let swept = 0;
        for (const [key, entry] of this.map) {
            if (now - entry.createdAt > this.ttlMs) {
                this.map.delete(key);
                this._expired++;
                swept++;
            }
        }
        return swept;
    }
    stats() {
        const total = this._hits + this._misses;
        return {
            name: this.cacheName,
            size: this.map.size,
            maxEntries: this.maxEntries,
            ttlMs: this.ttlMs,
            hits: this._hits,
            misses: this._misses,
            evictions: this._evictions,
            expired: this._expired,
            hitRate: total > 0 ? `${Math.round((this._hits / total) * 100)}%` : '0%',
        };
    }
    destroy() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        const idx = _allCaches.indexOf(this);
        if (idx >= 0)
            _allCaches.splice(idx, 1);
    }
    evictLRU() {
        let oldestKey = null;
        let oldestAccess = Infinity;
        for (const [key, entry] of this.map) {
            if (entry.lastAccessedAt < oldestAccess) {
                oldestAccess = entry.lastAccessedAt;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            this.map.delete(oldestKey);
            this._evictions++;
        }
    }
}
export function createTTLCache(opts = {}) {
    return new TTLCache(opts);
}
