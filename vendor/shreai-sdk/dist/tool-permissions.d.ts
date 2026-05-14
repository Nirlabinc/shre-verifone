export interface ToolGrant {
    agentId: string;
    toolName: string;
    grantedAt: string;
    grantedBy: string;
}
export interface ToolPermissions {
    getAgentTools(agentId: string): string[];
    canUseTool(agentId: string, toolName: string): boolean;
    filterToolsForAgent<T extends {
        name: string;
    }>(agentId: string, allTools: T[]): T[];
    grantTool(agentId: string, toolName: string, grantedBy?: string): void;
    revokeTool(agentId: string, toolName: string): void;
    setAgentTools(agentId: string, tools: string[], grantedBy?: string): void;
    listAllGrants(): ToolGrant[];
    getGrantsSummary(): Record<string, string[]>;
}
export interface ToolPermissionsOptions {
    dbPath?: string;
    bootstrap?: boolean;
}
export declare function createToolPermissions(options?: ToolPermissionsOptions): ToolPermissions;
