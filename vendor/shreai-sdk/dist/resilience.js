import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { createDegradationReporter, } from './degradation.js';
import { createLogger } from './logger.js';
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function withJitter(delayMs, jitter) {
    const variance = delayMs * jitter;
    return delayMs + (Math.random() * 2 - 1) * variance;
}
export function createResilience(config) {
    const log = config.logger ?? createLogger(config.service);
    const degradation = createDegradationReporter(config.service, config.degradation);
    const breakers = new Map();
    const defaults = {
        maxRetries: config.defaults?.maxRetries ?? 3,
        baseDelayMs: config.defaults?.baseDelayMs ?? 1000,
        backoff: config.defaults?.backoff ?? 2,
        jitter: config.defaults?.jitter ?? 0.1,
        timeoutMs: config.defaults?.timeoutMs ?? 10_000,
        retryIf: config.defaults?.retryIf ?? (() => true),
    };
    function getBreaker(name, opts) {
        let cb = breakers.get(name);
        if (!cb) {
            cb = new CircuitBreaker({ name, ...opts });
            breakers.set(name, cb);
        }
        return cb;
    }
    async function wrap(name, fn, opts) {
        const cleaned = opts
            ? Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined))
            : {};
        const o = { ...defaults, ...cleaned };
        const cb = getBreaker(name, { timeout: o.timeoutMs });
        let lastError;
        for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
            try {
                return await cb.call(fn);
            }
            catch (err) {
                lastError = err;
                if (err instanceof CircuitOpenError)
                    throw err;
                if (!o.retryIf(lastError))
                    throw lastError;
                if (attempt >= o.maxRetries)
                    break;
                const delay = withJitter(o.baseDelayMs * Math.pow(o.backoff, attempt), o.jitter);
                log.warn(`[resilience] ${name} attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`, {
                    error: lastError.message,
                });
                await sleep(delay);
            }
        }
        degradation.report(name, 'major', `All ${o.maxRetries + 1} attempts failed: ${lastError?.message}`);
        throw lastError;
    }
    async function fallbackChain(chain) {
        let lastError;
        for (const entry of chain) {
            try {
                return await entry.fn();
            }
            catch (err) {
                lastError = err;
                log.warn(`[resilience] fallback "${entry.name}" failed`, { error: lastError.message });
            }
        }
        throw lastError ?? new Error('Empty fallback chain');
    }
    function degrade(feature, dependency, severity) {
        degradation.report(dependency, severity, `Feature "${feature}" degraded due to ${dependency}`);
    }
    function isDegraded(feature) {
        const counts = degradation.getCounts();
        return (counts[feature] ?? 0) > 0;
    }
    function getDegradation() {
        return degradation;
    }
    return {
        wrap,
        fallbackChain,
        breaker: getBreaker,
        degrade,
        isDegraded,
        getDegradation,
    };
}
export class Bulkhead {
    name;
    maxConcurrent;
    active = 0;
    queue = [];
    maxQueue;
    constructor(name, maxConcurrent, opts) {
        this.name = name;
        this.maxConcurrent = maxConcurrent;
        this.maxQueue = opts?.maxQueue ?? 50;
    }
    async execute(fn) {
        if (this.active >= this.maxConcurrent) {
            if (this.queue.length >= this.maxQueue) {
                throw new BulkheadRejectError(this.name);
            }
            await new Promise((resolve) => this.queue.push(resolve));
        }
        this.active++;
        try {
            return await fn();
        }
        finally {
            this.active--;
            const next = this.queue.shift();
            if (next)
                next();
        }
    }
    getStats() {
        return {
            name: this.name,
            active: this.active,
            queued: this.queue.length,
            maxConcurrent: this.maxConcurrent,
            maxQueue: this.maxQueue,
        };
    }
}
export class BulkheadRejectError extends Error {
    constructor(name) {
        super(`Bulkhead '${name}' rejected: queue full`);
        this.name = 'BulkheadRejectError';
    }
}
export class StaleCache {
    cache = new Map();
    staleTtlMs;
    maxEntries;
    log;
    constructor(opts = {}) {
        this.staleTtlMs = opts.staleTtlMs ?? 300_000;
        this.maxEntries = opts.maxEntries ?? 256;
        this.log = opts.logger;
    }
    async fetchOrStale(key, fetcher) {
        try {
            const data = await fetcher();
            this.set(key, data);
            return { data, stale: false };
        }
        catch (err) {
            const cached = this.cache.get(key);
            if (cached && Date.now() - cached.ts < this.staleTtlMs) {
                this.log?.debug(`[stale-cache] Serving stale data for "${key}"`);
                return { data: cached.data, stale: true };
            }
            throw err;
        }
    }
    set(key, data) {
        if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined)
                this.cache.delete(oldest);
        }
        this.cache.set(key, { data, ts: Date.now() });
    }
    get(key) {
        return this.cache.get(key)?.data;
    }
    has(key) {
        const entry = this.cache.get(key);
        return !!entry && Date.now() - entry.ts < this.staleTtlMs;
    }
    clear() {
        this.cache.clear();
    }
}
export class RetryBudget {
    window = [];
    windowMs;
    maxRetryPct;
    constructor(windowMs = 60_000, maxRetryPct = 0.2) {
        this.windowMs = windowMs;
        this.maxRetryPct = maxRetryPct;
    }
    canRetry() {
        this.prune();
        const total = this.window.length;
        if (total === 0)
            return true;
        const retries = this.window.filter((r) => r.isRetry).length;
        return retries / total < this.maxRetryPct;
    }
    record(isRetry) {
        this.window.push({ ts: Date.now(), isRetry });
    }
    prune() {
        const cutoff = Date.now() - this.windowMs;
        this.window = this.window.filter((r) => r.ts > cutoff);
    }
}
export { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
