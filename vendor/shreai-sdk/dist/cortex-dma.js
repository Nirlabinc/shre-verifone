import { createLogger } from './logger.js';
import { infraUrl } from './discovery.js';
const TRUSTED_SERVICES = new Set([
    'shre-health',
    'shre-context',
    'shre-fleet',
    'shre-router',
    'shre-cortex-bridge',
    'shre-tasks',
    'shre-scorer',
    'shre-auth',
    'shre-traffic',
    'shre-api',
    'shre-registry',
    'shre-skills',
]);
class ReadCache {
    _map = new Map();
    _maxSize = 200;
    _ttlMs;
    constructor(ttlMs) {
        this._ttlMs = ttlMs;
    }
    get(key) {
        const entry = this._map.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this._map.delete(key);
            return undefined;
        }
        this._map.delete(key);
        this._map.set(key, entry);
        return entry.value;
    }
    set(key, value) {
        if (this._map.size >= this._maxSize) {
            const firstKey = this._map.keys().next().value;
            if (firstKey)
                this._map.delete(firstKey);
        }
        this._map.set(key, { value, expiresAt: Date.now() + this._ttlMs });
    }
    hits = 0;
    misses = 0;
}
export function createCortexDMA(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(`${serviceName}:dma`);
    const cortexUrl = opts.cortexUrl ?? infraUrl('cortexservice-api');
    const cacheEnabled = opts.cache !== false;
    const cache = new ReadCache(opts.cacheTtlMs ?? 30_000);
    const allowed = TRUSTED_SERVICES.has(serviceName);
    if (!allowed) {
        log.warn('[dma] Service not in trusted ring — DMA reads will be rejected', { serviceName });
    }
    let _totalReads = 0;
    let _totalSearches = 0;
    let _totalLatencyMs = 0;
    let _opCount = 0;
    function trackLatency(startMs) {
        const latency = Date.now() - startMs;
        _totalLatencyMs += latency;
        _opCount++;
        return latency;
    }
    async function query(sql, params) {
        if (!allowed)
            throw new Error(`DMA denied: ${serviceName} not in trusted ring`);
        const normalized = sql.trim().toUpperCase();
        if (!normalized.startsWith('SELECT') &&
            !normalized.startsWith('WITH') &&
            !normalized.startsWith('EXPLAIN')) {
            throw new Error('DMA is read-only: only SELECT/WITH/EXPLAIN queries allowed');
        }
        const cacheKey = `sql:${sql}:${JSON.stringify(params ?? [])}`;
        if (cacheEnabled) {
            const cached = cache.get(cacheKey);
            if (cached) {
                cache.hits++;
                return cached;
            }
            cache.misses++;
        }
        _totalReads++;
        const start = Date.now();
        try {
            const res = await fetch(`${cortexUrl}/v1/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-DMA-Source': serviceName,
                },
                body: JSON.stringify({ sql, params }),
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
                throw new Error(`DMA query failed: ${res.status} ${res.statusText}`);
            }
            const data = (await res.json());
            const result = {
                rows: data.rows ?? [],
                rowCount: data.row_count ?? (data.rows ?? []).length,
                latencyMs: trackLatency(start),
            };
            if (cacheEnabled)
                cache.set(cacheKey, result);
            return result;
        }
        catch (err) {
            trackLatency(start);
            log.debug('[dma] Query failed', { sql: sql.slice(0, 80), error: err.message });
            throw err;
        }
    }
    async function search(collection, queryText, limit = 10, minScore = 0.5) {
        if (!allowed)
            throw new Error(`DMA denied: ${serviceName} not in trusted ring`);
        const cacheKey = `search:${collection}:${queryText}:${limit}:${minScore}`;
        if (cacheEnabled) {
            const cached = cache.get(cacheKey);
            if (cached) {
                cache.hits++;
                return cached;
            }
            cache.misses++;
        }
        _totalSearches++;
        const start = Date.now();
        try {
            const res = await fetch(`${cortexUrl}/v1/search`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-DMA-Source': serviceName,
                },
                body: JSON.stringify({ collection, query: queryText, limit, min_score: minScore }),
                signal: AbortSignal.timeout(3000),
            });
            if (!res.ok) {
                throw new Error(`DMA search failed: ${res.status} ${res.statusText}`);
            }
            const data = (await res.json());
            const result = {
                results: data.results ?? [],
                latencyMs: trackLatency(start),
            };
            if (cacheEnabled)
                cache.set(cacheKey, result);
            return result;
        }
        catch (err) {
            trackLatency(start);
            log.debug('[dma] Search failed', { collection, error: err.message });
            throw err;
        }
    }
    async function redisGet(key) {
        if (!allowed)
            throw new Error(`DMA denied: ${serviceName} not in trusted ring`);
        const cacheKey = `redis:${key}`;
        if (cacheEnabled) {
            const cached = cache.get(cacheKey);
            if (cached !== undefined) {
                cache.hits++;
                return cached;
            }
            cache.misses++;
        }
        _totalReads++;
        const start = Date.now();
        try {
            const res = await fetch(`${cortexUrl}/v1/redis/get`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-DMA-Source': serviceName,
                },
                body: JSON.stringify({ key }),
                signal: AbortSignal.timeout(1000),
            });
            if (!res.ok)
                return null;
            const data = (await res.json());
            trackLatency(start);
            const value = data.value ?? null;
            if (cacheEnabled)
                cache.set(cacheKey, value);
            return value;
        }
        catch {
            trackLatency(start);
            return null;
        }
    }
    async function redisGetMulti(keys) {
        if (!allowed)
            throw new Error(`DMA denied: ${serviceName} not in trusted ring`);
        const result = new Map();
        const uncached = [];
        if (cacheEnabled) {
            for (const key of keys) {
                const cached = cache.get(`redis:${key}`);
                if (cached !== undefined) {
                    cache.hits++;
                    result.set(key, cached);
                }
                else {
                    cache.misses++;
                    uncached.push(key);
                }
            }
        }
        else {
            uncached.push(...keys);
        }
        if (uncached.length === 0)
            return result;
        _totalReads++;
        const start = Date.now();
        try {
            const res = await fetch(`${cortexUrl}/v1/redis/mget`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-DMA-Source': serviceName,
                },
                body: JSON.stringify({ keys: uncached }),
                signal: AbortSignal.timeout(2000),
            });
            if (!res.ok) {
                for (const key of uncached)
                    result.set(key, null);
                return result;
            }
            const data = (await res.json());
            trackLatency(start);
            for (const key of uncached) {
                const value = data.values?.[key] ?? null;
                result.set(key, value);
                if (cacheEnabled)
                    cache.set(`redis:${key}`, value);
            }
        }
        catch {
            trackLatency(start);
            for (const key of uncached)
                result.set(key, null);
        }
        return result;
    }
    log.info('[dma] CortexDB DMA initialized', {
        service: serviceName,
        allowed,
        cacheEnabled,
        cacheTtlMs: opts.cacheTtlMs ?? 30_000,
    });
    return {
        query,
        search,
        redisGet,
        redisGetMulti,
        stats: () => ({
            totalReads: _totalReads,
            totalSearches: _totalSearches,
            avgLatencyMs: _opCount > 0 ? Math.round(_totalLatencyMs / _opCount) : 0,
            cacheHits: cache.hits,
            cacheMisses: cache.misses,
        }),
        isAllowed: () => allowed,
    };
}
