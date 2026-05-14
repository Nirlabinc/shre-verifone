import { type Logger } from './logger.js';
export interface AgentBlockContract {
    blockId: string;
    version: string;
    owns: string[];
    reads: string[];
    emits: string[];
    maxTtlS: number;
    idempotent: boolean;
    rollback?: () => Promise<void>;
    tenantScope: 'single' | 'cross';
    priority: number;
    maxRetries: number;
}
export interface BlockCollision {
    blockIdA: string;
    blockIdB: string;
    conflictingKeys: string[];
}
export interface CollisionReport {
    collisions: BlockCollision[];
    waves: string[][];
    cycles: string[][];
    isClean: boolean;
}
export interface StateMutationAudit {
    blockId: string;
    tenantId: string;
    allowed: boolean;
    attemptedKeys: string[];
    ownedKeys: string[];
    violations: string[];
    timestamp: string;
}
export interface BlockRegistryOptions {
    rejectOnCollision?: boolean;
    rejectOnCycle?: boolean;
    logger?: Logger;
}
export interface StateMutationAuditorOptions {
    throwOnViolation?: boolean;
    logger?: Logger;
}
export interface BlockRegistry {
    register(contract: AgentBlockContract): void;
    unregister(blockId: string): boolean;
    getContract(blockId: string): AgentBlockContract | undefined;
    listBlockIds(): string[];
    analyze(): CollisionReport;
    readonly collisionCount: number;
}
export interface StateMutationAuditor {
    validate(contract: AgentBlockContract, tenantId: string, before: Record<string, unknown>, after: Record<string, unknown>): StateMutationAudit;
}
export declare function createBlockRegistry(serviceName: string, opts?: BlockRegistryOptions): BlockRegistry;
export declare function createStateMutationAuditor(serviceName: string, opts?: StateMutationAuditorOptions): StateMutationAuditor;
