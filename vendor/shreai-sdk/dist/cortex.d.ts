import { type Logger } from './logger.js';
import type { CortexDataType, CortexQueryResponse, CortexSearchResponse } from './types.js';
export interface CortexClientOptions {
    url?: string;
    writeTimeoutMs?: number;
    queryTimeoutMs?: number;
    logger?: Logger;
    throwOnError?: boolean;
    circuitBreakerThreshold?: number;
    circuitBreakerResetMs?: number;
    durable?: boolean;
    useReadReplica?: boolean;
}
export interface CortexClient {
    write(dataType: CortexDataType, payload: Record<string, unknown>, options?: {
        correlationId?: string;
        tenantId?: string;
    }): Promise<boolean>;
    writeBatch(records: Array<{
        dataType: CortexDataType;
        payload: Record<string, unknown>;
    }>, options?: {
        correlationId?: string;
        tenantId?: string;
    }): Promise<{
        succeeded: number;
        failed: number;
    }>;
    query(dataType: CortexDataType, filters?: Record<string, unknown>, options?: {
        limit?: number;
        offset?: number;
        orderBy?: string;
        order?: 'asc' | 'desc';
        correlationId?: string;
    }): Promise<CortexQueryResponse | null>;
    search(query: string, options?: {
        dataType?: CortexDataType;
        limit?: number;
        minScore?: number;
        correlationId?: string;
    }): Promise<CortexSearchResponse | null>;
    healthy(): Promise<boolean>;
    circuitState(): {
        state: 'closed' | 'open' | 'half-open';
        failures: number;
        name: string;
    };
    isDegraded(): boolean;
    spilloverStats(): {
        degraded: boolean;
        degradedSince: string | null;
        bytes: number;
        rotatedBytes: number;
        path: string;
    };
    shutdown(): Promise<void>;
}
export declare function isCortexDegraded(): boolean;
export declare function createCortexClient(serviceName: string, opts?: CortexClientOptions): CortexClient;
export interface BufferedWriterOptions {
    flushIntervalMs?: number;
    maxBufferSize?: number;
    logger?: Logger;
}
export interface BufferedWriter {
    queue(dataType: CortexDataType, payload: Record<string, unknown>, options?: {
        correlationId?: string;
        tenantId?: string;
    }): void;
    flush(): Promise<{
        succeeded: number;
        failed: number;
    }>;
    shutdown(): Promise<void>;
    pending(): number;
}
export declare function createBufferedWriter(client: CortexClient, opts?: BufferedWriterOptions): BufferedWriter;
