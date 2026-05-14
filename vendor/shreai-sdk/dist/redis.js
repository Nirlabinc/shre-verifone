import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger.js';
const HOME = homedir();
function readVaultPassword() {
    try {
        const vaultPath = join(HOME, '.shre', 'vault', 'cortexdb.json');
        if (!existsSync(vaultPath))
            return undefined;
        const vault = JSON.parse(readFileSync(vaultPath, 'utf-8'));
        return vault.REDIS_PASSWORD || vault.redis_password || undefined;
    }
    catch {
        return undefined;
    }
}
function readCortexEnvPassword() {
    try {
        const possiblePaths = [
            process.env.SHRE_PROJECT_ROOT
                ? join(process.env.SHRE_PROJECT_ROOT, 'cortexdb', '.env')
                : null,
            join(process.cwd(), 'cortexdb', '.env'),
            join(process.cwd(), '..', 'cortexdb', '.env'),
            join(HOME, 'Documents/Projects/shreai/cortexdb/.env'),
        ].filter((p) => !!p);
        for (const envPath of possiblePaths) {
            if (existsSync(envPath)) {
                const content = readFileSync(envPath, 'utf-8');
                const match = content.match(/(?:REDIS_PASSWORD|STREAM_PASSWORD)=(.+)/);
                if (match?.[1])
                    return match[1].trim();
            }
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
export function resolveRedisPassword(explicit) {
    if (process.env.REDIS_NO_AUTH === '1')
        return undefined;
    if (explicit)
        return explicit;
    if (process.env.REDIS_PASSWORD)
        return process.env.REDIS_PASSWORD;
    const vaultPw = readVaultPassword();
    if (vaultPw)
        return vaultPw;
    return readCortexEnvPassword();
}
export function resolveRedisUrl(opts) {
    const host = opts?.host ?? process.env.REDIS_HOST ?? '127.0.0.1';
    const port = opts?.port ?? (Number(process.env.REDIS_PORT) || 6379);
    const password = resolveRedisPassword(opts?.password);
    return password ? `redis://:${password}@${host}:${port}` : `redis://${host}:${port}`;
}
export async function createRedisClient(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const host = opts.host ?? process.env.REDIS_HOST ?? '127.0.0.1';
    const port = opts.port ?? (Number(process.env.REDIS_PORT) || 6379);
    const password = resolveRedisPassword(opts.password);
    if (!password) {
        log.warn('Redis password not found in any source (env, vault, cortexdb/.env)');
    }
    const { default: Redis } = await import('ioredis');
    const client = new Redis({
        host,
        port,
        password,
        db: opts.db ?? 0,
        lazyConnect: opts.lazyConnect ?? true,
        maxRetriesPerRequest: opts.maxRetriesPerRequest ?? null,
        connectTimeout: opts.connectTimeout ?? 5_000,
        enableReadyCheck: true,
        retryStrategy: opts.retryStrategy ?? ((times) => Math.min(times * 200, 5_000)),
        reconnectOnError: (err) => {
            if (err.message.includes('NOAUTH') || err.message.includes('ERR AUTH')) {
                log.warn('Redis NOAUTH — will reconnect with fresh credentials');
                return true;
            }
            return false;
        },
    });
    client.on('connect', () => {
        log.debug(`Redis connected (${host}:${port})`, { service: serviceName });
    });
    client.on('error', (err) => {
        if (!err.message.includes('ECONNREFUSED')) {
            log.warn('Redis connection error', { service: serviceName, error: err.message });
        }
    });
    client.on('close', () => {
        log.debug('Redis connection closed', { service: serviceName });
    });
    return client;
}
export async function createRedisClientPair(serviceName, opts = {}) {
    const [writeClient, readClient, subClient] = await Promise.all([
        createRedisClient(`${serviceName}:write`, opts),
        createRedisClient(`${serviceName}:read`, opts),
        createRedisClient(`${serviceName}:sub`, opts),
    ]);
    return { writeClient, readClient, subClient };
}
