import { createLogger } from './logger.js';
const MS_PER_HOUR = 3_600_000;
const DEFAULT_STRATEGY_MAP = {
    none: 'alert_only',
    watch: 'alert_only',
    warning: 'flush_cache',
    critical: 'restart_service',
};
class SelfHealingEngineImpl {
    log;
    maxPerHour;
    maxHistorySize;
    onRecover;
    publishFn;
    strategyMap;
    dependencyGraph = new Map();
    reverseDeps = new Map();
    activeFailures = new Map();
    history = [];
    budgetTracker = new Map();
    totalRecoveries = 0;
    successCount = 0;
    failCount = 0;
    constructor(serviceName, opts = {}) {
        this.log = createLogger(`${serviceName}:self-healing`);
        this.maxPerHour = opts.maxRecoveriesPerHour ?? 3;
        this.maxHistorySize = opts.maxHistorySize ?? 200;
        this.onRecover = opts.onRecover;
        this.publishFn = opts.publishFn;
        this.strategyMap = { ...DEFAULT_STRATEGY_MAP, ...opts.strategyOverrides };
        this.log.info('Self-healing engine initialized', {
            maxRecoveriesPerHour: this.maxPerHour,
            maxHistorySize: this.maxHistorySize,
        });
    }
    async evaluateAndAct(forecast) {
        const { blockId, severity, ensembleProbability } = forecast;
        if (severity !== 'warning' && severity !== 'critical') {
            if (this.activeFailures.has(blockId) && (severity === 'none' || severity === 'watch')) {
                this.clearFailure(blockId);
            }
            return null;
        }
        this.markFailing(blockId, severity);
        if (!this.hasBudget(blockId)) {
            this.log.warn('Recovery budget exhausted — suppressing action', {
                service: blockId,
                severity,
                maxPerHour: this.maxPerHour,
            });
            await this.publish('self-healing.budget-exhausted', 'warning', {
                service: blockId,
                severity,
                ensembleProbability,
            });
            return null;
        }
        const strategy = this.strategyMap[severity];
        const action = {
            service: blockId,
            strategy,
            reason: forecast.recommendedAction?.reason ??
                `${severity} degradation detected (P=${ensembleProbability})`,
            triggerSeverity: severity,
            ensembleProbability,
            decidedAt: new Date().toISOString(),
        };
        this.log.info('Initiating recovery action', {
            service: blockId,
            strategy,
            severity,
            ensembleProbability,
        });
        const startMs = Date.now();
        let success = true;
        let error;
        try {
            if (this.onRecover) {
                await this.onRecover(action);
            }
        }
        catch (err) {
            success = false;
            error = err instanceof Error ? err.message : String(err);
            this.log.error('Recovery action failed', {
                service: blockId,
                strategy,
                error,
            });
        }
        const record = {
            action,
            success,
            error,
            durationMs: Date.now() - startMs,
            completedAt: new Date().toISOString(),
        };
        this.recordRecovery(blockId, record);
        await this.publish(success ? 'self-healing.recovery-success' : 'self-healing.recovery-failed', success ? 'info' : 'warning', {
            service: blockId,
            strategy,
            severity,
            ensembleProbability,
            durationMs: record.durationMs,
            error,
        });
        return record;
    }
    registerDependency(service, dependsOn) {
        if (!this.dependencyGraph.has(service)) {
            this.dependencyGraph.set(service, new Set());
        }
        const deps = this.dependencyGraph.get(service);
        for (const dep of dependsOn) {
            deps.add(dep);
            if (!this.reverseDeps.has(dep)) {
                this.reverseDeps.set(dep, new Set());
            }
            this.reverseDeps.get(dep).add(service);
        }
        this.log.info('Dependencies registered', { service, dependsOn });
    }
    unregisterDependency(service) {
        const deps = this.dependencyGraph.get(service);
        if (deps) {
            for (const dep of deps) {
                this.reverseDeps.get(dep)?.delete(service);
            }
            this.dependencyGraph.delete(service);
        }
    }
    getCascadeAlerts() {
        const alerts = [];
        for (const [service, { severity, detectedAt }] of this.activeFailures) {
            const upstream = this.reverseDeps.get(service);
            if (upstream && upstream.size > 0) {
                alerts.push({
                    failedService: service,
                    severity,
                    affectedUpstream: Array.from(upstream),
                    detectedAt,
                });
            }
        }
        return alerts.sort((a, b) => {
            const severityOrder = {
                critical: 0,
                warning: 1,
                watch: 2,
                none: 3,
            };
            return severityOrder[a.severity] - severityOrder[b.severity];
        });
    }
    getRecoveryHistory(limit = 50) {
        const start = Math.max(0, this.history.length - limit);
        return this.history.slice(start);
    }
    getRecoveryBudget() {
        const now = Date.now();
        const result = {};
        for (const [service, timestamps] of this.budgetTracker) {
            const recent = timestamps.filter((t) => now - t < MS_PER_HOUR);
            result[service] = {
                used: recent.length,
                remaining: Math.max(0, this.maxPerHour - recent.length),
                max: this.maxPerHour,
            };
        }
        return result;
    }
    markFailing(service, severity) {
        const existing = this.activeFailures.get(service);
        if (!existing) {
            this.activeFailures.set(service, {
                severity,
                detectedAt: new Date().toISOString(),
            });
            this.log.warn('Service marked as failing', { service, severity });
        }
        else {
            existing.severity = severity;
        }
    }
    clearFailure(service) {
        if (this.activeFailures.delete(service)) {
            this.log.info('Service failure cleared', { service });
            this.publish('self-healing.failure-cleared', 'info', { service }).catch(() => { });
        }
    }
    stats() {
        return {
            totalRecoveries: this.totalRecoveries,
            successfulRecoveries: this.successCount,
            failedRecoveries: this.failCount,
            activeFailures: this.activeFailures.size,
            trackedDependencies: this.dependencyGraph.size,
        };
    }
    hasBudget(service) {
        const now = Date.now();
        let timestamps = this.budgetTracker.get(service);
        if (!timestamps) {
            timestamps = [];
            this.budgetTracker.set(service, timestamps);
        }
        const recent = timestamps.filter((t) => now - t < MS_PER_HOUR);
        this.budgetTracker.set(service, recent);
        return recent.length < this.maxPerHour;
    }
    recordRecovery(service, record) {
        let timestamps = this.budgetTracker.get(service);
        if (!timestamps) {
            timestamps = [];
            this.budgetTracker.set(service, timestamps);
        }
        timestamps.push(Date.now());
        this.history.push(record);
        if (this.history.length > this.maxHistorySize) {
            this.history.splice(0, this.history.length - this.maxHistorySize);
        }
        this.totalRecoveries++;
        if (record.success)
            this.successCount++;
        else
            this.failCount++;
    }
    async publish(event, severity, data) {
        if (this.publishFn) {
            await this.publishFn(event, severity, data).catch((err) => {
                this.log.warn('Failed to publish self-healing event', {
                    event,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }
    }
}
export function createSelfHealingEngine(serviceName, opts) {
    return new SelfHealingEngineImpl(serviceName, opts);
}
