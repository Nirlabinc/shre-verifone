import { type Logger } from './logger.js';
import type { EventBus } from './events.js';
export interface SSOConfig {
    provider: 'oidc' | 'saml';
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes?: string[];
    allowedDomains?: string[];
    groupRoleMapping?: Record<string, string>;
    eventBus?: EventBus;
    jwtSecret?: string;
    tokenTtlSeconds?: number;
}
export interface SSOUser {
    sub: string;
    email: string;
    name: string;
    groups: string[];
    provider: string;
    roles: string[];
    rawClaims?: Record<string, unknown>;
}
export interface SSOCallbackResult {
    user: SSOUser;
    token: string;
    expiresAt: string;
}
interface OIDCDiscovery {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    userinfo_endpoint: string;
    jwks_uri: string;
    scopes_supported?: string[];
    id_token_signing_alg_values_supported?: string[];
}
export declare function validateToken(token: string, issuer: string, log?: Logger): Promise<{
    valid: boolean;
    claims?: Record<string, unknown>;
    error?: string;
}>;
export interface SSOProvider {
    initiateLogin(req?: {
        query?: Record<string, string>;
    }): Promise<{
        redirectUrl: string;
        state: string;
    }>;
    handleCallback(params: {
        code: string;
        state: string;
    }): Promise<SSOCallbackResult>;
    validateToken(token: string): Promise<{
        valid: boolean;
        claims?: Record<string, unknown>;
        error?: string;
    }>;
    getDiscovery(): Promise<OIDCDiscovery>;
}
export declare function createSSOProvider(config: SSOConfig): SSOProvider;
export {};
