import { type Logger } from './logger.js';
export type ApiHealthState = 'healthy' | 'degraded' | 'down' | 'rate_limited';
export interface ExternalApiConfig {
    name: string;
    url: string;
    intervalMs?: number;
    headers?: Record<string, string>;
    timeout?: number;
    degradedThreshold?: number;
    downThreshold?: number;
}
export interface ExternalApiStatus {
    name: string;
    url: string;
    state: ApiHealthState;
    lastCheck: string | null;
    lastSuccess: string | null;
    latencyMs: number;
    avgLatencyMs: number;
    uptimePct: number;
    consecutiveFailures: number;
    totalChecks: number;
    totalFailures: number;
    backoffUntil: string | null;
}
export interface ExternalMonitorOptions {
    onDegraded?: (status: ExternalApiStatus) => void;
    onDown?: (status: ExternalApiStatus) => void;
    onRecovered?: (status: ExternalApiStatus) => void;
    onRateLimited?: (status: ExternalApiStatus) => void;
    logger?: Logger;
}
export interface ExternalMonitor {
    register(config: ExternalApiConfig): void;
    unregister(name: string): void;
    start(): void;
    stop(): void;
    getStatus(): ExternalApiStatus[];
    getApiStatus(name: string): ExternalApiStatus | undefined;
    isRunning(): boolean;
}
export declare function createExternalMonitor(serviceName: string, opts?: ExternalMonitorOptions): ExternalMonitor;
