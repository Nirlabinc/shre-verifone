import { createLogger } from './logger.js';
import { createDiagnosticEngine } from './diagnostic-engine.js';
import { registerMLDiagnosticPatterns } from './ml-diagnostics.js';
import { createTaskLifecycle } from './task-lifecycle.js';
import { createHealActionRunner, createBuiltinHealActions, } from './heal-actions.js';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
function resolvePort(service) {
    try {
        const portsPath = join(process.cwd(), 'ports.json');
        const ports = JSON.parse(readFileSync(portsPath, 'utf-8'));
        return ports.services?.[service]?.port ?? 0;
    }
    catch {
        return 0;
    }
}
export function createPlatformResilience(opts) {
    const log = createLogger(`${opts.service}:resilience`);
    const port = opts.port ?? resolvePort(opts.service);
    const watchdogIntervalMs = opts.watchdogIntervalMs ?? 5 * 60 * 1000;
    const memoryThresholdMb = opts.memoryThresholdMb ?? 1024;
    const loopLagThresholdMs = opts.loopLagThresholdMs ?? 500;
    const diagnostics = createDiagnosticEngine();
    if (!opts.disable?.diagnostics) {
        registerMLDiagnosticPatterns(diagnostics);
    }
    const healActions = createHealActionRunner(opts.service, {
        publishFn: opts.publishFn
            ? (event, severity, data) => opts.publishFn(event, severity, data)
            : undefined,
        maxHealsPerHour: 10,
    });
    if (!opts.disable?.healActions) {
        try {
            const platform = {
                execSync: (cmd, o) => execSync(cmd, {
                    timeout: o?.timeout ?? 30_000,
                    encoding: 'utf-8',
                }),
                fetch: globalThis.fetch,
                portsJson: (() => {
                    try {
                        return JSON.parse(readFileSync(join(process.cwd(), 'ports.json'), 'utf-8'));
                    }
                    catch {
                        return { services: {} };
                    }
                })(),
            };
            for (const action of createBuiltinHealActions(platform)) {
                healActions.register(action);
            }
        }
        catch (e) {
            log.debug('[resilience] Could not register builtin heal actions', {
                error: e.message,
            });
        }
    }
    const tasksToken = opts.tasksToken || process.env.SHRE_TASKS_TOKEN || '';
    let taskLifecycle = null;
    if (!opts.disable?.taskLifecycle) {
        taskLifecycle = createTaskLifecycle({
            service: opts.service,
            token: tasksToken,
            defaultTtlMs: 24 * 60 * 60 * 1000,
            defaultPriority: 'high',
        });
    }
    let watchdogTimer = null;
    async function watchdogTick() {
        try {
            const issues = [];
            const memMB = Math.round(process.memoryUsage().rss / 1_048_576);
            if (memMB > memoryThresholdMb) {
                issues.push(`memory=${memMB}MB (threshold=${memoryThresholdMb}MB)`);
            }
            const lagStart = Date.now();
            await new Promise((r) => setTimeout(r, 0));
            const loopLag = Date.now() - lagStart;
            if (loopLag > loopLagThresholdMs) {
                issues.push(`eventLoopLag=${loopLag}ms (threshold=${loopLagThresholdMs}ms)`);
            }
            let healthy = true;
            if (port > 0) {
                try {
                    const res = await fetch(`http://127.0.0.1:${port}/health`, {
                        signal: AbortSignal.timeout(5_000),
                    });
                    healthy = res.ok;
                }
                catch {
                    healthy = false;
                    issues.push('health endpoint unreachable');
                }
            }
            const tag = `svc-degraded-${opts.service}`;
            if (issues.length === 0 && healthy) {
                await taskLifecycle?.resolveIssue(tag, `Healthy: mem=${memMB}MB, loopLag=${loopLag}ms`);
                return;
            }
            log.warn('[resilience] Service degradation detected', {
                service: opts.service,
                issues,
                memMB,
                loopLag,
                healthy,
            });
            if (opts.publishFn) {
                await opts
                    .publishFn('service.degraded', 'warning', {
                    service: opts.service,
                    issues,
                    ts: new Date().toISOString(),
                })
                    .catch(() => { });
            }
            const diagReport = diagnostics.diagnose({
                service: opts.service,
                recentLogs: [],
                healthState: {
                    status: healthy ? 'ok' : 'down',
                    uptime: process.uptime(),
                    memory: memMB,
                },
                dependencyHealth: {},
                recoveryHistory: [],
                knownPatterns: [],
                systemMetrics: {
                    memoryPct: memMB / memoryThresholdMb,
                    cpuPct: 0,
                    diskPct: 0,
                    loadAvg: 0,
                },
                upstreamDependents: opts.dependencies,
            });
            const issueDescription = [
                `Service ${opts.service} is degraded.`,
                `Issues: ${issues.join('; ')}`,
                `Diagnosis: ${diagReport.rootCauseHypothesis} (confidence: ${diagReport.confidence})`,
                `Suggested fix: ${diagReport.suggestedFix.description}`,
                diagReport.suggestedFix.steps.length > 0
                    ? `Steps:\n${diagReport.suggestedFix.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
                    : '',
            ]
                .filter(Boolean)
                .join('\n');
            await taskLifecycle?.createIssue({
                tag,
                title: `${opts.service} degraded: ${issues[0]}`,
                priority: !healthy ? 'critical' : 'high',
                description: issueDescription,
                category: 'health',
            });
            if (!opts.disable?.healActions) {
                try {
                    const healResult = await healActions.autoHeal(tag, {
                        service: opts.service,
                        launchLabel: `ai.shre.${opts.service.replace('shre-', '')}`,
                    });
                    if (healResult?.executed && healResult.success) {
                        log.info('[resilience] Auto-heal succeeded', {
                            action: healResult.actionId,
                            service: opts.service,
                        });
                        if (healResult.verified) {
                            await taskLifecycle?.resolveIssue(tag, `Auto-healed via ${healResult.actionId}`);
                        }
                    }
                }
                catch (e) {
                    log.debug('[resilience] Auto-heal attempt failed', { error: e.message });
                }
            }
        }
        catch (err) {
            log.debug('[resilience] Watchdog tick failed (non-fatal)', {
                error: err.message,
            });
        }
    }
    async function handleIncident(tag, context) {
        log.warn('[resilience] Manual incident triggered', { tag, ...context });
        await taskLifecycle?.createIssue({
            tag,
            title: `Incident: ${tag}`,
            priority: 'high',
            description: `Manual incident triggered. Context: ${JSON.stringify(context)}`,
            category: 'incident',
        });
        try {
            await healActions.autoHeal(tag, { service: opts.service, ...context });
        }
        catch {
        }
    }
    return {
        taskLifecycle,
        diagnostics,
        healActions,
        startWatchdog(intervalMs) {
            if (watchdogTimer)
                return;
            const interval = intervalMs ?? watchdogIntervalMs;
            log.info('[resilience] Watchdog started', { service: opts.service, intervalMs: interval });
            setTimeout(() => {
                watchdogTick().catch(() => { });
                watchdogTimer = setInterval(() => watchdogTick().catch(() => { }), interval);
                if (watchdogTimer && typeof watchdogTimer === 'object' && 'unref' in watchdogTimer) {
                    watchdogTimer.unref();
                }
            }, 60_000);
        },
        stopWatchdog() {
            if (watchdogTimer) {
                clearInterval(watchdogTimer);
                watchdogTimer = null;
            }
        },
        handleIncident,
        shutdown() {
            this.stopWatchdog();
            log.info('[resilience] Platform resilience shut down', { service: opts.service });
        },
    };
}
