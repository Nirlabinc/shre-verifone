import { type Logger } from './logger.js';
import type { EventBus } from './events.js';
export interface BM25Config {
    k1: number;
    b: number;
}
export interface VectorlessRAGOptions {
    cortexUrl?: string;
    dataTypes?: string[];
    refreshIntervalMs?: number;
    maxDocsPerType?: number;
    bm25?: Partial<BM25Config>;
    logger?: Logger;
    eventBus?: EventBus;
    scoreMultiplier?: number;
}
export interface KeywordResult {
    content: string;
    score: number;
    source: string;
    docId: string;
}
export interface VectorlessRAGStats {
    totalDocs: number;
    totalTerms: number;
    avgDocLength: number;
    lastRefreshAt: string | null;
    indexSizeEstimate: number;
}
export interface VectorlessRAG {
    search(query: string, tenantId?: string, limit?: number): KeywordResult[];
    refresh(): Promise<{
        docsIndexed: number;
        terms: number;
        latencyMs: number;
    }>;
    stats(): VectorlessRAGStats;
    ingest(docId: string, content: string, source?: string, tenantId?: string): void;
    shutdown(): void;
}
export declare function createVectorlessRAG(serviceName: string, opts?: VectorlessRAGOptions): VectorlessRAG;
