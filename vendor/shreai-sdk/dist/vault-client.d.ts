interface MaskedCredential {
    name: string;
    masked: string;
    stored: boolean;
    updatedAt: string | null;
}
interface DecryptedCredential {
    name: string;
    value: string;
    decryptedBy: string;
    auditId: string;
}
export declare function getMasked(name: string, agentId: string): Promise<MaskedCredential | null>;
export declare function decrypt(name: string, passcodeHash: string, agentId: string): Promise<DecryptedCredential | null>;
export declare function getOrEnv(name: string, envVar: string, agentId: string, passcodeHash?: string): Promise<string | null>;
export declare function store(name: string, value: string, agentId: string): Promise<boolean>;
export declare function list(agentId: string): Promise<string[]>;
export type VaultScope = 'system' | 'workspace' | 'user' | 'app';
export declare function storeScoped(scope: VaultScope, scopeId: string, name: string, value: string, agentId: string): Promise<boolean>;
export declare function listScoped(scope: VaultScope, scopeId: string, agentId: string): Promise<string[]>;
export declare function getMaskedScoped(scope: VaultScope, scopeId: string, name: string, agentId: string): Promise<MaskedCredential | null>;
export declare function deleteScoped(scope: VaultScope, scopeId: string, name: string, agentId: string): Promise<boolean>;
export interface VaultTicketRef {
    ticketId: string;
    agentId: string;
    scope: VaultScope;
    scopeId: string;
    credentials: string[];
    expiresAt: string;
    ttlMs: number;
}
export declare function issueTicket(agentId: string, scope: VaultScope, scopeId: string, credentials: string[], issuerId: string, ttlMs?: number): Promise<VaultTicketRef | null>;
export declare function redeemTicket(ticketId: string, credential: string, agentId: string): Promise<string | null>;
export {};
