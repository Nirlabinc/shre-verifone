export interface LogEntry {
    timestamp: string;
    level: 'error' | 'warn' | 'info';
    message: string;
    service: string;
    data?: Record<string, unknown>;
}
export interface ServiceHealthState {
    status: 'alive' | 'degraded' | 'dead' | 'unknown';
    uptimeMs?: number;
    memoryMb?: number;
    consecutiveFailures: number;
    lastSeen?: string;
}
export interface SystemMetrics {
    cpuPercent: number;
    memoryPercent: number;
    diskPercent: number;
    loadAvg1m: number;
}
export interface RecoveryRecord {
    timestamp: string;
    action: string;
    success: boolean;
    durationMs: number;
}
export interface KnownErrorPattern {
    patternId: string;
    errorSignature: string;
    rootCause: string;
    fixDescription: string;
    fixType: SuggestedFix['type'];
    autoRemediable: boolean;
    risk: 'low' | 'medium' | 'high';
    occurrences: number;
    lastSeen: string;
}
export interface DiagnosticEvidence {
    source: 'logs' | 'health_state' | 'dependency' | 'metrics' | 'history' | 'pattern';
    description: string;
    data: Record<string, unknown>;
}
export interface SuggestedFix {
    type: 'restart' | 'config_change' | 'dependency_fix' | 'resource_cleanup' | 'code_change' | 'escalate';
    description: string;
    autoRemediable: boolean;
    risk: 'low' | 'medium' | 'high';
    steps: string[];
}
export interface DiagnosticReport {
    reportId: string;
    service: string;
    timestamp: string;
    rootCauseHypothesis: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: DiagnosticEvidence[];
    cascadeImpact: string[];
    suggestedFix: SuggestedFix;
    matchedPattern: string | null;
}
export interface DiagnosticInput {
    service: string;
    recentLogs: LogEntry[];
    healthState: ServiceHealthState;
    dependencyHealth: Record<string, 'ok' | 'degraded' | 'down'>;
    recoveryHistory: RecoveryRecord[];
    knownPatterns: KnownErrorPattern[];
    systemMetrics: SystemMetrics;
    upstreamDependents?: string[];
}
export interface DiagnosticEngine {
    diagnose(input: DiagnosticInput): DiagnosticReport;
    registerPattern(pattern: KnownErrorPattern): void;
    getPatterns(): KnownErrorPattern[];
    stats(): {
        totalDiagnoses: number;
        patternMatches: number;
        autoRemediable: number;
    };
}
export declare function createDiagnosticEngine(): DiagnosticEngine;
