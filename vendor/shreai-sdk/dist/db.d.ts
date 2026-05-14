import pg from 'pg';
export interface DBConfig {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    vaultKey?: string;
    replicaHost?: string;
    replicaPort?: number;
    maxConnections?: number;
    maxQueue?: number;
    service?: string;
    ssl?: boolean | pg.ConnectionConfig['ssl'];
}
export declare class ReadWritePool {
    private primaryPool;
    private replicaPool;
    private bulkhead;
    private resilience;
    private service;
    constructor(config: DBConfig);
    query<T extends pg.QueryResultRow = any>(text: string, params?: any[], options?: {
        usePrimary?: boolean;
        retries?: number;
    }): Promise<pg.QueryResult<T>>;
    getOne<T extends pg.QueryResultRow = any>(text: string, params?: any[], options?: {
        usePrimary?: boolean;
    }): Promise<T | null>;
    getMany<T extends pg.QueryResultRow = any>(text: string, params?: any[], options?: {
        usePrimary?: boolean;
    }): Promise<T[]>;
    healthy(): Promise<boolean>;
    shutdown(): Promise<void>;
}
export declare function createReadWritePool(config: DBConfig): ReadWritePool;
