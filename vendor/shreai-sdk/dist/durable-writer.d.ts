import { type Logger } from './logger.js';
export interface DurableWriterOptions {
    walDir?: string;
    cortexUrl?: string;
    drainIntervalMs?: number;
    maxRetries?: number;
    batchSize?: number;
    logger?: Logger;
}
export interface DurableWriter {
    write(dataType: string, payload: Record<string, unknown>, actor?: string): Promise<void>;
    getStats(): DurableWriterStats;
    shutdown(): Promise<void>;
}
export interface DurableWriterStats {
    pending: number;
    drained: number;
    errors: number;
    lastDrainAt: string | null;
}
export declare function createDurableWriter(name: string, options?: DurableWriterOptions): DurableWriter;
