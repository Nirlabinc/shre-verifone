import { type Logger } from './logger.js';
export interface ConsistencyOptions {
    cortexUrl?: string;
    sampleSize?: number;
    publishFn?: (type: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    logger?: Logger;
    timeoutMs?: number;
}
export interface ConsistencyReport {
    checkedAt: string;
    sampled: number;
    matched: number;
    missing: number;
    missingIds: string[];
    driftRate: number;
    durationMs: number;
}
export interface ConsistencyChecker {
    check(dataType?: string): Promise<ConsistencyReport>;
    reindexMissing(ids: string[]): Promise<{
        reindexed: number;
        failed: number;
    }>;
}
export declare function createConsistencyChecker(service: string, opts?: ConsistencyOptions): ConsistencyChecker;
