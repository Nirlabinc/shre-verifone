import { createLogger } from './logger.js';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEGRADED_THRESHOLD = 2;
const DEFAULT_DOWN_THRESHOLD = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 600_000;
const BACKOFF_MULTIPLIER = 2;
export function createExternalMonitor(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(`${serviceName}/external-monitor`);
    const apis = new Map();
    let running = false;
    function toStatus(entry) {
        const successCount = entry.totalChecks - entry.totalFailures;
        return {
            name: entry.config.name,
            url: entry.config.url,
            state: entry.state,
            lastCheck: entry.lastCheck,
            lastSuccess: entry.lastSuccess,
            latencyMs: entry.latencyMs,
            avgLatencyMs: entry.totalChecks > 0 ? Math.round(entry.latencySum / entry.totalChecks) : 0,
            uptimePct: entry.totalChecks > 0 ? Math.round((successCount / entry.totalChecks) * 10000) / 100 : 100,
            consecutiveFailures: entry.consecutiveFailures,
            totalChecks: entry.totalChecks,
            totalFailures: entry.totalFailures,
            backoffUntil: entry.backoffUntil > Date.now() ? new Date(entry.backoffUntil).toISOString() : null,
        };
    }
    function transitionState(entry, newState) {
        const prev = entry.state;
        if (prev === newState)
            return;
        entry.state = newState;
        const status = toStatus(entry);
        log.info('API state transition', { api: entry.config.name, from: prev, to: newState });
        if (newState === 'healthy' && prev !== 'healthy') {
            opts.onRecovered?.(status);
        }
        else if (newState === 'degraded') {
            opts.onDegraded?.(status);
        }
        else if (newState === 'down') {
            opts.onDown?.(status);
        }
        else if (newState === 'rate_limited') {
            opts.onRateLimited?.(status);
        }
    }
    async function probe(entry) {
        if (entry.backoffUntil > Date.now()) {
            log.debug('Skipping probe (backoff)', {
                api: entry.config.name,
                until: new Date(entry.backoffUntil).toISOString(),
            });
            return;
        }
        const start = Date.now();
        entry.totalChecks++;
        entry.lastCheck = new Date().toISOString();
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), entry.config.timeout);
            const res = await fetch(entry.config.url, {
                method: 'GET',
                headers: entry.config.headers ?? {},
                signal: controller.signal,
            });
            clearTimeout(timeout);
            const elapsed = Date.now() - start;
            entry.latencyMs = elapsed;
            entry.latencySum += elapsed;
            if (res.status === 429) {
                entry.totalFailures++;
                entry.consecutiveFailures++;
                entry.backoffMultiplier = Math.min(entry.backoffMultiplier * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS / BASE_BACKOFF_MS);
                const backoffMs = Math.min(BASE_BACKOFF_MS * entry.backoffMultiplier, MAX_BACKOFF_MS);
                entry.backoffUntil = Date.now() + backoffMs;
                log.warn('API rate limited', {
                    api: entry.config.name,
                    backoffMs,
                    until: new Date(entry.backoffUntil).toISOString(),
                });
                transitionState(entry, 'rate_limited');
                return;
            }
            if (res.ok) {
                entry.consecutiveFailures = 0;
                entry.backoffMultiplier = 1;
                entry.backoffUntil = 0;
                entry.lastSuccess = new Date().toISOString();
                transitionState(entry, 'healthy');
            }
            else {
                entry.totalFailures++;
                entry.consecutiveFailures++;
                handleFailure(entry, `HTTP ${res.status}`);
            }
        }
        catch (err) {
            const elapsed = Date.now() - start;
            entry.latencyMs = elapsed;
            entry.latencySum += elapsed;
            entry.totalFailures++;
            entry.consecutiveFailures++;
            const message = err instanceof Error ? err.message : String(err);
            const isTimeout = message.includes('abort');
            handleFailure(entry, isTimeout ? 'timeout' : message);
        }
    }
    function handleFailure(entry, reason) {
        const { consecutiveFailures } = entry;
        const { degradedThreshold, downThreshold, name } = entry.config;
        if (consecutiveFailures >= downThreshold) {
            log.error('API down', { api: name, failures: consecutiveFailures, reason });
            transitionState(entry, 'down');
        }
        else if (consecutiveFailures >= degradedThreshold) {
            log.warn('API degraded', { api: name, failures: consecutiveFailures, reason });
            transitionState(entry, 'degraded');
        }
    }
    function startProbing(entry) {
        if (entry.timer)
            return;
        probe(entry).catch((err) => log.error('Probe error', { api: entry.config.name, err }));
        entry.timer = setInterval(() => probe(entry).catch((err) => log.error('Probe error', { api: entry.config.name, err })), entry.config.intervalMs);
    }
    function stopProbing(entry) {
        if (entry.timer) {
            clearInterval(entry.timer);
            entry.timer = null;
        }
    }
    return {
        register(config) {
            if (apis.has(config.name)) {
                log.warn('API already registered, replacing', { api: config.name });
                const existing = apis.get(config.name);
                stopProbing(existing);
            }
            const entry = {
                config: {
                    name: config.name,
                    url: config.url,
                    intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
                    timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
                    headers: config.headers,
                    degradedThreshold: config.degradedThreshold ?? DEFAULT_DEGRADED_THRESHOLD,
                    downThreshold: config.downThreshold ?? DEFAULT_DOWN_THRESHOLD,
                },
                state: 'healthy',
                lastCheck: null,
                lastSuccess: null,
                consecutiveFailures: 0,
                totalChecks: 0,
                totalFailures: 0,
                latencyMs: 0,
                latencySum: 0,
                backoffUntil: 0,
                backoffMultiplier: 1,
                timer: null,
            };
            apis.set(config.name, entry);
            log.info('Registered external API', {
                api: config.name,
                url: config.url,
                intervalMs: entry.config.intervalMs,
            });
            if (running) {
                startProbing(entry);
            }
        },
        unregister(name) {
            const entry = apis.get(name);
            if (entry) {
                stopProbing(entry);
                apis.delete(name);
                log.info('Unregistered external API', { api: name });
            }
        },
        start() {
            if (running)
                return;
            running = true;
            log.info('External monitor started', { apis: apis.size });
            for (const entry of apis.values()) {
                startProbing(entry);
            }
        },
        stop() {
            if (!running)
                return;
            running = false;
            for (const entry of apis.values()) {
                stopProbing(entry);
            }
            log.info('External monitor stopped', { apis: apis.size });
        },
        getStatus() {
            return Array.from(apis.values()).map(toStatus);
        },
        getApiStatus(name) {
            const entry = apis.get(name);
            return entry ? toStatus(entry) : undefined;
        },
        isRunning() {
            return running;
        },
    };
}
