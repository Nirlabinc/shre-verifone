import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';
const TIER_RANK = {
    leadership: 7,
    'c-suite': 6,
    council: 5,
    execution: 4,
    'child-company': 3,
    infrastructure: 2,
    public: 1,
    probationary: 0,
};
function findTrustedAgentsJson() {
    const candidates = [
        join(import.meta.dirname ?? __dirname, '../../shre-router/trusted-agents.json'),
        join(process.cwd(), 'trusted-agents.json'),
        join(process.cwd(), '../shre-router/trusted-agents.json'),
    ];
    for (const path of candidates) {
        if (existsSync(path))
            return path;
    }
    return null;
}
export function createTrustChain(config = {}) {
    const log = config.logger ?? createLogger('trust');
    const fallbackIds = config.fallbackAgents ?? ['main', 'shre'];
    const watchInterval = config.watchIntervalMs ?? 5000;
    const filePath = config.trustedAgentsPath ?? findTrustedAgentsJson();
    let agents = new Map();
    let watchActive = false;
    let lastManualReloadAt = 0;
    function load() {
        if (!filePath || !existsSync(filePath)) {
            log.warn('[trust] trusted-agents.json not found, using fallback set', { path: filePath });
            agents = new Map(fallbackIds.map((id) => [
                id,
                { id, tier: 'leadership', added: '2026-01-01' },
            ]));
            return;
        }
        try {
            const raw = JSON.parse(readFileSync(filePath, 'utf8'));
            const parsed = (raw.agents ?? []);
            agents = new Map(parsed.map((a) => [a.id, a]));
            log.info('[trust] Loaded trusted agents', { count: agents.size });
        }
        catch (err) {
            log.error('[trust] Failed to parse trusted-agents.json, keeping previous set', {}, err);
            if (agents.size === 0) {
                agents = new Map(fallbackIds.map((id) => [
                    id,
                    { id, tier: 'leadership', added: '2026-01-01' },
                ]));
            }
        }
    }
    load();
    if (!config.skipFileWatch && filePath && existsSync(filePath)) {
        watchFile(filePath, { interval: watchInterval }, () => {
            if (Date.now() - lastManualReloadAt < watchInterval) {
                log.debug('[trust] Skipping watcher reload — manual reload already handled it');
                return;
            }
            log.info('[trust] trusted-agents.json changed, reloading...');
            load();
        });
        watchActive = true;
    }
    let unsubscribe;
    if (config.subscribeFn) {
        unsubscribe = config.subscribeFn('trust.reloaded', () => {
            log.info('[trust] Received trust.reloaded event, reloading...');
            load();
        });
    }
    function isProbationExpired(agent) {
        if (agent.tier !== 'probationary')
            return false;
        if (!agent.probationExpires) {
            log.warn('[trust] Probationary agent missing probationExpires — treating as expired', {
                agentId: agent.id,
            });
            return true;
        }
        const expires = new Date(agent.probationExpires);
        if (isNaN(expires.getTime())) {
            log.error('[trust] Invalid probationExpires date', {
                agentId: agent.id,
                value: agent.probationExpires,
            });
            return true;
        }
        return expires < new Date();
    }
    function getProbationStatus(agentId) {
        const agent = agents.get(agentId);
        if (!agent || agent.tier !== 'probationary') {
            return { isProbationary: false, expired: false, daysRemaining: 0, expiresAt: null };
        }
        const expiresAt = agent.probationExpires ?? null;
        if (!expiresAt) {
            return { isProbationary: true, expired: true, daysRemaining: 0, expiresAt: null };
        }
        const expires = new Date(expiresAt);
        if (isNaN(expires.getTime())) {
            return { isProbationary: true, expired: true, daysRemaining: 0, expiresAt };
        }
        const now = new Date();
        const daysRemaining = Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
        return { isProbationary: true, expired: expires < now, daysRemaining, expiresAt };
    }
    function isTrusted(agentId) {
        const agent = agents.get(agentId);
        if (!agent)
            return false;
        if (isProbationExpired(agent))
            return false;
        return true;
    }
    function validateAgent(agentId, rejectUnknown = false) {
        if (!agentId)
            return 'main';
        const agent = agents.get(agentId);
        if (agent) {
            if (isProbationExpired(agent)) {
                log.warn(`[trust] Probationary agent expired: "${agentId}"`, {
                    probationExpires: agent.probationExpires,
                });
                config
                    .publishFn?.('security.probation_expired', 'warning', {
                    agentId,
                    probationExpires: agent.probationExpires,
                    timestamp: new Date().toISOString(),
                })
                    .catch(() => { });
                if (rejectUnknown) {
                    throw new Error(`PROBATION_EXPIRED: Agent "${agentId}" probation has expired`);
                }
                return 'main';
            }
            return agentId;
        }
        log.warn(`[trust] Untrusted agentId rejected: "${agentId}"`, { rejectUnknown });
        if (rejectUnknown) {
            throw new Error(`UNTRUSTED_AGENT: Agent "${agentId}" is not in the trusted registry`);
        }
        config
            .publishFn?.('security.untrusted_agent', 'warning', {
            agentId,
            timestamp: new Date().toISOString(),
        })
            .catch(() => { });
        return 'main';
    }
    function canDelegate(fromAgent, toAgent) {
        const from = agents.get(fromAgent);
        const to = agents.get(toAgent);
        if (!from || !to)
            return false;
        if (from.tier === 'probationary' || isProbationExpired(from))
            return false;
        return (TIER_RANK[from.tier] ?? 0) >= (TIER_RANK[to.tier] ?? 0);
    }
    function getAgent(agentId) {
        return agents.get(agentId);
    }
    function trustHeaders(agentId) {
        const agent = agents.get(agentId);
        const headers = {
            'x-shre-agent-id': agentId,
            'x-shre-agent-tier': agent?.tier ?? 'unknown',
            'x-shre-trust-validated': 'true',
        };
        if (agent?.tier === 'probationary') {
            const status = getProbationStatus(agentId);
            headers['x-shre-probation-status'] = status.expired ? 'expired' : 'active';
            if (status.expiresAt)
                headers['x-shre-probation-expires'] = status.expiresAt;
            headers['x-shre-probation-days-remaining'] = String(status.daysRemaining);
        }
        return headers;
    }
    function listTrusted() {
        return Array.from(agents.values())
            .filter((a) => !isProbationExpired(a))
            .map((a) => a.id);
    }
    function reload() {
        lastManualReloadAt = Date.now();
        load();
    }
    function dispose() {
        if (watchActive && filePath) {
            unwatchFile(filePath);
            watchActive = false;
        }
        unsubscribe?.();
    }
    return {
        isTrusted,
        validateAgent,
        canDelegate,
        getAgent,
        trustHeaders,
        listTrusted,
        get size() {
            return agents.size;
        },
        reload,
        dispose,
        getProbationStatus,
    };
}
export function requireTrustedAgent(trust) {
    return async (c, next) => {
        const agentIdRaw = c.req.header('x-shre-agent-id') ??
            (c.req.method === 'POST'
                ? (await c.req.json().catch(() => ({}))).agentId
                : undefined);
        const agentId = typeof agentIdRaw === 'string' ? agentIdRaw : undefined;
        try {
            const validated = trust.validateAgent(agentId, true);
            c.set('agentId', validated);
        }
        catch (err) {
            console.warn('[trust] Agent validation failed', { agentId, error: err.message });
            return c.json({ error: 'Untrusted agent', agentId }, 403);
        }
        await next();
    };
}
