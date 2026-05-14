import { createLogger } from './logger.js';
import { createPluginRegistry, } from './plugin.js';
import { createTrustChain } from './trust.js';
import { createAgentScope } from './agent-scope.js';
import { createCostClient } from './cost.js';
import { createHookRegistry } from './hooks.js';
import { createResilience } from './resilience.js';
const TIER_RANK = {
    leadership: 7,
    'c-suite': 6,
    council: 5,
    execution: 4,
    'child-company': 3,
    infrastructure: 2,
    public: 1,
};
export function createPluginBus(config) {
    const log = config.logger ?? createLogger(`plugin-bus:${config.service}`);
    const registry = config.registry ?? createPluginRegistry(config.registryConfig);
    const trust = config.trust ??
        createTrustChain({
            ...config.trustConfig,
            publishFn: config.publishFn,
        });
    const scope = config.scope ?? createAgentScope(config.scopeConfig);
    const cost = config.cost ??
        createCostClient({
            service: config.service,
            publishFn: config.publishFn,
            ...config.costConfig,
        });
    const hooks = config.hooks ?? createHookRegistry(config.hookConfig);
    const resilience = config.resilience ??
        createResilience({
            service: config.service,
            ...config.resilienceConfig,
        });
    const skipGates = new Set(config.skipGates ?? []);
    const beforeActivation = hooks.define('plugin:before');
    const afterActivation = hooks.define('plugin:after');
    function runTrustGate(plugin, agentId) {
        if (skipGates.has('trust'))
            return { result: 'skip' };
        if (!plugin.trust?.minTier)
            return { result: 'pass' };
        if (plugin.trust.allowedAgents?.includes(agentId))
            return { result: 'pass' };
        const agent = trust.getAgent(agentId);
        if (!agent) {
            return { result: 'fail', reason: `Agent "${agentId}" not in trusted registry` };
        }
        const requiredRank = TIER_RANK[plugin.trust.minTier] ?? 0;
        const agentRank = TIER_RANK[agent.tier] ?? 0;
        if (agentRank >= requiredRank)
            return { result: 'pass' };
        return {
            result: 'fail',
            reason: `Agent tier "${agent.tier}" (${agentRank}) < required "${plugin.trust.minTier}" (${requiredRank})`,
        };
    }
    async function runScopeGate(plugin, agentId, tenantId) {
        if (skipGates.has('scope'))
            return { result: 'skip' };
        if (!plugin.owns || plugin.owns.length === 0)
            return { result: 'pass' };
        try {
            const level = await scope.canAccess(agentId, tenantId, plugin.type, plugin.id);
            if (level !== 'none')
                return { result: 'pass' };
            return {
                result: 'fail',
                reason: `Agent "${agentId}" has no data access to "${plugin.type}:${plugin.id}"`,
            };
        }
        catch (err) {
            log.debug('[plugin-bus] Scope gate check failed, degrading', {
                error: err.message,
            });
            return { result: 'degraded', reason: 'Scope service unavailable' };
        }
    }
    async function runBudgetGate(plugin, _agentId) {
        if (skipGates.has('budget'))
            return { result: 'skip' };
        if (!plugin.cost?.budgetGroup)
            return { result: 'pass' };
        try {
            const budget = await cost.checkBudget(plugin.cost.budgetGroup);
            if (budget.action === 'block') {
                return { result: 'fail', budgetAction: 'block', reason: budget.reason };
            }
            return { result: 'pass', budgetAction: budget.action };
        }
        catch (err) {
            log.debug('[plugin-bus] Budget gate check failed, degrading', {
                error: err.message,
            });
            return { result: 'degraded', reason: 'Budget service unavailable' };
        }
    }
    function register(manifest) {
        registry.register(manifest);
    }
    function unregister(id) {
        return registry.unregister(id);
    }
    async function activate(pluginId, opts) {
        const agentId = opts.agentId;
        const tenantId = opts.tenantId ?? 'default';
        const resolved = registry.resolve(pluginId);
        const depsGate = resolved.ready ? 'pass' : 'fail';
        const trustGate = runTrustGate(resolved.plugin, agentId);
        const [scopeGate, budgetGate] = await Promise.all([
            runScopeGate(resolved.plugin, agentId, tenantId),
            runBudgetGate(resolved.plugin, agentId),
        ]);
        const reasons = [];
        if (trustGate.reason)
            reasons.push(trustGate.reason);
        if (scopeGate.reason)
            reasons.push(scopeGate.reason);
        if (budgetGate.reason)
            reasons.push(budgetGate.reason);
        if (!resolved.ready)
            reasons.push(`Missing deps: ${resolved.missing.join(', ')}`);
        const gates = {
            trust: trustGate.result,
            scope: scopeGate.result,
            budget: budgetGate.result,
            deps: depsGate,
            reasons,
        };
        const ready = gates.trust !== 'fail' &&
            gates.scope !== 'fail' &&
            gates.budget !== 'fail' &&
            gates.deps !== 'fail';
        const ctx = {
            plugin: resolved.plugin,
            dependencies: resolved.dependencies,
            agentId,
            tenantId,
            gates,
            ready,
            budgetAction: budgetGate.budgetAction,
            data: opts.data ?? {},
        };
        if (!ready) {
            log.warn('[plugin-bus] Activation blocked', {
                pluginId,
                agentId,
                gates,
                reasons,
            });
        }
        return ctx;
    }
    async function execute(pluginId, opts, fn) {
        const start = Date.now();
        let ctx = await activate(pluginId, opts);
        if (!ctx.ready) {
            throw new Error(`Plugin "${pluginId}" activation failed: ${ctx.gates.reasons.join('; ')}`);
        }
        ctx = await beforeActivation.run('before', ctx);
        for (const hookName of ctx.plugin.hooks?.before ?? []) {
            const point = hooks.get(hookName);
            if (point)
                ctx = await point.run('before', ctx);
        }
        const resilienceDefaults = ctx.plugin.type === 'agent'
            ? { maxRetries: 0, timeoutMs: 120_000 }
            : { maxRetries: 1, timeoutMs: 30_000 };
        const value = await resilience.wrap(`plugin:${pluginId}`, () => fn(ctx), resilienceDefaults);
        for (const hookName of ctx.plugin.hooks?.after ?? []) {
            const point = hooks.get(hookName);
            if (point)
                ctx = await point.run('after', ctx);
        }
        ctx = await afterActivation.run('after', ctx);
        const durationMs = Date.now() - start;
        const costMeta = value && typeof value === 'object' && '_cost' in value
            ? value._cost
            : {};
        if (ctx.plugin.cost?.budgetGroup) {
            cost.record({
                ts: new Date().toISOString(),
                agentId: ctx.agentId,
                model: costMeta.model ?? 'plugin-execution',
                taskType: ctx.plugin.type,
                promptTokens: costMeta.promptTokens ?? 0,
                completionTokens: costMeta.completionTokens ?? 0,
                costUsd: costMeta.costUsd ?? 0,
                localSavingsUsd: costMeta.localSavingsUsd ?? 0,
            });
        }
        config
            .publishFn?.('plugin.executed', 'info', {
            pluginId,
            type: ctx.plugin.type,
            agentId: ctx.agentId,
            tenantId: ctx.tenantId,
            durationMs,
            gates: ctx.gates,
        })
            .catch(() => { });
        return { value, context: ctx, durationMs };
    }
    function dispose() {
        trust.dispose();
    }
    return {
        register,
        unregister,
        activate,
        execute,
        get plugins() {
            return registry;
        },
        get hookRegistry() {
            return hooks;
        },
        get trustChain() {
            return trust;
        },
        dispose,
    };
}
