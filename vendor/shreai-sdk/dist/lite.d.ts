import { type Logger } from './logger.js';
import type { CortexClient, CortexClientOptions } from './cortex.js';
import type { EventBus } from './events.js';
interface LiteCortexOptions extends CortexClientOptions {
    maxRecordsPerType?: number;
    persistPath?: string;
}
export declare function createLiteCortexClient(serviceName: string, opts?: LiteCortexOptions): CortexClient;
interface LiteEventBusOptions {
    logger?: Logger;
    maxBufferSize?: number;
}
export declare function createLiteEventBus(serviceName: string, opts?: LiteEventBusOptions): EventBus;
export type ShreTier = 'lite' | 'standard' | 'edge';
export declare function detectTier(): ShreTier;
export declare function isLiteTier(): boolean;
export {};
