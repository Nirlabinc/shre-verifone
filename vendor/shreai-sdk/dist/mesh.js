import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createLogger } from './logger.js';
const log = createLogger('shre-sdk/mesh');
let _topology = null;
function findProjectRoot() {
    const cwd = process.cwd();
    const candidates = [cwd, resolve(cwd, '..'), resolve(cwd, '../..'), resolve(cwd, '../../..')];
    for (const dir of candidates) {
        try {
            readFileSync(join(dir, 'mesh.json'), 'utf-8');
            return dir;
        }
        catch {
        }
    }
    return resolve(new URL(import.meta.url).pathname, '../../..');
}
function loadTopology() {
    if (_topology)
        return _topology;
    const root = findProjectRoot();
    const meshPath = join(root, 'mesh.json');
    let raw;
    try {
        raw = JSON.parse(readFileSync(meshPath, 'utf-8'));
    }
    catch (err) {
        log.error('Failed to load mesh.json', { meshPath }, err);
        return {
            tailnet: { suffix: '', account: '' },
            nodes: [],
            failover: {
                strategy: 'graceful-degradation',
                detection: { method: 'heartbeat', intervalMs: 30000, missThreshold: 3, deadThreshold: 6 },
            },
        };
    }
    const tailnetRaw = raw['_tailnet'];
    const nodesRaw = raw['nodes'];
    const failoverRaw = raw['failover'];
    const nodes = Object.entries(nodesRaw).map(([id, n]) => ({
        id,
        hostname: String(n['hostname'] ?? ''),
        tailscaleIp: n['tailscaleIp'] ?? null,
        magicDns: n['magicDns'] ?? null,
        hardware: String(n['hardware'] ?? ''),
        os: String(n['os'] ?? ''),
        role: String(n['role'] ?? 'unknown'),
        description: String(n['description'] ?? ''),
        services: n['services'] ?? [],
        priority: String(n['priority'] ?? 'P4'),
        keepAlive: Boolean(n['keepAlive'] ?? false),
        statusNote: n['_status'] ? String(n['_status']) : undefined,
    }));
    _topology = {
        tailnet: { suffix: tailnetRaw?.suffix ?? '', account: tailnetRaw?.account ?? '' },
        nodes,
        failover: failoverRaw,
    };
    log.debug('Mesh topology loaded', { nodeCount: nodes.length, tailnet: _topology.tailnet.suffix });
    return _topology;
}
export function reloadMesh() {
    _topology = null;
    return loadTopology();
}
export function getMeshNodes() {
    return loadTopology().nodes;
}
export function getMeshTopology() {
    return loadTopology();
}
const _healthCache = new Map();
const HEALTH_CACHE_TTL_MS = 60_000;
export function updateNodeHealth(nodeId, healthy, latencyMs = 0) {
    _healthCache.set(nodeId, { healthy, lastChecked: Date.now(), latencyMs });
}
export function feedHealthFromHeartbeat(depStatuses) {
    const topology = loadTopology();
    for (const [depName, status] of Object.entries(depStatuses)) {
        for (const node of topology.nodes) {
            if (node.id === depName || node.services.includes(depName) || node.hostname === depName) {
                updateNodeHealth(node.id, status.reachable, status.latencyMs ?? 0);
                break;
            }
        }
    }
}
export function getNodeHealth(nodeId) {
    return _healthCache.get(nodeId);
}
export function isNodeHealthy(nodeId) {
    const entry = _healthCache.get(nodeId);
    if (!entry)
        return true;
    if (Date.now() - entry.lastChecked > HEALTH_CACHE_TTL_MS)
        return true;
    return entry.healthy;
}
export function resolveServiceHost(serviceName) {
    const topology = loadTopology();
    const candidates = [];
    for (const node of topology.nodes) {
        if (node.services.includes(serviceName)) {
            candidates.push(node);
        }
    }
    if (candidates.length === 0) {
        log.debug('Service not found in mesh — falling back to 127.0.0.1', { serviceName });
        return '127.0.0.1';
    }
    candidates.sort((a, b) => {
        const aHealth = _healthCache.get(a.id);
        const bHealth = _healthCache.get(b.id);
        const aFresh = aHealth && Date.now() - aHealth.lastChecked < HEALTH_CACHE_TTL_MS;
        const bFresh = bHealth && Date.now() - bHealth.lastChecked < HEALTH_CACHE_TTL_MS;
        const aScore = !aFresh ? 1 : aHealth.healthy ? 2 : 0;
        const bScore = !bFresh ? 1 : bHealth.healthy ? 2 : 0;
        if (aScore !== bScore)
            return bScore - aScore;
        return (aHealth?.latencyMs ?? 999) - (bHealth?.latencyMs ?? 999);
    });
    for (const node of candidates) {
        if (node.role === 'brain')
            return '127.0.0.1';
        const health = _healthCache.get(node.id);
        if (health && !health.healthy && Date.now() - health.lastChecked < HEALTH_CACHE_TTL_MS) {
            log.debug('Skipping unhealthy node for service', {
                serviceName,
                nodeId: node.id,
                lastChecked: new Date(health.lastChecked).toISOString(),
            });
            continue;
        }
        if (!node.tailscaleIp) {
            log.warn('Node for service has no Tailscale IP — falling back to 127.0.0.1', {
                serviceName,
                nodeId: node.id,
                statusNote: node.statusNote,
            });
            return '127.0.0.1';
        }
        return node.tailscaleIp;
    }
    log.warn('All mesh nodes unhealthy for service — falling back to 127.0.0.1', {
        serviceName,
        candidates: candidates.map((c) => c.id),
    });
    return '127.0.0.1';
}
export async function resolveServiceHostAsync(serviceName, probeTimeoutMs = 3_000) {
    const topology = loadTopology();
    const candidates = topology.nodes.filter((n) => n.services.includes(serviceName));
    for (const node of candidates) {
        if (node.role === 'brain')
            continue;
        const entry = _healthCache.get(node.id);
        if (entry && Date.now() - entry.lastChecked < HEALTH_CACHE_TTL_MS)
            continue;
        if (!node.tailscaleIp)
            continue;
        try {
            const start = Date.now();
            const res = await fetch(`http://${node.tailscaleIp}:5485/health`, {
                signal: AbortSignal.timeout(probeTimeoutMs),
            });
            updateNodeHealth(node.id, res.ok, Date.now() - start);
        }
        catch {
            updateNodeHealth(node.id, false, 0);
        }
    }
    return resolveServiceHost(serviceName);
}
export function getNodeByRole(role) {
    return loadTopology().nodes.find((n) => n.role === role);
}
export async function getMeshHealth() {
    const topology = loadTopology();
    const HEALTH_PORT = 5485;
    const TIMEOUT_MS = 5_000;
    const probes = topology.nodes.map(async (node) => {
        const checkedAt = new Date().toISOString();
        const ip = node.role === 'brain' ? '127.0.0.1' : node.tailscaleIp;
        if (!ip) {
            return {
                nodeId: node.id,
                hostname: node.hostname,
                role: node.role,
                tailscaleIp: node.tailscaleIp,
                reachable: false,
                httpStatus: null,
                latencyMs: null,
                checkedAt,
            };
        }
        const url = `http://${ip}:${HEALTH_PORT}/health`;
        const start = Date.now();
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            return {
                nodeId: node.id,
                hostname: node.hostname,
                role: node.role,
                tailscaleIp: node.tailscaleIp,
                reachable: res.ok,
                httpStatus: res.status,
                latencyMs: Date.now() - start,
                checkedAt,
            };
        }
        catch (err) {
            log.debug('Mesh health probe failed', { nodeId: node.id, ip, err: String(err) });
            return {
                nodeId: node.id,
                hostname: node.hostname,
                role: node.role,
                tailscaleIp: node.tailscaleIp,
                reachable: false,
                httpStatus: null,
                latencyMs: null,
                checkedAt,
            };
        }
    });
    return Promise.all(probes);
}
