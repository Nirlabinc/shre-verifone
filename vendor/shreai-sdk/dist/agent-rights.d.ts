export type AgentRight = 'self-heal' | 'shell-exec' | 'file-write' | 'file-delete' | 'db-write' | 'db-delete' | 'task-create' | 'task-resolve' | 'config-change' | 'service-restart' | 'network-access' | 'secret-access' | 'agent-spawn' | 'budget-override' | 'data-export' | 'audit-bypass';
export interface AgentRightsConfig {
    agentId: string;
    fullRights: boolean;
    rights: Partial<Record<AgentRight, boolean>>;
    notes?: string;
    updatedAt: string;
}
export interface RightsStore {
    version: number;
    defaults: {
        fullRights: boolean;
        rights: Partial<Record<AgentRight, boolean>>;
    };
    agents: Record<string, AgentRightsConfig>;
}
export interface AgentRightsManager {
    can(agentId: string, right: AgentRight): boolean;
    grant(agentId: string, right: AgentRight, note?: string): void;
    deny(agentId: string, right: AgentRight, note?: string): void;
    setFullRights(agentId: string, enabled: boolean, note?: string): void;
    getRights(agentId: string): AgentRightsConfig;
    getStore(): RightsStore;
    setDefaults(defaults: Partial<RightsStore['defaults']>): void;
    reload(): void;
    save(): void;
}
export declare function createAgentRightsManager(): AgentRightsManager;
export declare function resetAgentRightsManager(): void;
