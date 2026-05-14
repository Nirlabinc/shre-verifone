import type { PluginRegistry } from './plugin.js';
export interface NodeInput {
    id: string;
    name?: string;
    category?: string;
    description?: string;
    authType?: string;
    provisioning?: string;
    metadata?: Record<string, unknown>;
}
export interface ToolInput {
    id: string;
    name?: string;
    description?: string;
    appId?: string;
    category?: string;
    requiredNodes?: string[];
    optionalNodes?: string[];
    skillKey?: string;
    minSkillLevel?: number;
    mutating?: boolean;
    metadata?: Record<string, unknown>;
}
export interface AppInput {
    id: string;
    name?: string;
    description?: string;
    tools?: string[];
    requiredNodes?: string[];
    metadata?: Record<string, unknown>;
}
export interface PipeInput {
    id: string;
    name?: string;
    sourceNode: string;
    targetNode: string;
    direction?: string;
    schedule?: string;
    metadata?: Record<string, unknown>;
}
export interface BlockContractInput {
    blockId: string;
    version?: string;
    owns?: string[];
    reads?: string[];
    emits?: string[];
    tenantScope?: string;
    priority?: number;
    metadata?: Record<string, unknown>;
}
export interface AgentInput {
    id: string;
    name?: string;
    tier?: string;
    tools?: string[];
    skills?: string[];
    metadata?: Record<string, unknown>;
}
export declare function registerNode(registry: PluginRegistry, node: NodeInput): void;
export declare function registerTool(registry: PluginRegistry, tool: ToolInput): void;
export declare function registerApp(registry: PluginRegistry, app: AppInput): void;
export declare function registerPipe(registry: PluginRegistry, pipe: PipeInput): void;
export declare function registerBlockContract(registry: PluginRegistry, block: BlockContractInput): void;
export declare function registerAgent(registry: PluginRegistry, agent: AgentInput): void;
export interface BulkRegistration {
    nodes?: NodeInput[];
    tools?: ToolInput[];
    apps?: AppInput[];
    pipes?: PipeInput[];
    blocks?: BlockContractInput[];
    agents?: AgentInput[];
}
export declare function registerAll(registry: PluginRegistry, items: BulkRegistration): void;
