export interface OllamaFallbackConfig {
    enabled: boolean;
    host: string;
    port: number;
    defaultModel: string;
    healthCacheTtlMs: number;
}
export interface RouterChatOptions {
    model?: string;
    stream?: false;
    maxTokens?: number;
    budget?: 'cheap' | 'standard' | 'premium';
    systemPrompt?: string;
    taskType?: string;
    tenantId?: string;
    tools?: unknown[];
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface RouterChatResult {
    text: string;
    model?: string;
    gate?: string;
    cacheHit?: boolean;
    raw: unknown;
}
export declare function createRouterClient(agentId: string, opts?: {
    routerUrl?: string;
    maxRetries?: number;
    ollamaFallback?: Partial<OllamaFallbackConfig> | false;
}): {
    chat: (input: string | Array<{
        role: string;
        content: unknown;
    }>, options?: RouterChatOptions) => Promise<RouterChatResult>;
    parseResponse: (data: any) => string;
};
