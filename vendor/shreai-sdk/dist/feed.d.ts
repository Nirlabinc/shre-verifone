import type { EventBus } from './events.js';
export type FeedCategory = 'alert' | 'insight' | 'action' | 'status' | 'skill_result' | 'delegation' | 'escalation';
export type FeedSeverity = 'info' | 'warning' | 'critical';
export interface FeedPost {
    agentId: string;
    agentEmoji?: string;
    agentName?: string;
    category: FeedCategory;
    severity?: FeedSeverity;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
    skillId?: string;
    storeId?: string;
    storeName?: string;
    tenantId?: string;
    nodeApp?: string;
    toolName?: string;
    workspaceId?: string;
    tags?: string[];
    parentId?: string;
    expiresAt?: string;
}
export declare function postToFeed(bus: EventBus, post: FeedPost): Promise<void>;
export declare function audit(bus: EventBus, entryType: string, payload: Record<string, unknown>, actor?: string): Promise<void>;
