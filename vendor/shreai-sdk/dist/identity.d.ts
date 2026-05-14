import { type Logger } from './logger.js';
export interface IdentityConfig {
    brainDir?: string;
    legacyDir?: string;
    cacheTtlMs?: number;
    logger?: Logger;
    contextServiceUrl?: string;
}
export interface VaultContext {
    soul: string;
    identity: string;
    agents?: string;
    policy?: string;
}
export interface IdentityResolver {
    getSoulContext(): string;
    injectSoul(systemPrompt?: string): string;
    resolveForAgent(agentId: string, tenantId?: string): Promise<string>;
    getMode(): 'vault' | 'training' | 'legacy';
    setVault(ctx: VaultContext): void;
    invalidate(): void;
}
export declare function createIdentityResolver(config?: IdentityConfig): IdentityResolver;
