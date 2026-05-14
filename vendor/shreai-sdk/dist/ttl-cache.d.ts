export interface TTLCacheOptions {
    maxEntries?: number;
    ttlMs?: number;
    sweep?: boolean;
    sweepIntervalMs?: number;
    name?: string;
}
export interface CacheStats {
    name: string;
    size: number;
    maxEntries: number;
    ttlMs: number;
    hits: number;
    misses: number;
    evictions: number;
    expired: number;
    hitRate: string;
}
export declare function getAllCacheStats(): CacheStats[];
export declare class TTLCache<T> {
    private readonly map;
    private readonly maxEntries;
    private readonly ttlMs;
    private readonly cacheName;
    private sweepTimer;
    private _hits;
    private _misses;
    private _evictions;
    private _expired;
    constructor(opts?: TTLCacheOptions);
    get(key: string): T | undefined;
    has(key: string): boolean;
    set(key: string, value: T): void;
    delete(key: string): boolean;
    deleteByPrefix(prefix: string): number;
    clear(): void;
    get size(): number;
    entries(): IterableIterator<[string, T]>;
    sweep(): number;
    stats(): CacheStats;
    destroy(): void;
    private evictLRU;
}
export declare function createTTLCache<T>(opts?: TTLCacheOptions): TTLCache<T>;
