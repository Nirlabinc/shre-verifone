import type { DegradationForecast, DegradationSeverity } from './predictive-degradation.js';
export type RecoveryStrategy = 'restart_service' | 'flush_cache' | 'scale_down' | 'rotate_keys' | 'alert_only';
export interface RecoveryAction {
    service: string;
    strategy: RecoveryStrategy;
    reason: string;
    triggerSeverity: DegradationSeverity;
    ensembleProbability: number;
    decidedAt: string;
}
export interface RecoveryRecord {
    action: RecoveryAction;
    success: boolean;
    error?: string;
    durationMs: number;
    completedAt: string;
}
export interface CascadeAlert {
    failedService: string;
    severity: DegradationSeverity;
    affectedUpstream: string[];
    detectedAt: string;
}
export interface SelfHealingOptions {
    maxRecoveriesPerHour?: number;
    onRecover?: (action: RecoveryAction) => Promise<void>;
    publishFn?: (event: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    strategyOverrides?: Partial<Record<DegradationSeverity, RecoveryStrategy>>;
    maxHistorySize?: number;
}
export interface SelfHealingEngine {
    evaluateAndAct(forecast: DegradationForecast): Promise<RecoveryRecord | null>;
    registerDependency(service: string, dependsOn: string[]): void;
    unregisterDependency(service: string): void;
    getCascadeAlerts(): CascadeAlert[];
    getRecoveryHistory(limit?: number): RecoveryRecord[];
    getRecoveryBudget(): Record<string, {
        used: number;
        remaining: number;
        max: number;
    }>;
    markFailing(service: string, severity: DegradationSeverity): void;
    clearFailure(service: string): void;
    stats(): {
        totalRecoveries: number;
        successfulRecoveries: number;
        failedRecoveries: number;
        activeFailures: number;
        trackedDependencies: number;
    };
}
export declare function createSelfHealingEngine(serviceName: string, opts?: SelfHealingOptions): SelfHealingEngine;
