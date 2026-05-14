import { createLogger } from './logger.js';
import { infraUrl } from './discovery.js';
import { resolveRedisUrl as _resolveRedisUrl } from './redis.js';
const DEFAULT_REDIS_URL = _resolveRedisUrl({ port: 6380 });
const _readCounts = new Map();
const PROMOTION_READ_THRESHOLD = 5;
export const VFS_ZONES = ['tmp', 'persist', 'shared'];
export const VFS_DEFAULTS = {
    tmpTtlMs: 3_600_000,
    persistTtlMs: 0,
    sharedTtlMs: 0,
    maxValueBytes: 1_048_576,
    cortexDataType: 'agent_vfs',
    redisPrefix: 'shre:vfs:',
};
export function parsePath(path) {
    const clean = path.replace(/^\/+/, '').replace(/\/+/g, '/');
    const parts = clean.split('/');
    const zone = parts[0];
    if (!VFS_ZONES.includes(zone)) {
        throw new Error(`Invalid VFS zone '${parts[0]}'. Must be one of: ${VFS_ZONES.join(', ')}`);
    }
    if (zone === 'shared') {
        return { zone, agentId: null, key: parts.slice(1).join('/'), raw: path };
    }
    const agentId = parts[1] ?? null;
    if (!agentId) {
        throw new Error(`Path '${path}' missing agentId. Expected: /${zone}/{agentId}/...`);
    }
    const key = parts.slice(2).join('/');
    return { zone, agentId, key, raw: path };
}
async function getRedis(url, log) {
    try {
        const { default: Redis } = await import('ioredis');
        const redis = new Redis(url, {
            maxRetriesPerRequest: 2,
            connectTimeout: 3000,
            lazyConnect: true,
        });
        await redis.connect();
        return redis;
    }
    catch (err) {
        log.warn('VFS Redis connection failed — tmp zone unavailable', {
            error: err.message,
        });
        return null;
    }
}
function redisKey(parsed) {
    return `${VFS_DEFAULTS.redisPrefix}${parsed.zone}:${parsed.agentId ?? '_shared'}:${parsed.key}`;
}
async function cortexWrite(cortexUrl, entry, log) {
    try {
        const res = await fetch(`${cortexUrl}/v1/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Source': 'shre-sdk-vfs' },
            body: JSON.stringify({ data_type: VFS_DEFAULTS.cortexDataType, ...entry }),
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    }
    catch (err) {
        log.debug('VFS CortexDB write failed', { error: err.message });
        return false;
    }
}
async function cortexQuery(cortexUrl, filters, limit, log) {
    try {
        const res = await fetch(`${cortexUrl}/v1/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Source': 'shre-sdk-vfs' },
            body: JSON.stringify({
                data_type: VFS_DEFAULTS.cortexDataType,
                filters,
                limit,
                orderBy: 'updated_at',
                order: 'desc',
            }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return [];
        const data = await res.json();
        return Array.isArray(data) ? data : (data.results ?? []);
    }
    catch (err) {
        log.debug('VFS CortexDB query failed', { error: err.message });
        return [];
    }
}
async function cortexDelete(cortexUrl, filters, log) {
    try {
        const res = await fetch(`${cortexUrl}/v1/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Source': 'shre-sdk-vfs' },
            body: JSON.stringify({ data_type: VFS_DEFAULTS.cortexDataType, filters }),
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    }
    catch (err) {
        log.debug('VFS CortexDB delete failed', { error: err.message });
        return false;
    }
}
export function createVfsClient(serviceName, options = {}) {
    const log = options.logger ?? createLogger(`${serviceName}:vfs`);
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL ?? process.env.SHRE_REDIS_URL ?? DEFAULT_REDIS_URL;
    const cortexUrl = options.cortexUrl ??
        process.env.CORTEX_URL ??
        infraUrl('cortexservice') ??
        'http://127.0.0.1:5400';
    const defaultAgentId = options.agentId ?? serviceName;
    let redisClient = undefined;
    async function redis() {
        if (redisClient === undefined) {
            redisClient = await getRedis(redisUrl, log);
        }
        return redisClient;
    }
    async function read(path) {
        const parsed = parsePath(path);
        if (parsed.zone === 'tmp') {
            const r = await redis();
            if (!r)
                return null;
            const raw = await r.get(redisKey(parsed));
            if (!raw)
                return null;
            try {
                const result = JSON.parse(raw);
                const count = (_readCounts.get(path) ?? 0) + 1;
                _readCounts.set(path, count);
                if (count >= PROMOTION_READ_THRESHOLD) {
                    const persistPath = path.replace(/^\/tmp\//, '/persist/');
                    write(persistPath, result.data).catch(() => { });
                    log.info('[vfs] Auto-promoted hot tmp file to persist', {
                        path,
                        persistPath,
                        readCount: count,
                    });
                }
                return result;
            }
            catch {
                return null;
            }
        }
        const filters = {
            vfs_zone: parsed.zone,
            vfs_key: parsed.key,
        };
        if (parsed.agentId)
            filters.vfs_agent_id = parsed.agentId;
        const results = await cortexQuery(cortexUrl, filters, 1, log);
        if (results.length === 0)
            return null;
        const row = results[0];
        return {
            path: parsed.raw,
            zone: parsed.zone,
            data: row.vfs_data ?? row.data ?? row.payload,
            agentId: row.vfs_agent_id ?? parsed.agentId ?? undefined,
            createdAt: row.created_at ?? row.timestamp ?? '',
            updatedAt: row.updated_at ?? row.timestamp ?? '',
            size: JSON.stringify(row.vfs_data ?? row.data ?? '').length,
        };
    }
    async function write(path, data, opts) {
        const parsed = parsePath(path);
        const now = new Date().toISOString();
        const serialized = JSON.stringify(data);
        if (serialized.length > VFS_DEFAULTS.maxValueBytes) {
            log.warn('VFS write rejected — value too large', {
                path,
                size: serialized.length,
                max: VFS_DEFAULTS.maxValueBytes,
            });
            return false;
        }
        if (parsed.zone === 'tmp') {
            const r = await redis();
            if (!r)
                return false;
            const entry = {
                path: parsed.raw,
                zone: 'tmp',
                data,
                agentId: parsed.agentId ?? defaultAgentId,
                createdAt: now,
                updatedAt: now,
                ttlMs: opts?.ttlMs ?? VFS_DEFAULTS.tmpTtlMs,
                size: serialized.length,
            };
            const ttlSec = Math.ceil((entry.ttlMs ?? VFS_DEFAULTS.tmpTtlMs) / 1000);
            await r.set(redisKey(parsed), JSON.stringify(entry), 'EX', ttlSec);
            return true;
        }
        return cortexWrite(cortexUrl, {
            vfs_zone: parsed.zone,
            vfs_key: parsed.key,
            vfs_agent_id: parsed.agentId ?? defaultAgentId,
            vfs_data: data,
            vfs_metadata: opts?.metadata ?? {},
            vfs_size: serialized.length,
            created_at: now,
            updated_at: now,
            timestamp: now,
        }, log);
    }
    async function list(prefix, limit = 50) {
        const clean = prefix.replace(/^\/+/, '').replace(/\/+/g, '/');
        const parts = clean.split('/');
        const zone = parts[0];
        if (!VFS_ZONES.includes(zone)) {
            return [];
        }
        if (zone === 'tmp') {
            const r = await redis();
            if (!r)
                return [];
            const pattern = `${VFS_DEFAULTS.redisPrefix}tmp:${parts[1] ?? '*'}:${parts.slice(2).join('/') || '*'}`;
            const keys = [];
            let cursor = '0';
            do {
                const [next, batch] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = next;
                keys.push(...batch);
            } while (cursor !== '0' && keys.length < limit);
            const entries = [];
            for (const key of keys.slice(0, limit)) {
                const raw = await r.get(key);
                if (!raw)
                    continue;
                try {
                    const entry = JSON.parse(raw);
                    entries.push({
                        path: entry.path,
                        zone: 'tmp',
                        agentId: entry.agentId,
                        size: entry.size,
                        updatedAt: entry.updatedAt,
                    });
                }
                catch {
                    continue;
                }
            }
            return entries;
        }
        const filters = { vfs_zone: zone };
        if (zone !== 'shared' && parts[1]) {
            filters.vfs_agent_id = parts[1];
        }
        if (parts.length > 2) {
            filters.vfs_key_prefix = parts.slice(zone === 'shared' ? 1 : 2).join('/');
        }
        const results = await cortexQuery(cortexUrl, filters, limit, log);
        return results.map((row) => ({
            path: `/${zone}/${row.vfs_agent_id ? row.vfs_agent_id + '/' : ''}${row.vfs_key}`,
            zone,
            agentId: row.vfs_agent_id,
            size: row.vfs_size ?? 0,
            updatedAt: row.updated_at ?? row.timestamp ?? '',
        }));
    }
    async function del(path) {
        const parsed = parsePath(path);
        if (parsed.zone === 'tmp') {
            const r = await redis();
            if (!r)
                return false;
            const removed = await r.del(redisKey(parsed));
            return removed > 0;
        }
        const filters = {
            vfs_zone: parsed.zone,
            vfs_key: parsed.key,
        };
        if (parsed.agentId)
            filters.vfs_agent_id = parsed.agentId;
        return cortexDelete(cortexUrl, filters, log);
    }
    async function exists(path) {
        const parsed = parsePath(path);
        if (parsed.zone === 'tmp') {
            const r = await redis();
            if (!r)
                return false;
            return (await r.exists(redisKey(parsed))) > 0;
        }
        const filters = {
            vfs_zone: parsed.zone,
            vfs_key: parsed.key,
        };
        if (parsed.agentId)
            filters.vfs_agent_id = parsed.agentId;
        const results = await cortexQuery(cortexUrl, filters, 1, log);
        return results.length > 0;
    }
    return { read, write, list, delete: del, exists };
}
