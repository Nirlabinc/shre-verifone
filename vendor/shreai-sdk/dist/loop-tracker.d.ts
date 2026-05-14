export type SegmentName = 'intake' | 'trust_gate' | 'budget_check' | 'routing' | 'context_assembly' | 'compression' | 'inference' | 'tool_execution' | 'scoring' | 'learning' | 'delivery' | 'queue_wait' | 'classification' | 'dispatch' | 'spawn' | 'research' | 'planning' | 'implementation' | 'testing' | 'review' | 'commit' | 'fallback' | 'retry' | string;
export interface LoopSegment {
    name: SegmentName;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    attempt?: number;
    data?: Record<string, unknown>;
}
export interface LoopMark {
    name: string;
    ts: number;
    offsetMs: number;
}
export interface LoopRecord {
    loopId: string;
    correlationId: string;
    traceId?: string;
    service: string;
    agentId?: string;
    sessionId?: string;
    tenantId?: string;
    model?: string;
    requestType: 'chat' | 'task' | 'execute' | 'batch' | string;
    startedAt: string;
    endedAt?: string;
    totalMs?: number;
    status: 'open' | 'partial' | 'complete' | 'failed' | 'timeout';
    completionType?: 'streaming' | 'task_done' | 'batch_result' | 'tool_result';
    segments: LoopSegment[];
    marks: LoopMark[];
    breakdown?: SegmentBreakdown;
    quality?: number;
    tokensIn?: number;
    tokensOut?: number;
    partialCount: number;
    partials: Array<{
        ts: number;
        note: string;
    }>;
    error?: {
        message: string;
        segment?: string;
    };
}
export interface SegmentBreakdown {
    bySegment: Record<string, {
        totalMs: number;
        count: number;
        avgMs: number;
    }>;
    ttftMs?: number;
    timeToFirstPartialMs?: number;
    timeToCompleteMs?: number;
    pctBySegment: Record<string, number>;
    bottleneck: {
        segment: string;
        durationMs: number;
        pctOfTotal: number;
    };
}
export declare class Loop {
    private callbacks;
    private record;
    private currentSegment;
    private closed;
    constructor(service: string, opts: {
        correlationId?: string;
        traceId?: string;
        agentId?: string;
        sessionId?: string;
        tenantId?: string;
        model?: string;
        requestType: string;
        prompt?: string;
    }, callbacks: LoopCallbacks);
    get loopId(): string;
    get correlationId(): string;
    segment(name: SegmentName, data?: Record<string, unknown>): this;
    mark(name: string, _data?: Record<string, unknown>): this;
    partial(note: string): this;
    setModel(model: string): this;
    complete(opts?: {
        quality?: number;
        tokensIn?: number;
        tokensOut?: number;
        completionType?: LoopRecord['completionType'];
    }): LoopRecord;
    fail(error: string, segment?: string): LoopRecord;
    timeout(): LoopRecord;
    toRecord(): LoopRecord;
    private closeCurrentSegment;
    private computeBreakdown;
    private persist;
}
export interface LoopCallbacks {
    cortexWrite?: (dataType: string, data: Record<string, unknown>) => Promise<void>;
    publishFn?: (event: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    onComplete?: (record: LoopRecord) => void;
}
export interface LoopTracker {
    start(opts: {
        correlationId?: string;
        traceId?: string;
        agentId?: string;
        sessionId?: string;
        tenantId?: string;
        model?: string;
        requestType: string;
        prompt?: string;
    }): Loop;
}
export declare function createLoopTracker(service: string, callbacks?: LoopCallbacks): LoopTracker;
export declare function getRecentLoops(limit?: number): LoopRecord[];
export declare function getSlowLoops(limit?: number): LoopRecord[];
export declare function getLoopStats(): {
    total: number;
    complete: number;
    failed: number;
    partial: number;
    avgTotalMs: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    slowCount: number;
    avgPartialCount: number;
    byRequestType: Record<string, {
        count: number;
        avgMs: number;
        p95Ms: number | null;
    }>;
    bySegment: Record<string, {
        avgMs: number;
        p50Ms: number | null;
        p95Ms: number | null;
    }>;
    ttft: {
        avgMs: number;
        p50Ms: number | null;
        p95Ms: number | null;
    } | null;
};
export declare function getAgentLoopStats(agentId: string): {
    total: number;
    avgMs: number;
    p50Ms: number | null;
    p95Ms: number | null;
    avgPartialCount: number;
    topBottleneck: string | null;
} | null;
