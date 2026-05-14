import { type Logger } from './logger.js';
export declare function resolveRedisPassword(explicit?: string): string | undefined;
export declare function resolveRedisUrl(opts?: {
    host?: string;
    port?: number;
    password?: string;
}): string;
export interface RedisClientOptions {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    lazyConnect?: boolean;
    maxRetriesPerRequest?: number | null;
    retryStrategy?: (times: number) => number | null;
    connectTimeout?: number;
    logger?: Logger;
}
export declare function createRedisClient(serviceName: string, opts?: RedisClientOptions): Promise<any>;
export declare function createRedisClientPair(serviceName: string, opts?: RedisClientOptions): Promise<{
    writeClient: any;
    readClient: any;
    subClient: any;
}>;
