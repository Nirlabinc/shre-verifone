import { type Logger } from './logger.js';
import type { EventBus } from './events.js';
import type { VectorlessRAG } from './vectorless-rag.js';
export declare function getRAGMetrics(): {
    hitRate: number;
    avgLatencyMs: number;
    totalQueries: number;
    hits: number;
    misses: number;
    errors: number;
    totalLatencyMs: number;
    lastError: string | null;
    lastErrorTime: string | null;
};
export type InsightImportance = 'high' | 'medium' | 'low';
export interface RAGInsight {
    text: string;
    importance: InsightImportance;
    confidence: number;
    source: 'conversation';
    verified: false;
}
export interface RAGClientOptions {
    url?: string;
    timeoutMs?: number;
    threshold?: number;
    rerank?: boolean;
    logger?: Logger;
    eventBus?: EventBus;
}
export interface ScoredResult {
    content: string;
    score: number;
    rerankScore?: number;
    source: string;
}
export interface RAGClient {
    retrieve(query: string, tenantId: string, limit?: number): Promise<string[] | null>;
    retrieveWithScores(query: string, tenantId: string, limit?: number): Promise<Array<{
        content: string;
        score: number;
    }> | null>;
    search(query: string, tenantId: string, limit?: number): Promise<ScoredResult[] | null>;
    recallMemory(agentId: string, query: string, limit?: number): Promise<string[] | null>;
    storeMemory(agentId: string, fact: string, category?: string, importance?: InsightImportance): Promise<boolean>;
    ingest(title: string, content: string, tenantId: string | null, meta?: Record<string, unknown>): Promise<boolean>;
    healthy(): Promise<boolean>;
}
export interface RAGMiddlewareOptions {
    sources?: Array<'vectors' | 'memory' | 'custom' | 'keyword'>;
    timeoutMs?: number;
    customSource?: (query: string, tenantId: string) => Promise<string | null>;
    keywordSource?: VectorlessRAG;
    logger?: Logger;
    eventBus?: EventBus;
}
export interface RAGMiddleware {
    enrich(query: string, tenantId: string, agentId: string): Promise<string | null>;
}
export interface ConversationLearnerOptions {
    minResponseLength?: number;
    dedupThreshold?: number;
    logger?: Logger;
    eventBus?: EventBus;
}
export interface ConversationLearner {
    learn(userText: string, assistantText: string, tenantId: string, agentId: string): Promise<void>;
}
export declare function createRAGClient(serviceName: string, opts?: RAGClientOptions): RAGClient;
export declare function createRAGMiddleware(serviceName: string, opts?: RAGMiddlewareOptions): RAGMiddleware;
export declare function createConversationLearner(serviceName: string, opts?: ConversationLearnerOptions): ConversationLearner;
