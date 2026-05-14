export interface RateLimitBucket {
    perMinute: number;
    perHour: number;
    burst: number;
}
export interface RateLimitConfig {
    redis: RedisLike;
    defaultLimits?: RateLimitBucket;
    tenantOverrides?: Map<string, RateLimitBucket>;
    agentOverrides?: Map<string, RateLimitBucket>;
    keyPrefix?: string;
    tenantHeader?: string;
    skipIps?: string[];
}
export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    limit: number;
    resetAt: number;
    retryAfterSeconds: number;
}
export interface RateLimiter {
    middleware(): (c: MiddlewareContext, next: () => Promise<void>) => Promise<void | Response>;
    check(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
    getRemainingQuota(tenantId: string): Promise<{
        perMinute: {
            remaining: number;
            limit: number;
            resetAt: number;
        };
        perHour: {
            remaining: number;
            limit: number;
            resetAt: number;
        };
    }>;
}
interface RedisLike {
    eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
    get(key: string): Promise<string | null>;
    status?: string;
}
interface MiddlewareContext {
    req: {
        header(name: string): string | undefined;
        method: string;
        path: string;
        raw?: {
            socket?: {
                remoteAddress?: string;
            };
        };
    };
    header(name: string, value: string): void;
    json(body: unknown, status?: number): Response;
    get?(key: string): unknown;
    set?(key: string, value: unknown): void;
}
export declare function createRateLimiter(config: RateLimitConfig): RateLimiter;
export {};
