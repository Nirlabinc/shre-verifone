import { createLogger } from './logger.js';
function createCircuit(threshold = 5, cooldownMs = 60_000) {
    return { failures: 0, state: 'closed', lastFailure: 0, cooldownMs, threshold };
}
function isCircuitOpen(c) {
    if (c.state === 'closed')
        return false;
    if (c.state === 'open' && Date.now() - c.lastFailure >= c.cooldownMs) {
        c.state = 'half-open';
        return false;
    }
    return c.state === 'open';
}
function recordSuccess(c) {
    c.failures = 0;
    c.state = 'closed';
}
function recordFailure(c) {
    c.failures++;
    c.lastFailure = Date.now();
    if (c.failures >= c.threshold)
        c.state = 'open';
}
function createBucket(rpm) {
    const maxTokens = Math.max(1, Math.ceil(rpm / 60));
    return {
        tokens: maxTokens,
        maxTokens,
        refillRate: rpm / 60_000,
        lastRefill: Date.now(),
        queue: [],
    };
}
function refillBucket(b) {
    const now = Date.now();
    b.tokens = Math.min(b.maxTokens, b.tokens + (now - b.lastRefill) * b.refillRate);
    b.lastRefill = now;
}
function acquireToken(b) {
    refillBucket(b);
    if (b.tokens >= 1) {
        b.tokens--;
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const waitMs = Math.ceil((1 - b.tokens) / b.refillRate);
        const timer = setTimeout(() => {
            b.queue = b.queue.filter((e) => e.resolve !== resolve);
            refillBucket(b);
            b.tokens = Math.max(0, b.tokens - 1);
            resolve();
        }, waitMs);
        b.queue.push({ resolve, timer });
    });
}
class LRUCache {
    maxSize;
    map = new Map();
    constructor(maxSize = 256) {
        this.maxSize = maxSize;
    }
    get(key) {
        const entry = this.map.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.map.delete(key);
            return undefined;
        }
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }
    set(key, value, ttlMs) {
        this.map.delete(key);
        if (this.map.size >= this.maxSize) {
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined)
                this.map.delete(oldest);
        }
        this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
    clearByPrefix(prefix) {
        for (const key of Array.from(this.map.keys())) {
            if (key.startsWith(prefix))
                this.map.delete(key);
        }
    }
    clear() {
        this.map.clear();
    }
}
function shapeSignature(obj, depth = 0) {
    if (depth > 4)
        return '...';
    if (obj === null)
        return 'null';
    if (Array.isArray(obj))
        return `[${obj.length > 0 ? shapeSignature(obj[0], depth + 1) : 'empty'}]`;
    if (typeof obj === 'object') {
        const keys = Object.keys(obj).sort();
        return `{${keys.map((k) => `${k}:${shapeSignature(obj[k], depth + 1)}`).join(',')}}`;
    }
    return typeof obj;
}
export function createExternalApiClient(serviceName, options) {
    const log = createLogger(`${serviceName}/ext-api`);
    const providers = new Map();
    const cache = new LRUCache(options?.cacheMaxSize ?? 256);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const backoff = (attempt) => {
        const base = Math.min(1000 * 2 ** attempt, 16_000);
        return sleep(base + Math.random() * base * 0.5);
    };
    function register(config) {
        const existing = providers.get(config.name);
        if (existing) {
            existing.config = config;
            log.info('Provider updated', { provider: config.name });
            return;
        }
        providers.set(config.name, {
            config,
            circuit: createCircuit(),
            bucket: config.rateLimit ? createBucket(config.rateLimit.rpm) : null,
            keyIndex: 0,
            stats: { requests: 0, errors: 0, totalLatencyMs: 0, cacheHits: 0 },
            lastSchema: null,
        });
        log.info('Provider registered', { provider: config.name, baseUrl: config.baseUrl });
    }
    function getAuthHeaders(p) {
        const { auth } = p.config;
        if (auth.type === 'none' || !auth.keys?.length)
            return {};
        const key = auth.keys[p.keyIndex % auth.keys.length];
        if (auth.type === 'bearer')
            return { Authorization: `Bearer ${key}` };
        if (auth.type === 'basic')
            return { Authorization: `Basic ${Buffer.from(key).toString('base64')}` };
        if (auth.type === 'api-key') {
            const hdr = {};
            hdr[auth.headerName ?? 'X-API-Key'] = key;
            return hdr;
        }
        return {};
    }
    function rotateKey(p) {
        const keys = p.config.auth.keys;
        if (!keys || keys.length <= 1)
            return false;
        p.keyIndex = (p.keyIndex + 1) % keys.length;
        log.warn('Auth key rotated', { provider: p.config.name, keyIndex: p.keyIndex });
        return true;
    }
    async function request(providerName, method, path, body, params) {
        const p = providers.get(providerName);
        if (!p)
            throw new Error(`Provider "${providerName}" not registered`);
        const cacheKey = `${providerName}:${method}:${path}:${JSON.stringify(params ?? {})}`;
        if (method === 'GET' && p.config.cacheTtlMs) {
            const cached = cache.get(cacheKey);
            if (cached !== undefined) {
                p.stats.cacheHits++;
                return cached;
            }
        }
        if (isCircuitOpen(p.circuit)) {
            p.stats.errors++;
            throw new Error(`Circuit open for "${providerName}"`);
        }
        if (p.bucket)
            await acquireToken(p.bucket);
        const maxRetries = p.config.retries ?? 3;
        let lastError = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const url = new URL(path, p.config.baseUrl.endsWith('/') ? p.config.baseUrl : p.config.baseUrl + '/');
            if (params)
                for (const [k, v] of Object.entries(params))
                    url.searchParams.set(k, v);
            const headers = { Accept: 'application/json', ...getAuthHeaders(p) };
            if (body !== undefined)
                headers['Content-Type'] = 'application/json';
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), p.config.timeoutMs ?? 15_000);
            const start = Date.now();
            try {
                p.stats.requests++;
                const res = await fetch(url.toString(), {
                    method,
                    headers,
                    signal: controller.signal,
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                });
                p.stats.totalLatencyMs += Date.now() - start;
                if ((res.status === 401 || res.status === 403) && rotateKey(p)) {
                    lastError = new Error(`Auth failed (${res.status})`);
                    continue;
                }
                if (res.status === 429) {
                    const ra = res.headers.get('Retry-After');
                    const waitMs = ra && Number(ra) > 0 ? Number(ra) * 1000 : 1000;
                    if (attempt < maxRetries) {
                        await sleep(Math.min(waitMs, 30_000));
                        continue;
                    }
                    recordFailure(p.circuit);
                    p.stats.errors++;
                    throw new Error(`Rate limited by "${providerName}" after ${maxRetries} retries`);
                }
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    lastError = new Error(`${providerName} ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
                    recordFailure(p.circuit);
                    if (attempt < maxRetries && res.status >= 500) {
                        await backoff(attempt);
                        continue;
                    }
                    p.stats.errors++;
                    throw lastError;
                }
                recordSuccess(p.circuit);
                const data = (await res.json());
                const sig = shapeSignature(data);
                if (p.lastSchema !== null && sig !== p.lastSchema) {
                    log.warn('Response schema changed', {
                        provider: providerName,
                        path,
                        prev: p.lastSchema,
                        curr: sig,
                    });
                }
                p.lastSchema = sig;
                if (method === 'GET' && p.config.cacheTtlMs)
                    cache.set(cacheKey, data, p.config.cacheTtlMs);
                return data;
            }
            catch (err) {
                p.stats.totalLatencyMs += Date.now() - start;
                if (err.name === 'AbortError') {
                    lastError = new Error(`Timeout after ${p.config.timeoutMs ?? 15_000}ms calling ${providerName}`);
                }
                else if (!(err instanceof Error) || !err.message.startsWith(providerName)) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                }
                else {
                    lastError = err;
                }
                recordFailure(p.circuit);
                if (attempt < maxRetries) {
                    await backoff(attempt);
                    continue;
                }
                p.stats.errors++;
                throw lastError;
            }
            finally {
                clearTimeout(timer);
            }
        }
        p.stats.errors++;
        throw lastError ?? new Error(`Request to "${providerName}" failed`);
    }
    function deriveHealth(p) {
        if (p.circuit.state === 'open')
            return 'down';
        if (p.circuit.state === 'half-open')
            return 'degraded';
        if (p.stats.requests > 0 && p.stats.errors / p.stats.requests > 0.5)
            return 'degraded';
        if (p.bucket && p.bucket.tokens <= 0)
            return 'rate-limited';
        return 'healthy';
    }
    return {
        register,
        get(provider, path, params) {
            return request(provider, 'GET', path, undefined, params);
        },
        post(provider, path, body) {
            return request(provider, 'POST', path, body);
        },
        getHealth(provider) {
            const result = {};
            if (provider) {
                const p = providers.get(provider);
                if (p)
                    result[provider] = deriveHealth(p);
            }
            else
                providers.forEach((p, name) => {
                    result[name] = deriveHealth(p);
                });
            return result;
        },
        getStats() {
            const result = {};
            providers.forEach((p, name) => {
                result[name] = {
                    requests: p.stats.requests,
                    errors: p.stats.errors,
                    cacheHits: p.stats.cacheHits,
                    avgLatencyMs: p.stats.requests > 0 ? Math.round(p.stats.totalLatencyMs / p.stats.requests) : 0,
                };
            });
            return result;
        },
        clearCache(provider) {
            if (provider) {
                cache.clearByPrefix(`${provider}:`);
                log.info('Cache cleared', { provider });
            }
            else {
                cache.clear();
                log.info('All caches cleared');
            }
        },
    };
}
