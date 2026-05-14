import { type Logger } from './logger.js';
import { type CortexClient } from './cortex.js';
import type { EventBus } from './events.js';
export type ExecutionPhase = 'planned' | 'classified' | 'queued' | 'executing' | 'scoring' | 'completed' | 'failed' | 'retrying' | 'rejected';
export type ExecutionSubPhase = 'research' | 'planning' | 'implementation' | 'testing' | 'review' | 'commit' | 'delivery' | null;
export declare const SUB_PHASE_WEIGHTS: Record<Exclude<ExecutionSubPhase, null>, {
    start: number;
    end: number;
}>;
export declare const SUB_PHASE_ORDER: Exclude<ExecutionSubPhase, null>[];
export interface ExecutionRecord {
    taskId: string;
    agent: string;
    model: string;
    sessionId: string;
    title: string;
    phase: ExecutionPhase;
    subPhase: ExecutionSubPhase;
    traceId: string;
    parentTaskId?: string;
    progress: number;
    progressNote?: string;
    quality?: number;
    resultSummary?: string;
    retryCount: number;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    subPhaseTimestamps?: Record<string, string>;
    testResults?: TestResults;
    meta: Record<string, unknown>;
}
export interface TestResults {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
    framework?: string;
    output?: string;
    failures?: Array<{
        test: string;
        error: string;
    }>;
    ranAt: string;
}
export interface StartOptions {
    taskId: string;
    agent: string;
    model: string;
    sessionId: string;
    title: string;
    traceId?: string;
    parentTaskId?: string;
    meta?: Record<string, unknown>;
}
export interface CompleteOptions {
    quality?: number;
    resultSummary?: string;
}
export interface ExecutionTrackerOptions {
    eventBus?: EventBus;
    cortex?: CortexClient;
    qualityThreshold?: number;
    maxRetries?: number;
    logger?: Logger;
}
export interface ExecutionTracker {
    start(opts: StartOptions): Promise<ExecutionRecord>;
    transition(taskId: string, phase: ExecutionPhase, note?: string): Promise<void>;
    subTransition(taskId: string, subPhase: Exclude<ExecutionSubPhase, null>, note?: string): Promise<void>;
    reportTests(taskId: string, results: TestResults): Promise<void>;
    progress(taskId: string, ratio: number, note?: string): Promise<void>;
    complete(taskId: string, opts?: CompleteOptions): Promise<{
        accepted: boolean;
        phase: ExecutionPhase;
    }>;
    fail(taskId: string, reason: string): Promise<{
        willRetry: boolean;
        retryCount: number;
    }>;
    get(taskId: string): Promise<ExecutionRecord | null>;
    getActive(): Promise<ExecutionRecord[]>;
    getStuck(maxAgeMs: number): Promise<ExecutionRecord[]>;
    getTrace(traceId: string): Promise<ExecutionRecord[]>;
    remove(taskId: string): Promise<void>;
}
export declare function createExecutionTracker(serviceName: string, opts?: ExecutionTrackerOptions): ExecutionTracker;
