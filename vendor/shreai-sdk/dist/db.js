import pg from 'pg';
import { createLogger } from './logger.js';
import { Bulkhead, createResilience } from './resilience.js';
import { readVaultKey } from './auth.js';
const log = createLogger('shre-sdk:db');
const { Pool } = pg;
export class ReadWritePool {
    primaryPool;
    replicaPool = null;
    bulkhead;
    resilience;
    service;
    constructor(config) {
        this.service = config.service || 'unknown-service';
        const maxConns = config.maxConnections || 10;
        const maxQueue = config.maxQueue || 50;
        let password = config.password || process.env.PG_PASSWORD || '';
        if (config.vaultKey) {
            const vaultPass = readVaultKey(config.vaultKey);
            if (vaultPass)
                password = vaultPass;
        }
        const host = config.host || process.env.PG_HOST || '127.0.0.1';
        const port = config.port || Number(process.env.PG_PORT) || 5432;
        const dbName = config.database || process.env.PG_DATABASE || 'cortexdb';
        const user = config.user || process.env.PG_USER || 'cortex';
        const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(host);
        const defaultSsl = isLocal ? false : { rejectUnauthorized: false };
        const ssl = config.ssl !== undefined ? config.ssl : defaultSsl;
        this.primaryPool = new Pool({
            host,
            port,
            database: dbName,
            user,
            password,
            ssl,
            max: maxConns,
            idleTimeoutMillis: 30_000,
        });
        const replicaHost = config.replicaHost || process.env.PG_REPLICA_HOST;
        if (replicaHost) {
            log.info(`[db] Initializing read-only replica pool on ${replicaHost}`, {
                service: this.service,
            });
            this.replicaPool = new Pool({
                host: replicaHost,
                port: config.replicaPort || port,
                database: dbName,
                user,
                password,
                ssl: config.ssl !== undefined
                    ? config.ssl
                    : ['127.0.0.1', 'localhost', '::1'].includes(replicaHost)
                        ? false
                        : { rejectUnauthorized: false },
                max: maxConns,
                idleTimeoutMillis: 30_000,
            });
        }
        this.bulkhead = new Bulkhead(`${this.service}:db`, maxConns, { maxQueue });
        this.resilience = createResilience({
            service: `${this.service}:db`,
            defaults: {
                maxRetries: 3,
                baseDelayMs: 200,
                retryIf: (err) => {
                    const code = err.code || '';
                    return (code === 'ECONNREFUSED' ||
                        code === '57P01' ||
                        code === '57P03' ||
                        code === '40001' ||
                        code === '40P01');
                },
            },
        });
        this.primaryPool.on('error', (err) => log.error('[db] Primary pool error', { service: this.service }, err));
        this.replicaPool?.on('error', (err) => log.error('[db] Replica pool error', { service: this.service }, err));
    }
    async query(text, params, options = {}) {
        const isWrite = !/^\s*SELECT/i.test(text);
        const targetPool = isWrite || options.usePrimary || !this.replicaPool ? this.primaryPool : this.replicaPool;
        return this.resilience.wrap('query', () => this.bulkhead.execute(() => targetPool.query(text, params)), { maxRetries: options.retries });
    }
    async getOne(text, params, options = {}) {
        const res = await this.query(text, params, options);
        return res.rows[0] || null;
    }
    async getMany(text, params, options = {}) {
        const res = await this.query(text, params, options);
        return res.rows;
    }
    async healthy() {
        try {
            await this.primaryPool.query('SELECT 1');
            return true;
        }
        catch {
            return false;
        }
    }
    async shutdown() {
        await this.primaryPool.end();
        await this.replicaPool?.end();
    }
}
export function createReadWritePool(config) {
    return new ReadWritePool(config);
}
