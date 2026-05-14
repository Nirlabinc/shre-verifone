import { createLogger } from './logger.js';
import { feedHealthFromHeartbeat } from './mesh.js';
const log = createLogger('shre-sdk/heartbeat');
export function createHeartbeatMonitor(serviceName, opts = {}) {
    const intervalMs = opts.intervalMs ?? 30_000;
    const dependencies = new Map();
    let timer = null;
    const startedAt = Date.now();
    let lastSignal = null;
    const BASE_PROBE_INTERVAL = intervalMs;
    const MAX_PROBE_BACKOFF = 5 * 60 * 1000;
    const lastPublished = new Map();
    function shouldPublishEvent(key) {
        const last = lastPublished.get(key) ?? 0;
        if (Date.now() - last < 300_000)
            return false;
        lastPublished.set(key, Date.now());
        return true;
    }
    async function probeRedis(url) {
        const { createConnection } = await import('node:net');
        const parsed = new URL(url);
        const host = parsed.hostname || '127.0.0.1';
        const port = parseInt(parsed.port || '6379', 10);
        const password = parsed.password || process.env.REDIS_PASSWORD || '';
        return new Promise((resolve) => {
            const sock = createConnection({ host, port }, () => {
                let buf = '';
                sock.on('data', (d) => {
                    buf += d.toString();
                    if (buf.includes('+PONG')) {
                        sock.destroy();
                        resolve(true);
                    }
                    else if (buf.includes('-NOAUTH') || buf.includes('+OK')) {
                        if (buf.includes('+OK') && !buf.includes('+PONG')) {
                            sock.write('PING\r\n');
                        }
                        else if (password) {
                            sock.write(`AUTH ${password}\r\n`);
                        }
                        else {
                            sock.destroy();
                            resolve(false);
                        }
                    }
                });
                if (password)
                    sock.write(`AUTH ${password}\r\nPING\r\n`);
                else
                    sock.write('PING\r\n');
            });
            sock.on('error', () => {
                resolve(false);
            });
            sock.setTimeout(5_000, () => {
                sock.destroy();
                resolve(false);
            });
        });
    }
    async function probeDependency(name, url) {
        const start = Date.now();
        const existing = dependencies.get(name)?.status;
        const isRedis = name === 'redis' ||
            url.startsWith('redis://') ||
            (/:\d+\/?$/.test(url) && (url.includes(':6379') || url.includes(':6380')));
        if (isRedis) {
            try {
                const alive = await probeRedis(url.replace(/^http:\/\//, 'redis://'));
                const latencyMs = Date.now() - start;
                return alive
                    ? {
                        name,
                        status: 'alive',
                        lastSeen: new Date().toISOString(),
                        latencyMs,
                        consecutiveFailures: 0,
                    }
                    : {
                        name,
                        status: 'degraded',
                        lastSeen: existing?.lastSeen ?? 'never',
                        latencyMs,
                        consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
                    };
            }
            catch (err) {
                const failures = (existing?.consecutiveFailures ?? 0) + 1;
                return {
                    name,
                    status: failures >= 3 ? 'dead' : 'unresponsive',
                    lastSeen: existing?.lastSeen ?? 'never',
                    latencyMs: Date.now() - start,
                    consecutiveFailures: failures,
                };
            }
        }
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
            const latencyMs = Date.now() - start;
            return {
                name,
                status: res.ok ? 'alive' : 'degraded',
                lastSeen: new Date().toISOString(),
                latencyMs,
                consecutiveFailures: 0,
            };
        }
        catch (err) {
            log.debug('[heartbeat] Dependency health check failed', {
                name,
                error: err.message,
            });
            const failures = (existing?.consecutiveFailures ?? 0) + 1;
            return {
                name,
                status: failures >= 3 ? 'dead' : 'unresponsive',
                lastSeen: existing?.lastSeen ?? 'never',
                latencyMs: Date.now() - start,
                consecutiveFailures: failures,
            };
        }
    }
    async function tick() {
        const now = Date.now();
        const depEntries = Array.from(dependencies.entries());
        const probeResults = await Promise.all(depEntries.map(async ([name, dep]) => {
            if (now - dep.lastProbeTime < dep.currentIntervalMs) {
                return [name, dep.status];
            }
            const result = await probeDependency(name, dep.url);
            const failures = result.consecutiveFailures;
            const newInterval = failures > 0
                ? Math.min(BASE_PROBE_INTERVAL * Math.pow(2, failures), MAX_PROBE_BACKOFF)
                : BASE_PROBE_INTERVAL;
            dependencies.set(name, {
                url: dep.url,
                status: result,
                currentIntervalMs: newInterval,
                lastProbeTime: now,
            });
            return [name, result];
        }));
        const depStatuses = {};
        let hasDeadDeps = false;
        for (const [name, result] of probeResults) {
            depStatuses[name] = result;
            if (result.status === 'dead')
                hasDeadDeps = true;
        }
        if (Object.keys(depStatuses).length > 0) {
            try {
                feedHealthFromHeartbeat(Object.fromEntries(Object.entries(depStatuses).map(([name, dep]) => [
                    name,
                    { reachable: dep.status === 'alive', latencyMs: dep.latencyMs ?? 0 },
                ])));
            }
            catch {
            }
        }
        const signal = {
            service: serviceName,
            status: hasDeadDeps ? 'degraded' : 'alive',
            ts: new Date().toISOString(),
            uptimeMs: Date.now() - startedAt,
            memMB: Math.round(process.memoryUsage().rss / 1_048_576),
            consecutiveFailures: 0,
            dependencies: Object.keys(depStatuses).length > 0 ? depStatuses : undefined,
        };
        lastSignal = signal;
        opts.onHeartbeat?.(signal);
        if (opts.publishFn) {
            const eventKey = hasDeadDeps ? `degraded-${serviceName}` : `alive-${serviceName}`;
            if (!hasDeadDeps || shouldPublishEvent(eventKey)) {
                opts
                    .publishFn('heartbeat.service', 'info', signal)
                    .catch(() => { });
            }
        }
    }
    return {
        start() {
            if (timer)
                return;
            log.info('Heartbeat monitor started', { service: serviceName, intervalMs });
            setTimeout(() => tick().catch((e) => log.warn('Heartbeat tick failed', { error: String(e) })), 1_000);
            timer = setInterval(() => tick().catch((e) => log.warn('Heartbeat tick failed', { error: String(e) })), intervalMs);
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
                log.info('Heartbeat monitor stopped', { service: serviceName });
            }
        },
        registerDependency(name, healthUrl) {
            dependencies.set(name, {
                url: healthUrl,
                status: {
                    name,
                    status: 'alive',
                    lastSeen: 'pending',
                    latencyMs: 0,
                    consecutiveFailures: 0,
                },
                currentIntervalMs: BASE_PROBE_INTERVAL,
                lastProbeTime: 0,
            });
        },
        unregisterDependency(name) {
            dependencies.delete(name);
        },
        getStatus() {
            return (lastSignal ?? {
                service: serviceName,
                status: 'alive',
                ts: new Date().toISOString(),
                uptimeMs: Date.now() - startedAt,
                memMB: Math.round(process.memoryUsage().rss / 1_048_576),
                consecutiveFailures: 0,
            });
        },
        getDependencyGraph() {
            const result = {};
            Array.from(dependencies.entries()).forEach(([name, { status }]) => {
                result[name] = status;
            });
            return result;
        },
        isRunning: () => timer !== null,
    };
}
export function createAgentLivenessTracker(opts = {}) {
    const expectedIntervalMs = opts.expectedIntervalMs ?? 15_000;
    const missThreshold = opts.missThreshold ?? 4;
    const deadThreshold = opts.deadThreshold ?? 8;
    const agents = new Map();
    let checkerTimer = null;
    function check() {
        const now = Date.now();
        const results = [];
        for (const [agentId, agent] of Array.from(agents.entries())) {
            const elapsed = now - agent.lastPing;
            const missedIntervals = Math.floor(elapsed / expectedIntervalMs);
            if (missedIntervals > 0) {
                agent.consecutiveMisses = missedIntervals;
            }
            let status = 'active';
            if (agent.consecutiveMisses >= deadThreshold) {
                status = 'dead';
                if (!agent.wasStuck || agent.consecutiveMisses === deadThreshold) {
                    opts.onDead?.(agentId, agent.taskId, agent.consecutiveMisses);
                    opts
                        .publishFn?.('heartbeat.agent.dead', 'critical', {
                        agentId,
                        taskId: agent.taskId,
                        pid: agent.pid,
                        missedCount: agent.consecutiveMisses,
                        lastPing: new Date(agent.lastPing).toISOString(),
                    })
                        .catch(() => { });
                }
            }
            else if (agent.consecutiveMisses >= missThreshold) {
                status = 'stuck';
                if (!agent.wasStuck) {
                    agent.wasStuck = true;
                    opts.onStuck?.(agentId, agent.taskId, agent.consecutiveMisses);
                    opts
                        .publishFn?.('heartbeat.agent.stuck', 'warning', {
                        agentId,
                        taskId: agent.taskId,
                        pid: agent.pid,
                        missedCount: agent.consecutiveMisses,
                        lastPing: new Date(agent.lastPing).toISOString(),
                    })
                        .catch(() => { });
                }
            }
            else if (agent.consecutiveMisses === 0) {
                status = 'active';
                if (agent.wasStuck) {
                    agent.wasStuck = false;
                    opts.onRecovered?.(agentId, agent.taskId);
                    opts
                        .publishFn?.('heartbeat.agent.recovered', 'info', {
                        agentId,
                        taskId: agent.taskId,
                    })
                        .catch(() => { });
                }
            }
            else {
                status = 'idle';
            }
            results.push({
                agentId,
                taskId: agent.taskId,
                status,
                lastPing: new Date(agent.lastPing).toISOString(),
                progressPct: agent.progressPct,
                memMB: agent.memMB,
                consecutiveMisses: agent.consecutiveMisses,
            });
        }
        return results;
    }
    return {
        register(agentId, taskId, pid) {
            const now = Date.now();
            agents.set(agentId, {
                agentId,
                taskId,
                pid,
                registeredAt: now,
                lastPing: now,
                consecutiveMisses: 0,
                wasStuck: false,
            });
            log.info('Agent registered for liveness tracking', { agentId, taskId, pid });
        },
        ping(agentId, meta) {
            const agent = agents.get(agentId);
            if (!agent)
                return;
            agent.lastPing = Date.now();
            agent.consecutiveMisses = 0;
            if (meta?.progressPct !== undefined)
                agent.progressPct = meta.progressPct;
            if (meta?.memMB !== undefined)
                agent.memMB = meta.memMB;
        },
        unregister(agentId) {
            agents.delete(agentId);
        },
        check,
        get(agentId) {
            const agent = agents.get(agentId);
            if (!agent)
                return null;
            const elapsed = Date.now() - agent.lastPing;
            const missedIntervals = Math.floor(elapsed / expectedIntervalMs);
            let status = 'active';
            if (missedIntervals >= deadThreshold)
                status = 'dead';
            else if (missedIntervals >= missThreshold)
                status = 'stuck';
            else if (missedIntervals > 0)
                status = 'idle';
            return {
                agentId,
                taskId: agent.taskId,
                status,
                lastPing: new Date(agent.lastPing).toISOString(),
                progressPct: agent.progressPct,
                memMB: agent.memMB,
                consecutiveMisses: missedIntervals,
            };
        },
        getAll() {
            return check();
        },
        startChecker(intervalMs = expectedIntervalMs) {
            if (checkerTimer)
                return;
            checkerTimer = setInterval(() => check(), intervalMs);
            log.info('Agent liveness checker started', { intervalMs });
        },
        stopChecker() {
            if (checkerTimer) {
                clearInterval(checkerTimer);
                checkerTimer = null;
            }
        },
    };
}
export function createConsumerTracker(opts = {}) {
    const expectedIntervalMs = opts.expectedIntervalMs ?? 30_000;
    const consumers = new Map();
    let checkerTimer = null;
    function check() {
        const now = Date.now();
        const results = [];
        const dead = [];
        for (const [id, consumer] of Array.from(consumers.entries())) {
            const elapsed = now - consumer.lastPing;
            const missedIntervals = Math.floor(elapsed / expectedIntervalMs);
            let status = 'alive';
            if (missedIntervals >= 6) {
                status = 'dead';
                dead.push(id);
            }
            else if (missedIntervals >= 3) {
                status = 'unresponsive';
            }
            else if (consumer.pendingCount > 1000) {
                status = 'degraded';
            }
            const result = {
                consumerId: consumer.consumerId,
                service: consumer.service,
                stream: consumer.stream,
                lastAck: new Date(consumer.lastPing).toISOString(),
                pendingCount: consumer.pendingCount,
                status,
            };
            results.push(result);
            if (status === 'dead') {
                opts.onDeadConsumer?.(result);
                opts
                    .publishFn?.('heartbeat.consumer.dead', 'critical', {
                    consumerId: consumer.consumerId,
                    service: consumer.service,
                    stream: consumer.stream,
                    lastAck: new Date(consumer.lastPing).toISOString(),
                    pendingCount: consumer.pendingCount,
                })
                    .catch(() => { });
            }
        }
        for (const id of dead) {
            const consumer = consumers.get(id);
            if (consumer && Date.now() - consumer.lastPing > 10 * 60 * 1000) {
                consumers.delete(id);
            }
        }
        return results;
    }
    return {
        ping(consumerId, service, stream, pendingCount = 0) {
            consumers.set(consumerId, {
                consumerId,
                service,
                stream,
                lastPing: Date.now(),
                pendingCount,
            });
        },
        check,
        getAll: check,
        startChecker(intervalMs = expectedIntervalMs) {
            if (checkerTimer)
                return;
            checkerTimer = setInterval(() => check(), intervalMs);
        },
        stopChecker() {
            if (checkerTimer) {
                clearInterval(checkerTimer);
                checkerTimer = null;
            }
        },
    };
}
export async function probeEndpoint(url, timeoutMs = 5_000) {
    const start = Date.now();
    const target = url;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return {
            target,
            reachable: res.ok,
            latencyMs: Date.now() - start,
            ts: new Date().toISOString(),
        };
    }
    catch (err) {
        return {
            target,
            reachable: false,
            latencyMs: Date.now() - start,
            ts: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
export async function probeOllama(host = 'http://127.0.0.1:11434', timeoutMs = 5_000) {
    const start = Date.now();
    try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
            return {
                target: host,
                reachable: false,
                latencyMs: Date.now() - start,
                ts: new Date().toISOString(),
                error: `HTTP ${res.status}`,
            };
        }
        const data = (await res.json());
        const models = data.models?.map((m) => m.name) ?? [];
        return {
            target: host,
            reachable: true,
            latencyMs: Date.now() - start,
            ts: new Date().toISOString(),
            models,
        };
    }
    catch (err) {
        return {
            target: host,
            reachable: false,
            latencyMs: Date.now() - start,
            ts: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
export async function probeLegacyGateway(_host = 'http://127.0.0.1:18789', _timeoutMs = 5_000) {
    return {
        target: _host,
        reachable: false,
        latencyMs: 0,
        ts: new Date().toISOString(),
        error: 'Legacy gateway removed — probe is a no-op stub',
    };
}
export const probeOpenClaw = probeLegacyGateway;
export async function probeTunnel(externalUrl, timeoutMs = 10_000) {
    return probeEndpoint(externalUrl, timeoutMs);
}
export async function probeShadowPC(host = 'http://100.86.194.36:11434', timeoutMs = 10_000) {
    return probeEndpoint(`${host}/api/tags`, timeoutMs);
}
export function createInfraHeartbeat(opts = {}) {
    const intervalMs = opts.intervalMs ?? 30_000;
    const targets = opts.targets ?? ['ollama'];
    const latest = new Map();
    let timer = null;
    async function probe() {
        const probes = [];
        if (targets.includes('ollama')) {
            probes.push(probeOllama().then((r) => ['ollama', r]));
        }
        if (targets.includes('shre-router')) {
            probes.push(probeEndpoint('http://127.0.0.1:5497/health').then((r) => ['shre-router', r]));
        }
        if (targets.includes('tunnel') && opts.tunnelUrl) {
            probes.push(probeTunnel(opts.tunnelUrl).then((r) => ['tunnel', r]));
        }
        if (targets.includes('shadowpc')) {
            probes.push(probeShadowPC().then((r) => ['shadowpc', r]));
        }
        const results = await Promise.all(probes);
        const allResults = [];
        for (const [name, result] of results) {
            latest.set(name, result);
            allResults.push(result);
            if (!result.reachable && opts.publishFn) {
                opts
                    .publishFn('heartbeat.infra.down', 'warning', {
                    ...result,
                    infraName: name,
                })
                    .catch(() => { });
            }
        }
        opts.onProbe?.(allResults);
        const out = {};
        Array.from(latest.entries()).forEach(([name, result]) => {
            out[name] = result;
        });
        return out;
    }
    return {
        start() {
            if (timer)
                return;
            setTimeout(() => probe().catch(() => { }), 2_000);
            timer = setInterval(() => probe().catch(() => { }), intervalMs);
            log.info('Infra heartbeat started', { targets, intervalMs });
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
        getLatest() {
            const out = {};
            Array.from(latest.entries()).forEach(([name, result]) => {
                out[name] = result;
            });
            return out;
        },
        probeNow: probe,
    };
}
