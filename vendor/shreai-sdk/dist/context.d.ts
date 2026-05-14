export interface ContextRequest {
    agentId?: string;
    tenantId?: string;
    prompt?: string;
    layers?: string[];
    format?: 'structured' | 'prompt';
    messageCount?: number;
}
export interface ContextLayer {
    name: string;
    content: string;
    length: number;
    latencyMs: number;
    error?: string;
}
export interface ContextPackage {
    layers: ContextLayer[];
    injection: string;
    totalLatencyMs: number;
    requestedLayers: string[];
    healthReport: string;
    contextHealth: Record<string, 'ok' | 'missing' | 'partial' | 'error'>;
    meta: {
        soulMode: string;
        agentId: string | null;
        tenantId: string | null;
        platformDetected: string | null;
        totalChars: number;
        timestamp: string;
        serviceHealth?: Record<string, 'healthy' | 'degraded' | 'down'>;
        rateLimitState?: {
            rpm: number;
            remaining: number;
            resetAt: string;
        };
        budgetRemaining?: {
            amount: number;
            currency: string;
            period: string;
        };
    };
}
export declare function fetchContext(req: ContextRequest): Promise<ContextPackage>;
export declare function getContextInjection(agentId?: string, prompt?: string, tenantId?: string): Promise<string>;
