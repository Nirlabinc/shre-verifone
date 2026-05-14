import type { EventBus } from './events.js';
import type { HonoLikeContext } from './types.js';
export interface PassportPayload {
    passportId: string;
    entityId: string;
    type: string;
    scopes: string[];
    clearanceTier?: number;
}
export interface PassportClientOptions {
    bus?: EventBus;
    passportUrl?: string;
    cacheTtlMs?: number;
    breakerCall?: <T>(fn: () => Promise<T>) => Promise<T>;
}
export interface PassportClient {
    verify(token: string): Promise<PassportPayload | null>;
    clearCache(): void;
}
export declare function createPassportClient(opts?: PassportClientOptions): PassportClient;
export declare function requirePassport(client: PassportClient, opts?: {
    optional?: boolean;
}): (c: HonoLikeContext, next: () => Promise<void>) => Promise<void | Response>;
export declare function passportHeaders(token: string): Record<string, string>;
