import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import { type DegradationReporter, type DegradationReporterOptions } from './degradation.js';
import { type Logger } from './logger.js';
export interface RetryOptions {
    maxRetries?: number;
    baseDelayMs?: number;
    backoff?: number;
    jitter?: number;
    timeoutMs?: number;
    retryIf?: (err: Error) => boolean;
}
export interface ResilienceConfig {
    service: string;
    defaults?: RetryOptions;
    logger?: Logger;
    degradation?: DegradationReporterOptions;
}
export interface FallbackEntry<T> {
    name: string;
    fn: () => Promise<T>;
}
export interface Resilience {
    wrap<T>(name: string, fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;
    fallbackChain<T>(chain: FallbackEntry<T>[]): Promise<T>;
    breaker(name: string, opts?: Partial<CircuitBreakerOptions>): CircuitBreaker;
    degrade(feature: string, dependency: string, severity: 'minor' | 'major' | 'critical'): void;
    isDegraded(feature: string): boolean;
    getDegradation(): DegradationReporter;
}
export declare function createResilience(config: ResilienceConfig): Resilience;
export interface BulkheadOptions {
    maxConcurrent: number;
    maxQueue?: number;
}
export declare class Bulkhead {
    readonly name: string;
    readonly maxConcurrent: number;
    private active;
    private readonly queue;
    private readonly maxQueue;
    constructor(name: string, maxConcurrent: number, opts?: {
        maxQueue?: number;
    });
    execute<T>(fn: () => Promise<T>): Promise<T>;
    getStats(): {
        name: string;
        active: number;
        queued: number;
        maxConcurrent: number;
        maxQueue: number;
    };
}
export declare class BulkheadRejectError extends Error {
    constructor(name: string);
}
export interface StaleCacheOptions {
    staleTtlMs?: number;
    maxEntries?: number;
    logger?: Logger;
}
export declare class StaleCache<T> {
    private cache;
    private readonly staleTtlMs;
    private readonly maxEntries;
    private readonly log?;
    constructor(opts?: StaleCacheOptions);
    fetchOrStale(key: string, fetcher: () => Promise<T>): Promise<{
        data: T;
        stale: boolean;
    }>;
    set(key: string, data: T): void;
    get(key: string): T | undefined;
    has(key: string): boolean;
    clear(): void;
}
export declare class RetryBudget {
    private window;
    private readonly windowMs;
    private readonly maxRetryPct;
    constructor(windowMs?: number, maxRetryPct?: number);
    canRetry(): boolean;
    record(isRetry: boolean): void;
    private prune;
}
export { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
export type { CircuitBreakerOptions, CircuitState } from './circuit-breaker.js';
