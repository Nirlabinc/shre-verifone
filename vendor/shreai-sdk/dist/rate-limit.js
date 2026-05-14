import { createLogger } from './logger.js';
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

-- Initialize bucket if new
if tokens == nil then
  tokens = limit
  last_refill = now
end

-- Refill tokens based on elapsed time
local elapsed = now - last_refill
local refill_rate = limit / window
local new_tokens = math.min(limit, tokens + (elapsed * refill_rate))

-- Try to consume one token
local allowed = 0
if new_tokens >= 1 then
  new_tokens = new_tokens - 1
  allowed = 1
end

-- Update bucket
redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
redis.call('EXPIRE', key, window * 2)

-- Calculate reset time
local reset_at = now + math.ceil((limit - new_tokens) / refill_rate)

return {allowed, math.floor(new_tokens), reset_at}
`;
const DEFAULT_LIMITS = {
    perMinute: 60,
    perHour: 1000,
    burst: 10,
};
export function createRateLimiter(config) {
    const log = createLogger('shre-rate-limit');
    const prefix = config.keyPrefix || 'shre:rl';
    const tenantHeader = config.tenantHeader || 'x-tenant-id';
    const defaults = config.defaultLimits || DEFAULT_LIMITS;
    const skipIps = new Set(config.skipIps || ['127.0.0.1', '::1']);
    function getLimitsForKey(tenantId, agentId) {
        if (agentId && config.agentOverrides?.has(agentId)) {
            return config.agentOverrides.get(agentId);
        }
        if (tenantId && config.tenantOverrides?.has(tenantId)) {
            return config.tenantOverrides.get(tenantId);
        }
        return defaults;
    }
    async function checkBucket(key, limit, windowSeconds) {
        try {
            const now = Math.floor(Date.now() / 1000);
            const result = (await config.redis.eval(TOKEN_BUCKET_LUA, 1, key, limit, windowSeconds, now));
            return {
                allowed: result[0] === 1,
                remaining: result[1],
                limit,
                resetAt: result[2],
                retryAfterSeconds: result[0] === 1 ? 0 : Math.max(1, result[2] - now),
            };
        }
        catch (err) {
            log.warn('Rate limit check failed (fail-open)', { key }, err);
            return {
                allowed: true,
                remaining: limit,
                limit,
                resetAt: Math.floor(Date.now() / 1000) + windowSeconds,
                retryAfterSeconds: 0,
            };
        }
    }
    function extractClientIp(c) {
        return (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
            c.req.header('x-real-ip') ||
            c.req.raw?.socket?.remoteAddress ||
            'unknown');
    }
    return {
        middleware() {
            return async (c, next) => {
                const ip = extractClientIp(c);
                if (skipIps.has(ip)) {
                    return next();
                }
                const tenantId = c.req.header(tenantHeader) || undefined;
                const agentId = c.req.header('x-agent-id') || undefined;
                const limits = getLimitsForKey(tenantId, agentId);
                const identity = tenantId || agentId || ip;
                const minuteKey = `${prefix}:min:${identity}`;
                const minuteResult = await checkBucket(minuteKey, limits.perMinute, 60);
                c.header('X-RateLimit-Limit', String(limits.perMinute));
                c.header('X-RateLimit-Remaining', String(minuteResult.remaining));
                c.header('X-RateLimit-Reset', String(minuteResult.resetAt));
                if (!minuteResult.allowed) {
                    c.header('Retry-After', String(minuteResult.retryAfterSeconds));
                    log.warn('Rate limit exceeded', {
                        identity,
                        limit: limits.perMinute,
                        window: '1m',
                        path: c.req.path,
                    });
                    return c.json({
                        error: 'Too Many Requests',
                        message: `Rate limit exceeded. Retry after ${minuteResult.retryAfterSeconds}s.`,
                        retryAfter: minuteResult.retryAfterSeconds,
                    }, 429);
                }
                const hourKey = `${prefix}:hr:${identity}`;
                const hourResult = await checkBucket(hourKey, limits.perHour, 3600);
                if (!hourResult.allowed) {
                    c.header('Retry-After', String(hourResult.retryAfterSeconds));
                    log.warn('Hourly rate limit exceeded', {
                        identity,
                        limit: limits.perHour,
                        window: '1h',
                        path: c.req.path,
                    });
                    return c.json({
                        error: 'Too Many Requests',
                        message: `Hourly rate limit exceeded. Retry after ${hourResult.retryAfterSeconds}s.`,
                        retryAfter: hourResult.retryAfterSeconds,
                    }, 429);
                }
                return next();
            };
        },
        async check(key, limit, windowSeconds) {
            return checkBucket(`${prefix}:custom:${key}`, limit, windowSeconds);
        },
        async getRemainingQuota(tenantId) {
            const limits = getLimitsForKey(tenantId);
            const minuteKey = `${prefix}:min:${tenantId}`;
            const hourKey = `${prefix}:hr:${tenantId}`;
            const [minuteResult, hourResult] = await Promise.all([
                checkBucket(minuteKey, limits.perMinute, 60),
                checkBucket(hourKey, limits.perHour, 3600),
            ]);
            return {
                perMinute: {
                    remaining: Math.min(minuteResult.remaining + 1, limits.perMinute),
                    limit: limits.perMinute,
                    resetAt: minuteResult.resetAt,
                },
                perHour: {
                    remaining: Math.min(hourResult.remaining + 1, limits.perHour),
                    limit: limits.perHour,
                    resetAt: hourResult.resetAt,
                },
            };
        },
    };
}
