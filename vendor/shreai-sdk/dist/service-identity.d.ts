import type { HonoLikeContext } from './types.js';
export interface ServiceIdentity {
    sign(method: string, path: string): Record<string, string>;
    serviceName: string;
}
export declare function createServiceIdentity(serviceName: string): ServiceIdentity;
export interface VerifyResult {
    service: string;
    verified: boolean;
    reason?: string;
}
export declare function verifyServiceIdentity(headers: Record<string, string | undefined>): VerifyResult;
export declare function verifyServiceSignature(service: string, method: string, path: string, timestamp: string, signature: string): VerifyResult;
export declare function requireServiceAuth(): (c: HonoLikeContext, next: () => Promise<void>) => Promise<void | Response>;
export declare function serviceHeaders(serviceName: string, vaultFilename: string, method: string, path: string): Record<string, string>;
