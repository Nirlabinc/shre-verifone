import { type Logger } from './logger.js';
import { type PluginRegistry, type PluginManifest, type PluginRegistryConfig } from './plugin.js';
import { type TrustChain, type TrustConfig } from './trust.js';
import { type AgentScope, type AgentScopeConfig } from './agent-scope.js';
import { type CostClient, type CostClientConfig } from './cost.js';
import { type HookRegistry, type HookConfig } from './hooks.js';
import { type Resilience, type ResilienceConfig } from './resilience.js';
export type GateResult = 'pass' | 'fail' | 'skip' | 'degraded';
export interface GateResults {
    trust: GateResult;
    scope: GateResult;
    budget: GateResult;
    deps: GateResult;
    reasons: string[];
}
export interface ActivationContext {
    plugin: PluginManifest;
    dependencies: PluginManifest[];
    agentId: string;
    tenantId: string;
    gates: GateResults;
    ready: boolean;
    budgetAction?: string;
    data: Record<string, unknown>;
}
export interface ExecutionResult<T> {
    value: T;
    context: ActivationContext;
    durationMs: number;
}
export interface PluginBusConfig {
    service: string;
    logger?: Logger;
    registry?: PluginRegistry;
    trust?: TrustChain;
    scope?: AgentScope;
    cost?: CostClient;
    hooks?: HookRegistry;
    resilience?: Resilience;
    registryConfig?: PluginRegistryConfig;
    trustConfig?: TrustConfig;
    scopeConfig?: AgentScopeConfig;
    costConfig?: Omit<CostClientConfig, 'service'>;
    hookConfig?: HookConfig;
    resilienceConfig?: Omit<ResilienceConfig, 'service'>;
    publishFn?: (type: string, severity: 'info' | 'warning' | 'critical', data: Record<string, unknown>) => Promise<void>;
    skipGates?: Array<'trust' | 'scope' | 'budget'>;
}
export interface PluginBus {
    register(manifest: PluginManifest): void;
    unregister(id: string): boolean;
    activate(pluginId: string, opts: {
        agentId: string;
        tenantId?: string;
        data?: Record<string, unknown>;
    }): Promise<ActivationContext>;
    execute<T>(pluginId: string, opts: {
        agentId: string;
        tenantId?: string;
        data?: Record<string, unknown>;
    }, fn: (ctx: ActivationContext) => Promise<T>): Promise<ExecutionResult<T>>;
    readonly plugins: PluginRegistry;
    readonly hookRegistry: HookRegistry;
    readonly trustChain: TrustChain;
    dispose(): void;
}
export declare function createPluginBus(config: PluginBusConfig): PluginBus;
