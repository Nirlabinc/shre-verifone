import { hostname } from 'node:os';
import { createLogger } from './logger.js';
import { resolveRedisPassword } from './redis.js';
export function getNodeId() {
    return process.env.SHRE_NODE_ID || `${hostname()}-${process.pid}`;
}
export function createLeaderElection(lockName, opts) {
    const log = createLogger('shre-sdk:leader-election');
    const ttlMs = opts?.ttlMs ?? 30_000;
    const renewMs = opts?.renewMs ?? Math.floor(ttlMs / 3);
    const nodeId = getNodeId();
    const lockKey = `shre:leader:${lockName}`;
    let _redis = null;
    let _isLeader = false;
    let _renewTimer = null;
    async function getRedis() {
        if (_redis)
            return _redis;
        const url = opts?.redisUrl || process.env.REDIS_URL || process.env.SHRE_REDIS_URL;
        if (!url)
            return null;
        try {
            const password = resolveRedisPassword();
            const { default: Redis } = await import('ioredis');
            _redis = new Redis(url, {
                password: password || undefined,
                maxRetriesPerRequest: 1,
                connectTimeout: 3000,
                lazyConnect: true,
            });
            await _redis.connect();
            return _redis;
        }
        catch (err) {
            log.warn(`[leader-election] Redis unavailable for lock "${lockName}", assuming single-node`, {
                error: err.message,
            });
            return null;
        }
    }
    async function acquire() {
        const redis = await getRedis();
        if (!redis) {
            _isLeader = true;
            return true;
        }
        try {
            const result = await redis.set(lockKey, nodeId, 'PX', ttlMs, 'NX');
            if (result === 'OK') {
                _isLeader = true;
                startRenewal();
                log.info(`[leader-election] Acquired lock "${lockName}"`, { nodeId });
                return true;
            }
            const holder = await redis.get(lockKey);
            if (holder === nodeId) {
                _isLeader = true;
                startRenewal();
                return true;
            }
            _isLeader = false;
            return false;
        }
        catch (err) {
            log.warn(`[leader-election] acquire() failed for "${lockName}"`, {
                error: err.message,
            });
            _isLeader = true;
            return true;
        }
    }
    async function release() {
        stopRenewal();
        _isLeader = false;
        const redis = await getRedis();
        if (!redis)
            return;
        try {
            await redis.eval(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`, 1, lockKey, nodeId);
            log.info(`[leader-election] Released lock "${lockName}"`, { nodeId });
        }
        catch {
        }
    }
    async function withLock(fn) {
        const acquired = await acquire();
        if (!acquired)
            return null;
        try {
            return await fn();
        }
        finally {
            await release();
        }
    }
    function isLeader() {
        return _isLeader;
    }
    function startRenewal() {
        if (_renewTimer)
            return;
        _renewTimer = setInterval(async () => {
            const redis = await getRedis();
            if (!redis)
                return;
            try {
                const result = await redis.eval(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`, 1, lockKey, nodeId, String(ttlMs));
                if (result === 0) {
                    _isLeader = false;
                    stopRenewal();
                    log.warn(`[leader-election] Lost lock "${lockName}" — another node took over`, {
                        nodeId,
                    });
                }
            }
            catch {
            }
        }, renewMs);
        if (_renewTimer.unref)
            _renewTimer.unref();
    }
    function stopRenewal() {
        if (_renewTimer) {
            clearInterval(_renewTimer);
            _renewTimer = null;
        }
    }
    async function shutdown() {
        await release();
        if (_redis) {
            try {
                _redis.disconnect();
            }
            catch {
            }
            _redis = null;
        }
    }
    return { acquire, release, withLock, isLeader, shutdown };
}
