import type { EventBus } from './events.js';
import type { HonoLikeContext } from './types.js';
export type AuditCategory = 'auth.login' | 'auth.logout' | 'auth.failed' | 'auth.revoked' | 'auth.token_issued' | 'auth.token_rotated' | 'auth.token_revoked' | 'access.chat' | 'access.tool' | 'access.data' | 'access.admin' | 'access.denied' | 'data.read' | 'data.write' | 'data.export' | 'data.delete' | 'config.change' | 'config.reload' | 'tool.executed' | 'tool.denied' | 'tool.granted' | 'tool.revoked' | 'budget.exceeded' | 'budget.warning' | 'budget.set' | 'budget.removed';
export interface AuditEntry {
    entryType: AuditCategory | string;
    actor: string;
    service: string;
    tenantId?: string;
    agentId?: string;
    ip?: string;
    resource?: string;
    action?: string;
    payload?: Record<string, unknown>;
}
export interface AuditClient {
    log(entryType: AuditCategory | string, data?: Partial<Omit<AuditEntry, 'entryType' | 'service'>>, actor?: string): Promise<void>;
}
export declare function createAuditClient(serviceName: string, bus: EventBus): AuditClient;
export declare function auditMiddleware(client: AuditClient): (c: HonoLikeContext, next: () => Promise<void>) => Promise<void>;
