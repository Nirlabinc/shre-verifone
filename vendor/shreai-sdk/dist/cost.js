import { createLogger } from './logger.js';
import { serviceUrl } from './discovery.js';
export function createCostClient(config) {
    const log = config.logger ?? createLogger(config.service);
    const timeout = config.timeoutMs ?? 5000;
    const budgetCacheTtl = config.budgetCacheTtlMs ?? 30_000;
    const budgetCache = new Map();
    function getMeterUrl() {
        if (config.meterUrl)
            return config.meterUrl;
        try {
            return serviceUrl('shre-meter');
        }
        catch (err) {
            log.debug('[cost] Meter URL discovery failed, using default', {
                error: err.message,
            });
            return 'https://127.0.0.1:5495';
        }
    }
    function getRouterUrl() {
        if (config.routerUrl)
            return config.routerUrl;
        try {
            return serviceUrl('shre-router');
        }
        catch (err) {
            log.debug('[cost] Router URL discovery failed, using default', {
                error: err.message,
            });
            return 'https://127.0.0.1:5497';
        }
    }
    function record(event) {
        const ts = event.ts || new Date().toISOString();
        const record = { ...event, ts, source: config.service };
        config
            .publishFn?.('cost.recorded', 'info', record)
            .catch(() => { });
        fetch(`${getMeterUrl()}/v1/costs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(record),
            signal: AbortSignal.timeout(timeout),
        }).catch((err) => {
            log.warn('[cost] Failed to POST to shre-meter', { error: err.message });
        });
    }
    async function checkBudget(agentId) {
        const cached = budgetCache.get(agentId);
        if (cached && Date.now() < cached.expiresAt)
            return cached.check;
        try {
            const resp = await fetch(`${getRouterUrl()}/v1/budgets/${encodeURIComponent(agentId)}`, {
                signal: AbortSignal.timeout(timeout),
            });
            if (resp.ok) {
                const data = (await resp.json());
                budgetCache.set(agentId, { check: data, expiresAt: Date.now() + budgetCacheTtl });
                return data;
            }
            if (resp.status === 404) {
                const allow = {
                    action: 'allow',
                    reason: 'No budget configured',
                    dailySpentUsd: 0,
                    dailyLimitUsd: Infinity,
                    dailyPct: 0,
                    weeklySpentUsd: 0,
                    weeklyLimitUsd: Infinity,
                    weeklyPct: 0,
                };
                budgetCache.set(agentId, { check: allow, expiresAt: Date.now() + budgetCacheTtl });
                return allow;
            }
        }
        catch (err) {
            log.warn('[cost] Budget check failed, defaulting to allow', {
                agentId,
                error: err.message,
            });
        }
        return {
            action: 'allow',
            reason: 'Budget service unavailable — fail open',
            dailySpentUsd: 0,
            dailyLimitUsd: Infinity,
            dailyPct: 0,
            weeklySpentUsd: 0,
            weeklyLimitUsd: Infinity,
            weeklyPct: 0,
        };
    }
    async function canProceed(agentId) {
        const budget = await checkBudget(agentId);
        return budget.action !== 'block';
    }
    return { record, checkBudget, canProceed };
}
