import { type Logger } from './logger.js';
import type { EventSeverity } from './types.js';
export type ErrorCategory = 'infrastructure' | 'connectivity' | 'auth' | 'routing' | 'data' | 'agent' | 'business' | 'external' | 'unknown';
export type ErrorSeverity = 'fatal' | 'error' | 'warn';
export type FixType = 'restart' | 'config_change' | 'dependency_fix' | 'resource_cleanup' | 'code_change' | 'key_reset' | 'escalate';
export type RemediationAction = 'retry' | 'retry-backoff' | 'escalate' | 'block' | 'wait-retry';
export interface RemediationConfig {
    action: RemediationAction;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    waitMs?: number;
    escalateTo?: string;
}
export interface ErrorDefinition {
    code: string;
    category: ErrorCategory;
    title: string;
    signature: RegExp;
    severity: ErrorSeverity;
    autoRemediable: boolean;
    defaultFix: string;
    fixType: FixType;
    remediationConfig?: RemediationConfig;
}
export interface PlatformError {
    code: string;
    category: ErrorCategory;
    title: string;
    service: string;
    message: string;
    severity: ErrorSeverity;
    context: Record<string, unknown>;
    correlationId: string;
    timestamp: string;
    stack?: string;
    autoRemediable: boolean;
    defaultFix: string;
    remediation?: RemediationConfig;
}
export interface Resolution {
    resolvedBy: string;
    strategy: FixType | string;
    description: string;
    durationMs: number;
    success: boolean;
    taskId?: string;
}
export interface ErrorStats {
    totalCaptured: number;
    byCode: Record<string, number>;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    resolutions: {
        total: number;
        successful: number;
        failed: number;
    };
    topUnresolved: Array<{
        code: string;
        count: number;
        lastSeen: string;
    }>;
}
export declare const ErrorCatalog: ReadonlyMap<string, ErrorDefinition>;
export declare function getErrorDefinition(code: string): ErrorDefinition | undefined;
export declare function listErrorCodes(): ErrorDefinition[];
export declare function classifyError(message: string): ErrorDefinition;
export declare function getRemediation(error: PlatformError | string): RemediationConfig;
export interface ErrorInterceptorOptions {
    publishFn?: (type: string, severity: EventSeverity, data: Record<string, unknown>) => Promise<void>;
    cortexWrite?: (dataType: string, payload: Record<string, unknown>) => Promise<boolean>;
    logger?: Logger;
    autoCreateTask?: boolean;
    createIssue?: (opts: {
        tag: string;
        title: string;
        description?: string;
        priority?: string;
        category?: string;
    }) => Promise<string | null>;
    resolveIssue?: (tag: string, reason: string) => Promise<boolean>;
    dedupWindowMs?: number;
}
export interface ErrorInterceptor {
    capture(message: string, context?: Record<string, unknown>, error?: Error): PlatformError;
    captureWithCode(code: string, message: string, context?: Record<string, unknown>, error?: Error): PlatformError;
    recordResolution(code: string, resolution: Resolution): Promise<void>;
    resolve(code: string, reason: string): Promise<void>;
    stats(): ErrorStats;
    recent(limit?: number): PlatformError[];
    resolutions(code: string): Resolution[];
}
export declare function createErrorInterceptor(service: string, opts?: ErrorInterceptorOptions): ErrorInterceptor;
export interface ErrorMiddlewareOptions extends ErrorInterceptorOptions {
    includeStack?: boolean;
}
export declare function createErrorMiddleware(service: string, opts?: ErrorMiddlewareOptions): (err: Error, _req: unknown, res: {
    status: (code: number) => {
        json: (body: unknown) => void;
    };
    headersSent?: boolean;
}, next: (err?: Error) => void) => void;
export interface ErrorAnalysis {
    topErrors: Array<{
        code: string;
        title: string;
        count: number;
        category: ErrorCategory;
        severity: ErrorSeverity;
        lastSeen: string;
        firstSeen: string;
        trend: 'rising' | 'stable' | 'declining';
        avgIntervalMs: number;
    }>;
    rootCauses: Array<{
        code: string;
        rootCause: string;
        confidence: number;
        evidence: string[];
        suggestedFix: string;
        fixType: FixType;
        relatedErrors: string[];
    }>;
    clusters: Array<{
        name: string;
        errors: string[];
        correlation: number;
        likelyRootCause: string;
    }>;
    healthScore: number;
    analyzedAt: string;
}
export interface AIAnalysisOptions {
    aiCall?: (prompt: string, systemPrompt: string) => Promise<string>;
    cortexSearch?: (query: string, limit: number) => Promise<Array<{
        content: string;
        score: number;
    }>>;
}
export declare function analyzeErrors(interceptor: ErrorInterceptor, _opts?: AIAnalysisOptions): ErrorAnalysis;
export declare function analyzeErrorsWithAI(interceptor: ErrorInterceptor, opts: AIAnalysisOptions): Promise<ErrorAnalysis>;
export declare function generateErrorTasks(analysis: ErrorAnalysis): Array<{
    tag: string;
    title: string;
    description: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
    category: string;
    errorCode: string;
}>;
export declare function withErrorCapture<T>(interceptor: ErrorInterceptor, context?: Record<string, unknown>): (fn: () => Promise<T>) => Promise<T | null>;
