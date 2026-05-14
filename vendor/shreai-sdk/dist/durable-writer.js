import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createLogger } from './logger.js';
import { infraUrl } from './discovery.js';
const BACKOFF_MS = [30_000, 60_000, 120_000];
export function createDurableWriter(name, options = {}) {
    const walDir = options.walDir ?? join(homedir(), '.shre', 'wal');
    const cortexUrl = options.cortexUrl ?? infraUrl('cortexdb');
    const drainIntervalMs = options.drainIntervalMs ?? 30_000;
    const maxRetries = options.maxRetries ?? 3;
    const batchSize = options.batchSize ?? 50;
    const log = options.logger ?? createLogger(`durable-writer:${name}`);
    const walPath = join(walDir, `${name}.jsonl`);
    const lockPath = join(walDir, `${name}.lock`);
    let pendingCount = 0;
    let drainedCount = 0;
    let errorCount = 0;
    let lastDrainAt = null;
    let drainTimer = null;
    let draining = false;
    let stopped = false;
    let dirReady = false;
    let eventBusPromise = null;
    async function ensureDir() {
        if (dirReady)
            return;
        await mkdir(walDir, { recursive: true });
        dirReady = true;
    }
    async function acquireLock() {
        try {
            try {
                const lockContent = await readFile(lockPath, 'utf-8');
                const lockPid = parseInt(lockContent.trim(), 10);
                if (lockPid && !isProcessAlive(lockPid)) {
                    await unlink(lockPath).catch(() => { });
                }
                else {
                    return null;
                }
            }
            catch (err) {
            }
            await writeFile(lockPath, String(process.pid), { flag: 'wx' });
            return async () => {
                await unlink(lockPath).catch(() => { });
            };
        }
        catch (err) {
            log.debug('[durable-writer] Lock acquisition failed (race condition)', {
                error: err.message,
            });
            return null;
        }
    }
    function isProcessAlive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (err) {
            return false;
        }
    }
    async function appendToWAL(entry) {
        await ensureDir();
        const line = JSON.stringify(entry) + '\n';
        await appendFile(walPath, line, 'utf-8');
    }
    async function readWAL() {
        try {
            await stat(walPath);
        }
        catch (err) {
            return [];
        }
        const entries = [];
        const stream = createReadStream(walPath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                entries.push(JSON.parse(trimmed));
            }
            catch (err) {
                log.warn('Corrupt WAL line, skipping', {
                    line: trimmed.slice(0, 100),
                    error: err.message,
                });
            }
        }
        return entries;
    }
    async function rewriteWAL(entries) {
        const tmpPath = walPath + '.tmp';
        if (entries.length === 0) {
            await unlink(walPath).catch(() => { });
            await unlink(tmpPath).catch(() => { });
            return;
        }
        const ws = createWriteStream(tmpPath, { encoding: 'utf-8' });
        for (const entry of entries) {
            ws.write(JSON.stringify(entry) + '\n');
        }
        await new Promise((resolve, reject) => {
            ws.end(() => resolve());
            ws.on('error', reject);
        });
        await rename(tmpPath, walPath);
    }
    async function sendToCortex(entry) {
        try {
            const resp = await fetch(`${cortexUrl}/v1/write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data_type: entry.dataType,
                    ...entry.payload,
                    _wal_id: entry.id,
                    _wal_actor: entry.actor,
                }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!resp.ok) {
                log.warn('CortexDB write rejected', {
                    status: resp.status,
                    walId: entry.id,
                    dataType: entry.dataType,
                });
                return false;
            }
            return true;
        }
        catch (err) {
            log.warn('CortexDB write failed', {
                walId: entry.id,
                dataType: entry.dataType,
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    }
    async function emitDegradation(entry) {
        try {
            if (!eventBusPromise) {
                eventBusPromise = import('./events.js');
            }
            const { createEventBus } = await eventBusPromise;
            const bus = createEventBus(`durable-writer:${name}`);
            await bus.publish('degradation.detected', 'critical', {
                source: `durable-writer:${name}`,
                walId: entry.id,
                dataType: entry.dataType,
                retries: entry.retries,
                message: `WAL entry exhausted ${maxRetries} retries — data may be lost`,
            });
            await bus.shutdown();
        }
        catch (err) {
            log.error('Failed to emit degradation event', {
                walId: entry.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    async function drain() {
        if (draining || stopped)
            return;
        draining = true;
        const unlock = await acquireLock();
        if (!unlock) {
            draining = false;
            return;
        }
        try {
            const entries = await readWAL();
            if (entries.length === 0) {
                draining = false;
                await unlock();
                return;
            }
            const now = Date.now();
            const ready = [];
            const notReady = [];
            for (const entry of entries) {
                if (entry.status !== 'pending') {
                    continue;
                }
                if (entry.retries > 0) {
                    const entryTs = new Date(entry.ts).getTime();
                    const backoffIdx = Math.min(entry.retries - 1, BACKOFF_MS.length - 1);
                    const backoffMs = BACKOFF_MS[backoffIdx];
                    if (now - entryTs < backoffMs) {
                        notReady.push(entry);
                        continue;
                    }
                }
                ready.push(entry);
                if (ready.length >= batchSize)
                    break;
            }
            const remaining = entries.filter((e) => e.status === 'pending' && !ready.includes(e) && !notReady.includes(e));
            const survivors = [...notReady, ...remaining];
            for (const entry of ready) {
                const ok = await sendToCortex(entry);
                if (ok) {
                    drainedCount++;
                    pendingCount = Math.max(0, pendingCount - 1);
                }
                else {
                    entry.retries++;
                    entry.ts = new Date().toISOString();
                    if (entry.retries >= maxRetries) {
                        entry.status = 'dead';
                        errorCount++;
                        pendingCount = Math.max(0, pendingCount - 1);
                        log.error('WAL entry exhausted retries — marking dead', {
                            walId: entry.id,
                            dataType: entry.dataType,
                            retries: entry.retries,
                        });
                        emitDegradation(entry).catch(() => { });
                        survivors.push(entry);
                    }
                    else {
                        survivors.push(entry);
                    }
                }
            }
            await rewriteWAL(survivors);
            lastDrainAt = new Date().toISOString();
            log.info('WAL drain cycle complete', {
                sent: ready.length - survivors.filter((s) => ready.includes(s)).length,
                retrying: survivors.filter((s) => s.status === 'pending').length,
                dead: survivors.filter((s) => s.status === 'dead').length,
            });
        }
        catch (err) {
            log.error('WAL drain error', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        finally {
            await unlock();
            draining = false;
        }
    }
    function startDrainWorker() {
        if (drainTimer)
            return;
        drainTimer = setInterval(() => {
            drain().catch((err) => {
                log.error('Drain worker unhandled error', {
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }, drainIntervalMs);
        if (drainTimer && typeof drainTimer === 'object' && 'unref' in drainTimer) {
            drainTimer.unref();
        }
    }
    ensureDir()
        .then(() => readWAL())
        .then((entries) => {
        pendingCount = entries.filter((e) => e.status === 'pending').length;
        if (pendingCount > 0) {
            log.info('WAL has pending entries from previous run', {
                pending: pendingCount,
            });
        }
    })
        .catch(() => {
    });
    startDrainWorker();
    return {
        async write(dataType, payload, actor) {
            if (stopped) {
                throw new Error('DurableWriter is shut down');
            }
            const entry = {
                id: randomUUID(),
                ts: new Date().toISOString(),
                dataType,
                payload,
                actor: actor ?? name,
                retries: 0,
                status: 'pending',
            };
            await appendToWAL(entry);
            pendingCount++;
        },
        getStats() {
            return {
                pending: pendingCount,
                drained: drainedCount,
                errors: errorCount,
                lastDrainAt,
            };
        },
        async shutdown() {
            stopped = true;
            if (drainTimer) {
                clearInterval(drainTimer);
                drainTimer = null;
            }
            log.info('DurableWriter shutting down — final drain');
            draining = false;
            await drain();
            log.info('DurableWriter shutdown complete', {
                pending: pendingCount,
                drained: drainedCount,
                errors: errorCount,
            });
        },
    };
}
