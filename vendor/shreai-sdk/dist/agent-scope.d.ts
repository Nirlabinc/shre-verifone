import { type Logger } from './logger.js';
import type { HonoLikeContext } from './types.js';
export type AccessLevel = 'read' | 'write' | 'none';
export interface DataGrant {
    sourceType: string;
    sourceId: string;
    level: AccessLevel;
    grantedAt: string;
}
export interface AgentScopeConfig {
    routerUrl?: string;
    cacheTtlMs?: number;
    timeoutMs?: number;
    logger?: Logger;
}
export interface AgentScope {
    canAccess(agentId: string, tenantId: string, sourceType: string, sourceId: string): Promise<AccessLevel>;
    listAccessible(agentId: string, tenantId: string): Promise<DataGrant[]>;
    scopeMiddleware(): (c: HonoLikeContext, next: () => Promise<void>) => Promise<void>;
    clearCache(): void;
    invalidateAgent(agentId: string): void;
}
export declare function createAgentScope(config?: AgentScopeConfig): AgentScope;
