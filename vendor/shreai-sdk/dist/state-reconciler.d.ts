export interface DesiredServiceState {
    name: string;
    enabled: boolean;
    port?: number;
    protocol?: 'http' | 'https';
    priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
    category: string;
    healthEndpoint?: string;
    plistLabel?: string;
    dependencies?: string[];
    resources?: {
        maxMemoryMb?: number;
        maxCpuPercent?: number;
    };
    maxRestarts?: number;
    minStableUptimeMs?: number;
}
export interface DesiredState {
    version: string;
    updatedAt: string;
    services: Record<string, DesiredServiceState>;
}
export interface ActualServiceState {
    name: string;
    running: boolean;
    healthy: boolean;
    port?: number;
    pid?: number;
    uptimeMs?: number;
    memoryMb?: number;
    cpuPercent?: number;
    consecutiveFailures: number;
    lastSeen?: string;
    recentRestarts: number;
}
export interface ActualState {
    timestamp: string;
    services: Record<string, ActualServiceState>;
    systemMetrics?: {
        cpuPercent: number;
        memoryPercent: number;
        diskPercent: number;
        loadAvg1m: number;
    };
}
export interface ReconcileAction {
    actionId: string;
    service: string;
    type: 'start' | 'restart' | 'stop' | 'diagnose' | 'escalate' | 'resource_alert' | 'skip';
    reason: string;
    priority: number;
    autoExecute: boolean;
    diagnosticReportId?: string;
    blockedBy?: string[];
}
export interface ReconcilePlan {
    planId: string;
    timestamp: string;
    actions: ReconcileAction[];
    desiredCount: number;
    healthyCount: number;
    driftCount: number;
    skippedCount: number;
}
export interface StateDrift {
    service: string;
    driftType: 'not_running' | 'unhealthy' | 'should_not_run' | 'resource_exceeded' | 'crash_loop' | 'dependency_down';
    severity: 'critical' | 'warning' | 'info';
    desired: Partial<DesiredServiceState>;
    actual: Partial<ActualServiceState>;
    message: string;
}
export interface StateReconciler {
    reconcile(actual: ActualState): ReconcilePlan;
    getDesiredState(): DesiredState;
    updateDesiredState(state: DesiredState): void;
    detectDrift(actual: ActualState): StateDrift[];
    stats(): {
        reconciliations: number;
        totalActions: number;
        autoExecuted: number;
    };
}
interface ReconcilerOptions {
    desiredState: DesiredState;
    getDiagnostic?: (service: string) => {
        reportId: string;
        autoRemediable: boolean;
        fixType: string;
    } | null;
}
export declare function createStateReconciler(options: ReconcilerOptions): StateReconciler;
export {};
