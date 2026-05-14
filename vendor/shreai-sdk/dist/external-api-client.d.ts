export type AuthType = 'bearer' | 'api-key' | 'basic' | 'none';
export type ApiHealth = 'healthy' | 'degraded' | 'down' | 'rate-limited';
export interface ApiProviderConfig {
    name: string;
    baseUrl: string;
    auth: {
        type: AuthType;
        keys?: string[];
        headerName?: string;
    };
    rateLimit?: {
        rpm: number;
    };
    cacheTtlMs?: number;
    timeoutMs?: number;
    retries?: number;
}
export interface ExternalApiClient {
    register(provider: ApiProviderConfig): void;
    get<T = unknown>(provider: string, path: string, params?: Record<string, string>): Promise<T>;
    post<T = unknown>(provider: string, path: string, body: unknown): Promise<T>;
    getHealth(provider?: string): Record<string, ApiHealth>;
    getStats(): Record<string, {
        requests: number;
        errors: number;
        avgLatencyMs: number;
        cacheHits: number;
    }>;
    clearCache(provider?: string): void;
}
export declare function createExternalApiClient(serviceName: string, options?: {
    cacheMaxSize?: number;
}): ExternalApiClient;
