import { createLogger } from './logger.js';
import { serviceUrl } from './discovery.js';
class TTLCache {
    ttlMs;
    store = new Map();
    constructor(ttlMs) {
        this.ttlMs = ttlMs;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }
    set(key, value) {
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }
    clear() {
        this.store.clear();
    }
    deleteByPrefix(prefix) {
        for (const key of this.store.keys()) {
            if (key.startsWith(prefix))
                this.store.delete(key);
        }
    }
}
export function createAgentScope(config = {}) {
    const log = config.logger ?? createLogger('agent-scope');
    const cacheTtl = config.cacheTtlMs ?? 60_000;
    const timeout = config.timeoutMs ?? 5000;
    const cache = new TTLCache(cacheTtl);
    function getRouterUrl() {
        if (config.routerUrl)
            return config.routerUrl;
        try {
            return serviceUrl('shre-router');
        }
        catch (err) {
            log.debug('[agent-scope] Router URL discovery failed, using default', {
                error: err.message,
            });
            return 'https://127.0.0.1:5497';
        }
    }
    async function canAccess(agentId, tenantId, sourceType, sourceId) {
        const cacheKey = `${agentId}:${tenantId}:${sourceType}:${sourceId}`;
        const cached = cache.get(cacheKey);
        if (cached !== undefined)
            return cached;
        try {
            const params = new URLSearchParams({ agentId, tenantId, sourceType, sourceId });
            const resp = await fetch(`${getRouterUrl()}/v1/data-permissions/check?${params}`, {
                signal: AbortSignal.timeout(timeout),
            });
            if (resp.ok) {
                const data = (await resp.json());
                const level = data.level ?? 'none';
                cache.set(cacheKey, level);
                return level;
            }
            log.warn('[agent-scope] Permission check returned non-OK', {
                status: resp.status,
                agentId,
                sourceType,
                sourceId,
            });
        }
        catch (err) {
            log.warn('[agent-scope] Permission check failed, defaulting to none', {
                agentId,
                error: err.message,
            });
        }
        cache.set(cacheKey, 'none');
        return 'none';
    }
    async function listAccessible(agentId, tenantId) {
        try {
            const params = new URLSearchParams({ agentId, tenantId });
            const resp = await fetch(`${getRouterUrl()}/v1/data-permissions?${params}`, {
                signal: AbortSignal.timeout(timeout),
            });
            if (resp.ok) {
                const data = (await resp.json());
                return data.grants ?? [];
            }
        }
        catch (err) {
            log.warn('[agent-scope] Failed to list accessible data', {
                agentId,
                error: err.message,
            });
        }
        return [];
    }
    function scopeMiddleware() {
        return async (c, next) => {
            const agentId = c.req.header('x-shre-agent-id') ?? 'main';
            const tenantId = c.req.header('x-tenant-id') ?? 'default';
            c.set('agentScope', {
                agentId,
                tenantId,
                canAccess: (sourceType, sourceId) => canAccess(agentId, tenantId, sourceType, sourceId),
                listAccessible: () => listAccessible(agentId, tenantId),
            });
            await next();
        };
    }
    function clearCache() {
        cache.clear();
    }
    function invalidateAgent(agentId) {
        cache.deleteByPrefix(`${agentId}:`);
    }
    return { canAccess, listAccessible, scopeMiddleware, clearCache, invalidateAgent };
}
