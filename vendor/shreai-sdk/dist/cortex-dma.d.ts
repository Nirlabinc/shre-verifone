import { type Logger } from './logger.js';
export interface DMAQueryResult {
    rows: Record<string, unknown>[];
    rowCount: number;
    latencyMs: number;
}
export interface DMASearchResult {
    results: Array<{
        id?: string;
        text: string;
        score: number;
        metadata: Record<string, unknown>;
    }>;
    latencyMs: number;
}
export interface DMAStats {
    totalReads: number;
    totalSearches: number;
    avgLatencyMs: number;
    cacheHits: number;
    cacheMisses: number;
}
export interface CortexDMA {
    query(sql: string, params?: unknown[]): Promise<DMAQueryResult>;
    search(collection: string, query: string, limit?: number, minScore?: number): Promise<DMASearchResult>;
    redisGet(key: string): Promise<string | null>;
    redisGetMulti(keys: string[]): Promise<Map<string, string | null>>;
    stats(): DMAStats;
    isAllowed(): boolean;
}
export interface CortexDMAOptions {
    cortexUrl?: string;
    redisUrl?: string;
    logger?: Logger;
    cache?: boolean;
    cacheTtlMs?: number;
}
export declare function createCortexDMA(serviceName: string, opts?: CortexDMAOptions): CortexDMA;
