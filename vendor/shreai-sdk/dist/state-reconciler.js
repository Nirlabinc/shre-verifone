import { randomUUID } from 'node:crypto';
const PRIORITY_SCORES = {
    P0: 0,
    P1: 10,
    P2: 20,
    P3: 30,
    P4: 40,
};
function priorityScore(priority) {
    return PRIORITY_SCORES[priority] ?? 50;
}
export function createStateReconciler(options) {
    let desiredState = options.desiredState;
    let reconciliations = 0;
    let totalActions = 0;
    let autoExecuted = 0;
    function detectDrift(actual) {
        const drifts = [];
        for (const [name, desired] of Object.entries(desiredState.services)) {
            if (!desired.enabled)
                continue;
            const svc = actual.services[name];
            if (!svc) {
                drifts.push({
                    service: name,
                    driftType: 'not_running',
                    severity: desired.priority === 'P0' ? 'critical' : desired.priority === 'P1' ? 'warning' : 'info',
                    desired,
                    actual: {},
                    message: `${name} is not running (expected by desired state)`,
                });
                continue;
            }
            if (!svc.running) {
                drifts.push({
                    service: name,
                    driftType: 'not_running',
                    severity: desired.priority === 'P0' ? 'critical' : desired.priority === 'P1' ? 'warning' : 'info',
                    desired,
                    actual: svc,
                    message: `${name} is not running (PID not found)`,
                });
                continue;
            }
            const maxRestarts = desired.maxRestarts ?? 5;
            if (svc.recentRestarts >= maxRestarts) {
                drifts.push({
                    service: name,
                    driftType: 'crash_loop',
                    severity: 'critical',
                    desired,
                    actual: svc,
                    message: `${name} in crash loop: ${svc.recentRestarts} restarts in the last hour (max: ${maxRestarts})`,
                });
                continue;
            }
            if (!svc.healthy) {
                const depDown = (desired.dependencies || []).find((dep) => {
                    const depState = actual.services[dep];
                    return !depState || !depState.running || !depState.healthy;
                });
                if (depDown) {
                    drifts.push({
                        service: name,
                        driftType: 'dependency_down',
                        severity: 'warning',
                        desired,
                        actual: svc,
                        message: `${name} unhealthy because dependency ${depDown} is down`,
                    });
                }
                else {
                    drifts.push({
                        service: name,
                        driftType: 'unhealthy',
                        severity: desired.priority === 'P0' ? 'critical' : 'warning',
                        desired,
                        actual: svc,
                        message: `${name} is running but failing health checks (${svc.consecutiveFailures} consecutive failures)`,
                    });
                }
                continue;
            }
            if (desired.resources) {
                if (desired.resources.maxMemoryMb &&
                    svc.memoryMb &&
                    svc.memoryMb > desired.resources.maxMemoryMb) {
                    drifts.push({
                        service: name,
                        driftType: 'resource_exceeded',
                        severity: 'warning',
                        desired,
                        actual: svc,
                        message: `${name} memory ${svc.memoryMb}MB exceeds limit ${desired.resources.maxMemoryMb}MB`,
                    });
                }
            }
        }
        for (const [name, svc] of Object.entries(actual.services)) {
            const desired = desiredState.services[name];
            if (desired && !desired.enabled && svc.running) {
                drifts.push({
                    service: name,
                    driftType: 'should_not_run',
                    severity: 'info',
                    desired: desired || {},
                    actual: svc,
                    message: `${name} is running but disabled in desired state`,
                });
            }
        }
        return drifts;
    }
    function driftToAction(drift) {
        const basePriority = priorityScore(drift.desired.priority || 'P3');
        const diagnostic = options.getDiagnostic?.(drift.service);
        switch (drift.driftType) {
            case 'not_running':
                return {
                    actionId: randomUUID(),
                    service: drift.service,
                    type: 'start',
                    reason: drift.message,
                    priority: basePriority,
                    autoExecute: drift.severity === 'critical' || drift.severity === 'warning',
                    blockedBy: drift.desired.dependencies,
                };
            case 'unhealthy':
                if (diagnostic) {
                    if (diagnostic.autoRemediable) {
                        return {
                            actionId: randomUUID(),
                            service: drift.service,
                            type: 'restart',
                            reason: `${drift.message} — diagnostic suggests ${diagnostic.fixType}`,
                            priority: basePriority + 1,
                            autoExecute: true,
                            diagnosticReportId: diagnostic.reportId,
                        };
                    }
                    return {
                        actionId: randomUUID(),
                        service: drift.service,
                        type: 'escalate',
                        reason: `${drift.message} — diagnostic: not auto-remediable (${diagnostic.fixType})`,
                        priority: basePriority + 2,
                        autoExecute: false,
                        diagnosticReportId: diagnostic.reportId,
                    };
                }
                return {
                    actionId: randomUUID(),
                    service: drift.service,
                    type: basePriority <= 10 ? 'restart' : 'diagnose',
                    reason: drift.message,
                    priority: basePriority + 1,
                    autoExecute: basePriority <= 10,
                };
            case 'crash_loop':
                return {
                    actionId: randomUUID(),
                    service: drift.service,
                    type: 'diagnose',
                    reason: drift.message,
                    priority: basePriority,
                    autoExecute: false,
                };
            case 'dependency_down':
                return {
                    actionId: randomUUID(),
                    service: drift.service,
                    type: 'skip',
                    reason: drift.message,
                    priority: basePriority + 5,
                    autoExecute: false,
                    blockedBy: drift.desired.dependencies,
                };
            case 'should_not_run':
                return {
                    actionId: randomUUID(),
                    service: drift.service,
                    type: 'stop',
                    reason: drift.message,
                    priority: 50,
                    autoExecute: false,
                };
            case 'resource_exceeded':
                return {
                    actionId: randomUUID(),
                    service: drift.service,
                    type: 'resource_alert',
                    reason: drift.message,
                    priority: basePriority + 3,
                    autoExecute: false,
                };
            default:
                return {
                    actionId: randomUUID(),
                    service: drift.service,
                    type: 'escalate',
                    reason: drift.message,
                    priority: 50,
                    autoExecute: false,
                };
        }
    }
    function reconcile(actual) {
        reconciliations++;
        const drifts = detectDrift(actual);
        const actions = drifts.map(driftToAction);
        actions.sort((a, b) => a.priority - b.priority);
        for (const action of actions) {
            if (action.blockedBy) {
                action.blockedBy = action.blockedBy.filter((dep) => {
                    const depState = actual.services[dep];
                    return !depState || !depState.healthy;
                });
                if (action.blockedBy.length === 0) {
                    delete action.blockedBy;
                }
            }
        }
        totalActions += actions.length;
        autoExecuted += actions.filter((a) => a.autoExecute && !a.blockedBy?.length).length;
        const enabledServices = Object.values(desiredState.services).filter((s) => s.enabled);
        const healthyCount = enabledServices.filter((s) => {
            const a = actual.services[s.name];
            return a && a.running && a.healthy;
        }).length;
        return {
            planId: randomUUID(),
            timestamp: new Date().toISOString(),
            actions,
            desiredCount: enabledServices.length,
            healthyCount,
            driftCount: drifts.length,
            skippedCount: Object.values(desiredState.services).filter((s) => !s.enabled).length,
        };
    }
    return {
        reconcile,
        getDesiredState: () => desiredState,
        updateDesiredState: (state) => {
            desiredState = state;
        },
        detectDrift,
        stats: () => ({ reconciliations, totalActions, autoExecuted }),
    };
}
