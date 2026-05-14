import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from './logger.js';
import { createLamportClock } from './lamport-clock.js';
export function createLiteCortexClient(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const maxRecords = opts.maxRecordsPerType ?? 10_000;
    const store = new Map();
    if (opts.persistPath) {
        try {
            const data = JSON.parse(readFileSync(opts.persistPath, 'utf-8'));
            for (const [key, records] of Object.entries(data)) {
                store.set(key, records);
            }
            log.info('Loaded persisted lite store', {
                path: opts.persistPath,
                types: Object.keys(data).length,
            });
        }
        catch (err) {
            log.debug('[lite] Persist file not found or corrupt, starting fresh', {
                error: err.message,
            });
        }
    }
    function persist() {
        if (!opts.persistPath)
            return;
        try {
            mkdirSync(dirname(opts.persistPath), { recursive: true });
            const obj = {};
            for (const [key, records] of store) {
                obj[key] = records;
            }
            writeFileSync(opts.persistPath, JSON.stringify(obj), 'utf-8');
        }
        catch (err) {
            log.warn('Failed to persist lite store', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    function getRecords(dataType) {
        if (!store.has(dataType))
            store.set(dataType, []);
        return store.get(dataType);
    }
    return {
        async write(dataType, payload, options) {
            const records = getRecords(dataType);
            records.push({
                ...payload,
                _id: randomUUID(),
                _dataType: dataType,
                _createdAt: new Date().toISOString(),
                _correlationId: options?.correlationId,
                _tenantId: options?.tenantId,
            });
            if (records.length > maxRecords) {
                records.splice(0, records.length - maxRecords);
            }
            persist();
            return true;
        },
        async writeBatch(records, options) {
            let succeeded = 0;
            for (const rec of records) {
                const ok = await this.write(rec.dataType, rec.payload, options);
                if (ok)
                    succeeded++;
            }
            return { succeeded, failed: records.length - succeeded };
        },
        async query(dataType, filters, options) {
            let records = [...getRecords(dataType)];
            if (filters) {
                records = records.filter((rec) => {
                    return Object.entries(filters).every(([key, val]) => rec[key] === val);
                });
            }
            if (options?.orderBy) {
                const field = options.orderBy;
                const asc = options.order !== 'desc';
                records.sort((a, b) => {
                    const av = a[field], bv = b[field];
                    if (av === bv)
                        return 0;
                    if (av == null)
                        return 1;
                    if (bv == null)
                        return -1;
                    return (av < bv ? -1 : 1) * (asc ? 1 : -1);
                });
            }
            const total = records.length;
            const offset = options?.offset ?? 0;
            const limit = options?.limit ?? 100;
            const sliced = records.slice(offset, offset + limit);
            return { data: sliced, total, cached: false };
        },
        async search(query, options) {
            const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
            const limit = options?.limit ?? 10;
            let allRecords = [];
            if (options?.dataType) {
                allRecords = getRecords(options.dataType);
            }
            else {
                for (const records of store.values()) {
                    allRecords.push(...records);
                }
            }
            const scored = allRecords.map((rec) => {
                const text = JSON.stringify(rec).toLowerCase();
                const matches = keywords.filter((kw) => text.includes(kw));
                const score = keywords.length > 0 ? matches.length / keywords.length : 0;
                return { record: rec, score };
            });
            const minScore = options?.minScore ?? 0.3;
            const results = scored
                .filter((s) => s.score >= minScore)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)
                .map((s) => ({
                data: s.record,
                score: s.score,
                dataType: s.record._dataType ?? 'unknown',
            }));
            return { results };
        },
        async healthy() {
            return true;
        },
        circuitState() {
            return { state: 'closed', failures: 0, name: `lite-cortex-${serviceName}` };
        },
        isDegraded() {
            return false;
        },
        spilloverStats() {
            return { degraded: false, degradedSince: null, bytes: 0, rotatedBytes: 0, path: '' };
        },
        async shutdown() {
        },
    };
}
export function createLiteEventBus(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const maxBuffer = opts.maxBufferSize ?? 1_000;
    const handlers = new Map();
    const buffer = [];
    const liteClock = createLamportClock(serviceName);
    let isShutdown = false;
    function matchPattern(pattern, type) {
        if (pattern === '*')
            return true;
        if (pattern.endsWith('.*')) {
            return type.startsWith(pattern.slice(0, -1));
        }
        return pattern === type;
    }
    return {
        async publish(type, severity, data, _correlationId) {
            if (isShutdown)
                return;
            const event = {
                id: randomUUID(),
                source: serviceName,
                type,
                severity,
                data,
                ts: new Date().toISOString(),
            };
            buffer.push(event);
            if (buffer.length > maxBuffer) {
                buffer.splice(0, buffer.length - maxBuffer);
            }
            for (const [pattern, handlerSet] of handlers) {
                if (matchPattern(pattern, type)) {
                    for (const handler of handlerSet) {
                        try {
                            await handler(event);
                        }
                        catch (err) {
                            log.warn('Lite event handler error', {
                                type,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }
                }
            }
        },
        subscribe(typePattern, handler) {
            if (!handlers.has(typePattern)) {
                handlers.set(typePattern, new Set());
            }
            handlers.get(typePattern).add(handler);
            return () => {
                const set = handlers.get(typePattern);
                if (set) {
                    set.delete(handler);
                    if (set.size === 0)
                        handlers.delete(typePattern);
                }
            };
        },
        async broadcast(type, severity, data) {
            await this.publish(type, severity, data);
        },
        connected() {
            return !isShutdown;
        },
        bufferSize() {
            return buffer.length;
        },
        async shutdown() {
            isShutdown = true;
            handlers.clear();
            log.info('Lite event bus shut down');
        },
        async publishPriority(type, severity, _priority, data, correlationId) {
            await this.publish(type, severity, data, correlationId);
        },
        createCancellationToken(correlationId) {
            const callbacks = new Set();
            let cancelled = false;
            return {
                id: `cancel:${correlationId}:${randomUUID().slice(0, 8)}`,
                cancel(reason) {
                    cancelled = true;
                    const dummyEvent = {
                        id: randomUUID().slice(0, 12),
                        source: serviceName,
                        type: 'cancel.operations',
                        severity: 'warning',
                        data: { reason, correlationId },
                        ts: new Date().toISOString(),
                    };
                    for (const cb of callbacks) {
                        try {
                            cb(reason, dummyEvent);
                        }
                        catch {
                        }
                    }
                },
                onCancel(cb) {
                    callbacks.add(cb);
                },
                isCancelled() {
                    return cancelled;
                },
            };
        },
        async cancelCorrelated(correlationId, reason) {
            log.info('Lite cancelCorrelated (no-op broadcast)', { correlationId, reason });
            await this.publish('cancel.operations', 'critical', { reason, correlationId }, correlationId);
        },
        clock: () => liteClock,
        walStats: () => ({
            pendingCount: 0,
            lastReplayAt: null,
            lastReplayResult: { replayed: 0, failed: 0 },
        }),
        metrics: () => ({
            published: 0,
            delivered: 0,
            dlq: 0,
            dedupSkipped: 0,
            bufferSize: 0,
        }),
    };
}
export function detectTier() {
    const tier = process.env.SHRE_TIER?.toLowerCase();
    if (tier === 'lite' || tier === 'edge')
        return tier;
    return 'standard';
}
export function isLiteTier() {
    return detectTier() === 'lite';
}
