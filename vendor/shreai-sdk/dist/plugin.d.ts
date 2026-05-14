import { type Logger } from './logger.js';
export type PluginType = 'agent' | 'agent-block' | 'tool' | 'node' | 'pipe' | 'app' | 'ui-block' | 'chat-extension' | 'foundation' | string;
export type PluginStatus = 'registered' | 'resolved' | 'active' | 'degraded' | 'disabled';
export interface PluginTrustGate {
    minTier?: string;
    allowedAgents?: string[];
}
export interface PluginCost {
    budgetGroup?: string;
    weight?: number;
}
export interface PluginHooks {
    before?: string[];
    after?: string[];
}
export interface PluginManifest {
    id: string;
    type: PluginType;
    version: string;
    name?: string;
    description?: string;
    requires?: string[];
    provides?: string[];
    optional?: string[];
    owns?: string[];
    reads?: string[];
    emits?: string[];
    trust?: PluginTrustGate;
    cost?: PluginCost;
    hooks?: PluginHooks;
    metadata?: Record<string, unknown>;
}
export interface ResolvedPlugin {
    plugin: PluginManifest;
    dependencies: PluginManifest[];
    missing: string[];
    missingOptional: string[];
    ready: boolean;
}
export interface DependencyEdge {
    from: string;
    to: string;
    capability: string;
    optional: boolean;
}
export interface PluginGraph {
    edges: DependencyEdge[];
    roots: string[];
    unresolved: string[];
    activationOrder: string[];
}
export interface PluginRegistryConfig {
    logger?: Logger;
    rejectOnCollision?: boolean;
}
export interface PluginRegistry {
    register(manifest: PluginManifest): void;
    unregister(id: string): boolean;
    get(id: string): PluginManifest | undefined;
    list(): string[];
    listByType(type: PluginType): PluginManifest[];
    resolve(id: string): ResolvedPlugin;
    graph(): PluginGraph;
    providers(capability: string): PluginManifest[];
    dependents(capability: string): PluginManifest[];
    readonly size: number;
}
export declare function createPluginRegistry(config?: PluginRegistryConfig): PluginRegistry;
