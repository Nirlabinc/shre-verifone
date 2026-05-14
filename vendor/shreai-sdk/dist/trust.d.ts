import { type Logger } from './logger.js';
import type { HonoLikeContext } from './types.js';
export type DelegationTier = 'leadership' | 'c-suite' | 'council' | 'execution' | 'child-company' | 'infrastructure' | 'public' | 'probationary';
export interface TrustedAgent {
    id: string;
    tier: DelegationTier;
    added: string;
    note?: string;
    probationExpires?: string;
    submittedBy?: string;
    domain?: string;
    declaredCapabilities?: string[];
}
export interface ProbationStatus {
    isProbationary: boolean;
    expired: boolean;
    daysRemaining: number;
    expiresAt: string | null;
}
export interface TrustConfig {
    trustedAgentsPath?: string;
    watchIntervalMs?: number;
    fallbackAgents?: string[];
    logger?: Logger;
    publishFn?: (type: string, severity: 'info' | 'warning' | 'critical', data: Record<string, unknown>) => Promise<void>;
    subscribeFn?: (typePattern: string, handler: (event: unknown) => void) => () => void;
    skipFileWatch?: boolean;
}
export interface TrustChain {
    isTrusted(agentId: string): boolean;
    validateAgent(agentId: string | undefined, rejectUnknown?: boolean): string;
    canDelegate(fromAgent: string, toAgent: string): boolean;
    getAgent(agentId: string): TrustedAgent | undefined;
    trustHeaders(agentId: string): Record<string, string>;
    listTrusted(): string[];
    readonly size: number;
    reload(): void;
    dispose(): void;
    getProbationStatus(agentId: string): ProbationStatus;
}
export declare function createTrustChain(config?: TrustConfig): TrustChain;
export declare function requireTrustedAgent(trust: TrustChain): (c: HonoLikeContext, next: () => Promise<void>) => Promise<Response | undefined>;
