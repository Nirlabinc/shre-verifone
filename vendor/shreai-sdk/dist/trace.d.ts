export interface TraceSpan {
    name: string;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    status: 'ok' | 'error' | 'skipped';
    data?: Record<string, unknown>;
    error?: {
        message: string;
        stack?: string;
        code?: string;
    };
    ack?: {
        received: boolean;
        ackId?: string;
        ackedAt?: number;
        ackLatencyMs?: number;
        source?: string;
    };
}
export interface TraceRecord {
    traceId: string;
    correlationId: string;
    service: string;
    startedAt: string;
    endedAt?: string;
    totalMs?: number;
    status: 'ok' | 'error' | 'partial';
    spans: TraceSpan[];
    request?: {
        method?: string;
        path?: string;
        agentId?: string;
        tenantId?: string;
        model?: string;
        promptLen?: number;
    };
    failure?: {
        spanName: string;
        error: string;
        errorCode?: string;
        suggestion?: string;
    };
    ackSummary?: {
        total: number;
        acked: number;
        unacked: number;
        gaps: string[];
    };
}
export interface TraceOptions {
    tasksUrl?: string;
    autoCreateTasks?: boolean;
    cortexWrite?: (dataType: string, data: Record<string, unknown>) => Promise<void>;
    publishFn?: (event: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    onComplete?: (trace: TraceRecord) => void;
    dedupWindowMs?: number;
}
export declare function getRecentTraces(limit?: number): TraceRecord[];
export declare function getRecentFailures(limit?: number): TraceRecord[];
export declare function getTraceStats(): {
    total: number;
    failures: number;
    recentFailureRate: number;
    avgDurationMs: number;
    topFailingSpans: Array<{
        span: string;
        count: number;
    }>;
};
export declare class Trace {
    readonly traceId: string;
    readonly correlationId: string;
    readonly service: string;
    private _startedAt;
    private _spans;
    private _currentSpan;
    private _request;
    private _opts;
    private _completed;
    constructor(service: string, correlationId?: string, opts?: TraceOptions);
    setRequest(meta: TraceRecord['request']): this;
    span(name: string, data?: Record<string, unknown>): this;
    fail(spanNameOrError: string | Error, errorOrData?: Error | Record<string, unknown>, data?: Record<string, unknown>): this;
    skip(spanName: string, reason?: string): this;
    ack(spanName: string, opts?: {
        ackId?: string;
        source?: string;
    }): this;
    getAckGaps(): string[];
    end(): TraceRecord;
    endWithError(spanName?: string, error?: Error, extraData?: Record<string, unknown>): TraceRecord;
    private _complete;
    private _asyncComplete;
    private _createFailureTask;
    toRecord(): TraceRecord;
}
export declare function createTrace(service: string, correlationId?: string, opts?: TraceOptions): Trace;
export declare function createTraceDefaults(config: {
    cortexWrite?: TraceOptions['cortexWrite'];
    publishFn?: TraceOptions['publishFn'];
    tasksUrl?: string;
    autoCreateTasks?: boolean;
}): TraceOptions;
export declare function createTraceMiddleware(service: string, opts?: TraceOptions): (...args: any[]) => any;
export declare function traceContextHeaders(trace: Trace): Record<string, string>;
export declare function getAckGaps(limit?: number): Array<{
    traceId: string;
    service: string;
    gaps: string[];
    ts: string;
}>;
export declare function getAckStats(): {
    totalTraces: number;
    fullyAcked: number;
    partialAck: number;
    noAck: number;
    topGapSpans: Array<{
        span: string;
        count: number;
    }>;
};
