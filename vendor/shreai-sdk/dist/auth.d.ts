import type { Provider, HonoLikeContext } from './types.js';
import type { EventBus } from './events.js';
export declare function readVaultKey(filename: string): string;
export declare function readAuthProfile(profileName: string, agentId?: string): string;
export declare function readGatewayToken(): string;
export declare function resolveProviderKey(provider: Provider): string;
export declare function validateBearerToken(authHeader: string | undefined | null, expectedToken: string): boolean;
export declare function createServiceAuth(envVarName: string, vaultFilename?: string): {
    token: string;
    validate: (authHeader: string | undefined | null) => boolean;
    hasToken: boolean;
};
export declare function authHeaders(vaultFilename: string): Record<string, string>;
interface AuthExpressRequest {
    headers?: Record<string, string | undefined>;
    [key: string]: unknown;
}
interface AuthExpressResponse {
    status(code: number): {
        json(body: unknown): void;
    };
    [key: string]: unknown;
}
export declare function requireBearerAuth(envVarName: string, vaultFilename: string): (req: AuthExpressRequest, res: AuthExpressResponse, next: () => void) => void;
export declare function generateServiceHMAC(serviceName: string, payload: string, secret?: string): string;
export declare function verifyServiceHMAC(serviceName: string, payload: string, signature: string, secret?: string): boolean;
export declare function serviceIdentityMiddleware(opts: {
    serviceName: string;
    secret?: string;
}): (c: any, next: () => Promise<void>) => Promise<any>;
export interface PlatformJWTClaims {
    sub: string;
    email: string;
    name: string;
    iat: number;
    exp: number;
    jti: string;
    activeWorkspaceId: string;
    activeWorkspaceName: string;
    workspaceIds: string[];
    role: 'owner' | 'admin' | 'member' | 'viewer';
    scopes: string[];
    isSuperAdmin: boolean;
    tokenType: 'platform_user';
}
export declare function validateJWTLocally(token: string): PlatformJWTClaims | null;
export interface UserClaims {
    sub?: string;
    role?: string;
    scopes?: string[];
    isSuperAdmin?: boolean;
    [key: string]: unknown;
}
export declare function initAuthCache(eventBus?: EventBus): void;
export declare function requireUserAuth(opts?: {
    requiredScope?: string;
    requiredRole?: 'owner' | 'admin' | 'member' | 'viewer';
    cacheTtl?: number;
}): (c: HonoLikeContext, next: () => Promise<void>) => Promise<Response | void>;
export declare function onTokenRevoked(eventBus: EventBus, handler: (subject: string, revokedAt: string, revokedCount: number) => void | Promise<void>): () => void;
export declare function createTokenCache(eventBus: EventBus): {
    get: (subject: string) => string | undefined;
    set: (subject: string, token: string) => void;
    delete: (subject: string) => boolean;
    clear: () => void;
    size: () => number;
    shutdown: () => void;
};
export {};
