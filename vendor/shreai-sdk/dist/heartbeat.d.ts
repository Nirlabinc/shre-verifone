import type { EventSeverity } from './types.js';
export type HeartbeatStatus = 'alive' | 'degraded' | 'unresponsive' | 'dead';
export interface HeartbeatSignal {
    service: string;
    status: HeartbeatStatus;
    ts: string;
    uptimeMs: number;
    memMB: number;
    latencyMs?: number;
    consecutiveFailures: number;
    dependencies?: Record<string, DependencyStatus>;
    meta?: Record<string, unknown>;
}
export interface DependencyStatus {
    name: string;
    status: HeartbeatStatus;
    lastSeen: string;
    latencyMs: number;
    consecutiveFailures: number;
}
export interface AgentHeartbeat {
    agentId: string;
    taskId: string;
    status: 'active' | 'idle' | 'stuck' | 'dead';
    lastPing: string;
    progressPct?: number;
    memMB?: number;
    consecutiveMisses: number;
}
export interface ConsumerHeartbeat {
    consumerId: string;
    service: string;
    stream: string;
    lastAck: string;
    pendingCount: number;
    status: HeartbeatStatus;
}
export interface InfraProbeResult {
    target: string;
    reachable: boolean;
    latencyMs: number;
    ts: string;
    error?: string;
}
export interface HeartbeatMonitorOptions {
    publishFn?: (event: string, severity: EventSeverity, data: Record<string, unknown>) => Promise<void>;
    intervalMs?: number;
    onHeartbeat?: (signal: HeartbeatSignal) => void;
}
export interface HeartbeatMonitor {
    start(): void;
    stop(): void;
    registerDependency(name: string, healthUrl: string): void;
    unregisterDependency(name: string): void;
    getStatus(): HeartbeatSignal;
    getDependencyGraph(): Record<string, DependencyStatus>;
    isRunning(): boolean;
}
export declare function createHeartbeatMonitor(serviceName: string, opts?: HeartbeatMonitorOptions): HeartbeatMonitor;
export interface AgentLivenessOptions {
    expectedIntervalMs?: number;
    missThreshold?: number;
    deadThreshold?: number;
    onStuck?: (agentId: string, taskId: string, missedCount: number) => void;
    onDead?: (agentId: string, taskId: string, missedCount: number) => void;
    onRecovered?: (agentId: string, taskId: string) => void;
    publishFn?: (event: string, severity: EventSeverity, data: Record<string, unknown>) => Promise<void>;
}
export interface AgentLivenessTracker {
    register(agentId: string, taskId: string, pid?: number): void;
    ping(agentId: string, meta?: {
        progressPct?: number;
        memMB?: number;
    }): void;
    unregister(agentId: string): void;
    check(): AgentHeartbeat[];
    get(agentId: string): AgentHeartbeat | null;
    getAll(): AgentHeartbeat[];
    startChecker(intervalMs?: number): void;
    stopChecker(): void;
}
export declare function createAgentLivenessTracker(opts?: AgentLivenessOptions): AgentLivenessTracker;
export interface ConsumerTrackerOptions {
    expectedIntervalMs?: number;
    onDeadConsumer?: (consumer: ConsumerHeartbeat) => void;
    publishFn?: (event: string, severity: EventSeverity, data: Record<string, unknown>) => Promise<void>;
}
export interface ConsumerTracker {
    ping(consumerId: string, service: string, stream: string, pendingCount?: number): void;
    check(): ConsumerHeartbeat[];
    getAll(): ConsumerHeartbeat[];
    startChecker(intervalMs?: number): void;
    stopChecker(): void;
}
export declare function createConsumerTracker(opts?: ConsumerTrackerOptions): ConsumerTracker;
export declare function probeEndpoint(url: string, timeoutMs?: number): Promise<InfraProbeResult>;
export declare function probeOllama(host?: string, timeoutMs?: number): Promise<InfraProbeResult & {
    models?: string[];
}>;
export declare function probeLegacyGateway(_host?: string, _timeoutMs?: number): Promise<InfraProbeResult>;
export declare const probeOpenClaw: typeof probeLegacyGateway;
export declare function probeTunnel(externalUrl: string, timeoutMs?: number): Promise<InfraProbeResult>;
export declare function probeShadowPC(host?: string, timeoutMs?: number): Promise<InfraProbeResult>;
export interface InfraHeartbeatOptions {
    intervalMs?: number;
    publishFn?: (event: string, severity: EventSeverity, data: Record<string, unknown>) => Promise<void>;
    onProbe?: (results: InfraProbeResult[]) => void;
    targets?: Array<'ollama' | 'shre-router' | 'openclaw' | 'legacy-gateway' | 'tunnel' | 'shadowpc'>;
    tunnelUrl?: string;
}
export interface InfraHeartbeat {
    start(): void;
    stop(): void;
    getLatest(): Record<string, InfraProbeResult>;
    probeNow(): Promise<Record<string, InfraProbeResult>>;
}
export declare function createInfraHeartbeat(opts?: InfraHeartbeatOptions): InfraHeartbeat;
