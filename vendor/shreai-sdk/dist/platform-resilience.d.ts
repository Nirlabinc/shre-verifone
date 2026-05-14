import { type DiagnosticEngine } from './diagnostic-engine.js';
import { type TaskLifecycleClient } from './task-lifecycle.js';
import { type HealActionRunner } from './heal-actions.js';
export interface PlatformResilienceOptions {
    service: string;
    publishFn?: (event: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    tasksToken?: string;
    dependencies?: string[];
    port?: number;
    watchdogIntervalMs?: number;
    memoryThresholdMb?: number;
    loopLagThresholdMs?: number;
    disable?: {
        taskLifecycle?: boolean;
        diagnostics?: boolean;
        healActions?: boolean;
        watchdog?: boolean;
    };
}
export interface PlatformResilience {
    taskLifecycle: TaskLifecycleClient | null;
    diagnostics: DiagnosticEngine;
    healActions: HealActionRunner;
    startWatchdog(intervalMs?: number): void;
    stopWatchdog(): void;
    handleIncident(tag: string, context: Record<string, unknown>): Promise<void>;
    shutdown(): void;
}
export declare function createPlatformResilience(opts: PlatformResilienceOptions): PlatformResilience;
