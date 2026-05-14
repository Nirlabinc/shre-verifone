import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { infraUrl } from './discovery.js';
import { createLogger } from './logger.js';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { createDurableWriter } from './durable-writer.js';
let _globalDegraded = false;
export function isCortexDegraded() {
    return _globalDegraded;
}
export function createCortexClient(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const writeTimeout = opts.writeTimeoutMs ?? 5000;
    const queryTimeout = opts.queryTimeoutMs ?? 10000;
    const throwOnError = opts.throwOnError ?? false;
    const breaker = new CircuitBreaker({
        name: `cortex-${serviceName}`,
        failureThreshold: opts.circuitBreakerThreshold ?? 5,
        resetTimeout: opts.circuitBreakerResetMs ?? 30_000,
        timeout: queryTimeout,
    });
    let durableWriter = null;
    if (opts.durable !== false) {
        try {
            durableWriter = createDurableWriter(serviceName, {
                cortexUrl: opts.url,
                logger: log,
            });
        }
        catch (err) {
            log.warn('Durable writer init failed — writes will not be buffered on failure', {
                error: err.message,
            });
        }
    }
    let _degraded = false;
    let _degradedSince = null;
    const SPILL_DIR = join(homedir(), '.shre', 'cortex-spill');
    const SPILL_PATH = join(SPILL_DIR, `${serviceName}-pending.jsonl`);
    const HEALTH_CHECK_INTERVAL_MS = 30_000;
    const SPILL_SOFT_CAP_BYTES = 50 * 1024 * 1024;
    const SPILL_HARD_CAP_BYTES = 200 * 1024 * 1024;
    let _spillFd = null;
    let _spillSize = 0;
    function enterDegradedMode() {
        if (!_degraded) {
            _degraded = true;
            _globalDegraded = true;
            _degradedSince = new Date().toISOString();
            log.warn('[cortex] Entering degraded mode — reads return null, writes spill to disk');
        }
    }
    function exitDegradedMode() {
        if (_degraded) {
            _degraded = false;
            _globalDegraded = false;
            const duration = _degradedSince
                ? `${Math.round((Date.now() - new Date(_degradedSince).getTime()) / 1000)}s`
                : 'unknown';
            _degradedSince = null;
            log.info('[cortex] CortexDB recovered — exiting degraded mode', { degradedFor: duration });
        }
    }
    function closeSpillFd() {
        if (_spillFd !== null) {
            try {
                closeSync(_spillFd);
            }
            catch {
            }
            _spillFd = null;
        }
    }
    function rotateSpill() {
        closeSpillFd();
        try {
            if (existsSync(SPILL_PATH)) {
                const rotated = SPILL_PATH + '.1';
                if (existsSync(rotated)) {
                    unlinkSync(rotated);
                }
                renameSync(SPILL_PATH, rotated);
                log.warn('[cortex] Spillover rotated — soft cap hit', {
                    softCapBytes: SPILL_SOFT_CAP_BYTES,
                });
            }
        }
        catch (err) {
            log.error('[cortex] Spillover rotation failed', { error: err.message });
        }
        _spillSize = 0;
    }
    function enforceHardCap() {
        try {
            const rotated = SPILL_PATH + '.1';
            const liveSize = existsSync(SPILL_PATH) ? statSync(SPILL_PATH).size : 0;
            const rotatedSize = existsSync(rotated) ? statSync(rotated).size : 0;
            if (liveSize + rotatedSize >= SPILL_HARD_CAP_BYTES) {
                closeSpillFd();
                if (existsSync(rotated))
                    unlinkSync(rotated);
                log.error('[cortex] Spillover hard cap hit — dropped oldest rotation', {
                    hardCapBytes: SPILL_HARD_CAP_BYTES,
                });
                return true;
            }
        }
        catch (err) {
            log.debug('[cortex] Hard-cap check failed', { error: err.message });
        }
        return false;
    }
    function spillWrite(entry) {
        try {
            mkdirSync(SPILL_DIR, { recursive: true });
            if (_spillFd === null) {
                try {
                    _spillSize = existsSync(SPILL_PATH) ? statSync(SPILL_PATH).size : 0;
                }
                catch {
                    _spillSize = 0;
                }
                _spillFd = openSync(SPILL_PATH, 'a');
            }
            const line = JSON.stringify(entry) + '\n';
            const bytes = Buffer.byteLength(line, 'utf-8');
            if (_spillSize + bytes > SPILL_SOFT_CAP_BYTES) {
                rotateSpill();
                enforceHardCap();
                _spillFd = openSync(SPILL_PATH, 'a');
                _spillSize = 0;
            }
            writeSync(_spillFd, line);
            _spillSize += bytes;
            log.debug('[cortex] Write spilled to disk', { dataType: entry.dataType });
        }
        catch (err) {
            closeSpillFd();
            log.error('[cortex] Spillover write failed — data may be lost', {
                dataType: entry.dataType,
                error: err.message,
            });
        }
    }
    function readSpillover() {
        const entries = [];
        for (const path of [SPILL_PATH + '.1', SPILL_PATH]) {
            try {
                if (!existsSync(path))
                    continue;
                const raw = readFileSync(path, 'utf-8');
                for (const line of raw.split('\n')) {
                    if (!line.trim())
                        continue;
                    try {
                        entries.push(JSON.parse(line));
                    }
                    catch {
                    }
                }
            }
            catch {
            }
        }
        return entries;
    }
    function truncateSpillover() {
        closeSpillFd();
        _spillSize = 0;
        try {
            if (existsSync(SPILL_PATH))
                writeFileSync(SPILL_PATH, '');
            const rotated = SPILL_PATH + '.1';
            if (existsSync(rotated))
                unlinkSync(rotated);
        }
        catch {
        }
    }
    async function drainSpillover() {
        const entries = readSpillover();
        if (entries.length === 0)
            return;
        log.info('[cortex] CortexDB recovered, draining spilled writes', { count: entries.length });
        let drained = 0;
        const failed = [];
        for (const entry of entries) {
            try {
                const url = getUrl();
                const res = await fetch(`${url}/v1/write`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(entry.correlationId && { 'X-Correlation-Id': entry.correlationId }),
                    },
                    body: JSON.stringify({
                        data_type: entry.dataType,
                        payload: entry.payload,
                        actor: entry.actor,
                        ...(entry.correlationId && { correlationId: entry.correlationId }),
                        ...(entry.tenantId && { tenantId: entry.tenantId }),
                    }),
                    signal: AbortSignal.timeout(writeTimeout),
                });
                if (res.ok) {
                    drained++;
                }
                else {
                    failed.push(entry);
                }
            }
            catch {
                failed.push(entry);
            }
        }
        truncateSpillover();
        if (failed.length > 0) {
            for (const entry of failed) {
                spillWrite(entry);
            }
            log.warn('[cortex] Some spilled writes failed to drain', {
                drained,
                remaining: failed.length,
            });
        }
        else {
            log.info('[cortex] All spilled writes drained successfully', { drained });
        }
    }
    const _healthCheckTimer = setInterval(async () => {
        try {
            const url = getUrl();
            const res = await fetch(`${url}/health/live`, {
                signal: AbortSignal.timeout(5_000),
            });
            if (res.ok) {
                const wasDegraded = _degraded;
                exitDegradedMode();
                if (wasDegraded) {
                    await drainSpillover();
                }
            }
            else {
                enterDegradedMode();
            }
        }
        catch {
            enterDegradedMode();
        }
    }, HEALTH_CHECK_INTERVAL_MS);
    if (_healthCheckTimer && typeof _healthCheckTimer === 'object' && 'unref' in _healthCheckTimer) {
        _healthCheckTimer.unref();
    }
    function getUrl() {
        if (opts.url)
            return opts.url;
        try {
            return infraUrl('cortexservice-api');
        }
        catch (err) {
            log.debug('[cortex] URL discovery failed, using default', { error: err.message });
            return process.env.CORTEX_URL ?? 'http://127.0.0.1:5400';
        }
    }
    let _readReplicaUrl;
    function getReadUrl() {
        if (!opts.useReadReplica)
            return null;
        if (_readReplicaUrl !== undefined)
            return _readReplicaUrl;
        try {
            _readReplicaUrl = infraUrl('cortexservice-read');
            log.info('[cortex] Read replica discovered', { url: _readReplicaUrl });
        }
        catch {
            _readReplicaUrl = null;
            log.debug('[cortex] No read replica configured, using primary for reads');
        }
        return _readReplicaUrl;
    }
    async function write(dataType, payload, options) {
        const url = getUrl();
        const body = {
            data_type: dataType,
            payload,
            actor: serviceName,
            ...(options?.correlationId && { correlationId: options.correlationId }),
            ...(options?.tenantId && { tenantId: options.tenantId }),
        };
        if (_degraded) {
            spillWrite({
                ts: new Date().toISOString(),
                dataType,
                payload,
                actor: serviceName,
                correlationId: options?.correlationId,
                tenantId: options?.tenantId,
            });
            return false;
        }
        try {
            const result = await breaker.call(async () => {
                const res = await fetch(`${url}/v1/write`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(options?.correlationId && { 'X-Correlation-Id': options.correlationId }),
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(writeTimeout),
                });
                if (!res.ok) {
                    throw new Error(`CortexDB write failed: ${res.status} ${res.statusText}`);
                }
                log.debug('CortexDB write ok', { dataType });
                return true;
            });
            exitDegradedMode();
            return result;
        }
        catch (err) {
            if (err instanceof CircuitOpenError) {
                log.warn('CortexDB circuit open — write blocked', { dataType });
                enterDegradedMode();
            }
            else {
                log.warn('CortexDB write error', { dataType }, err);
                enterDegradedMode();
            }
            spillWrite({
                ts: new Date().toISOString(),
                dataType,
                payload,
                actor: serviceName,
                correlationId: options?.correlationId,
                tenantId: options?.tenantId,
            });
            if (durableWriter) {
                try {
                    await durableWriter.write(dataType, {
                        ...payload,
                        ...(options?.correlationId && { correlationId: options.correlationId }),
                        ...(options?.tenantId && { tenantId: options.tenantId }),
                    }, serviceName);
                    log.info('Write buffered to WAL for retry', { dataType });
                }
                catch (walErr) {
                    log.error('WAL buffer also failed — data may be lost', { dataType }, walErr);
                }
            }
            if (throwOnError)
                throw err;
            return false;
        }
    }
    async function writeBatch(records, options) {
        if (records.length === 0)
            return { succeeded: 0, failed: 0 };
        if (_degraded) {
            for (const r of records) {
                spillWrite({
                    ts: new Date().toISOString(),
                    dataType: r.dataType,
                    payload: r.payload,
                    actor: serviceName,
                    correlationId: options?.correlationId,
                    tenantId: options?.tenantId,
                });
            }
            return { succeeded: 0, failed: records.length };
        }
        try {
            const url = getUrl();
            const result = await breaker.call(async () => {
                const res = await fetch(`${url}/v1/write/batch`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(options?.correlationId && { 'X-Correlation-Id': options.correlationId }),
                    },
                    body: JSON.stringify({
                        records: records.map((r) => ({
                            data_type: r.dataType,
                            payload: r.payload,
                            actor: serviceName,
                            ...(options?.tenantId && { tenantId: options.tenantId }),
                        })),
                    }),
                    signal: AbortSignal.timeout(writeTimeout * 2),
                });
                if (!res.ok) {
                    if (res.status === 404)
                        return null;
                    throw new Error(`CortexDB batch write failed: ${res.status} ${res.statusText}`);
                }
                const body = (await res.json());
                log.debug('CortexDB batch write ok', { count: records.length, ...body });
                return body;
            });
            if (result) {
                exitDegradedMode();
                return result;
            }
        }
        catch (err) {
            if (err instanceof CircuitOpenError) {
                enterDegradedMode();
                for (const r of records) {
                    spillWrite({
                        ts: new Date().toISOString(),
                        dataType: r.dataType,
                        payload: r.payload,
                        actor: serviceName,
                        correlationId: options?.correlationId,
                        tenantId: options?.tenantId,
                    });
                }
                return { succeeded: 0, failed: records.length };
            }
            log.debug('Batch endpoint unavailable, falling back to individual writes');
        }
        const results = await Promise.allSettled(records.map((r) => write(r.dataType, r.payload, options)));
        let succeeded = 0;
        let failed = 0;
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value)
                succeeded++;
            else
                failed++;
        }
        return { succeeded, failed };
    }
    async function query(dataType, filters, options) {
        const primaryUrl = getUrl();
        const body = {
            data_type: dataType,
            ...(filters && { filters }),
            ...(options?.limit != null && { limit: options.limit }),
            ...(options?.offset != null && { offset: options.offset }),
            ...(options?.orderBy && { orderBy: options.orderBy }),
            ...(options?.order && { order: options.order }),
        };
        if (_degraded) {
            log.debug('[cortex] Query skipped — degraded mode', { dataType });
            return null;
        }
        const readUrl = getReadUrl();
        if (readUrl) {
            try {
                const res = await fetch(`${readUrl}/v1/query`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(options?.correlationId && { 'X-Correlation-Id': options.correlationId }),
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(queryTimeout),
                });
                if (res.ok) {
                    const queryResult = (await res.json());
                    log.debug('CortexDB query ok (read replica)', { dataType, total: queryResult.total });
                    return queryResult;
                }
                log.debug('[cortex] Read replica returned error, falling back to primary', {
                    status: res.status,
                });
            }
            catch {
                log.debug('[cortex] Read replica unreachable, falling back to primary');
            }
        }
        try {
            const result = await breaker.call(async () => {
                const res = await fetch(`${primaryUrl}/v1/query`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(options?.correlationId && { 'X-Correlation-Id': options.correlationId }),
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(queryTimeout),
                });
                if (!res.ok) {
                    throw new Error(`CortexDB query failed: ${res.status} ${res.statusText}`);
                }
                const queryResult = (await res.json());
                log.debug('CortexDB query ok', { dataType, total: queryResult.total });
                return queryResult;
            });
            exitDegradedMode();
            return result;
        }
        catch (err) {
            if (err instanceof CircuitOpenError) {
                log.warn('CortexDB circuit open — query blocked', { dataType });
                enterDegradedMode();
            }
            else {
                log.warn('CortexDB query error', { dataType }, err);
                enterDegradedMode();
            }
            if (throwOnError)
                throw err;
            return null;
        }
    }
    async function search(queryText, options) {
        const url = getUrl();
        const body = {
            query: queryText,
            ...(options?.dataType && { data_type: options.dataType }),
            ...(options?.limit != null && { limit: options.limit }),
            ...(options?.minScore != null && { min_score: options.minScore }),
        };
        if (_degraded) {
            log.debug('[cortex] Search skipped — degraded mode');
            return null;
        }
        try {
            const result = await breaker.call(async () => {
                const res = await fetch(`${url}/v1/search`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(options?.correlationId && { 'X-Correlation-Id': options.correlationId }),
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(queryTimeout),
                });
                if (!res.ok) {
                    throw new Error(`CortexDB search failed: ${res.status} ${res.statusText}`);
                }
                const searchResult = (await res.json());
                log.debug('CortexDB search ok', { results: searchResult.results.length });
                return searchResult;
            });
            exitDegradedMode();
            return result;
        }
        catch (err) {
            if (err instanceof CircuitOpenError) {
                log.warn('CortexDB circuit open — search blocked', {});
                enterDegradedMode();
            }
            else {
                log.warn('CortexDB search error', {}, err);
                enterDegradedMode();
            }
            if (throwOnError)
                throw err;
            return null;
        }
    }
    async function healthy() {
        try {
            const url = getUrl();
            const res = await fetch(`${url}/health/live`, {
                signal: AbortSignal.timeout(queryTimeout),
            });
            return res.ok;
        }
        catch (err) {
            log.debug('[cortex] Health check failed', { error: err.message });
            return false;
        }
    }
    function circuitState() {
        return breaker.getState();
    }
    async function shutdown() {
        clearInterval(_healthCheckTimer);
        if (_degraded) {
            const isHealthy = await healthy();
            if (isHealthy) {
                exitDegradedMode();
                await drainSpillover();
            }
        }
        if (durableWriter) {
            await durableWriter.shutdown();
        }
    }
    function spilloverStats() {
        let bytes = 0;
        let rotatedBytes = 0;
        try {
            if (existsSync(SPILL_PATH))
                bytes = statSync(SPILL_PATH).size;
        }
        catch {
        }
        try {
            const rotated = SPILL_PATH + '.1';
            if (existsSync(rotated))
                rotatedBytes = statSync(rotated).size;
        }
        catch {
        }
        return {
            degraded: _degraded,
            degradedSince: _degradedSince,
            bytes,
            rotatedBytes,
            path: SPILL_PATH,
        };
    }
    return {
        write,
        writeBatch,
        query,
        search,
        healthy,
        circuitState,
        isDegraded: () => _degraded,
        spilloverStats,
        shutdown,
    };
}
export function createBufferedWriter(client, opts = {}) {
    const flushInterval = opts.flushIntervalMs ?? 5_000;
    const maxBuffer = opts.maxBufferSize ?? 100;
    const log = opts.logger ?? createLogger('cortex-buffer');
    let buffer = [];
    let flushing = false;
    async function flush() {
        if (buffer.length === 0 || flushing)
            return { succeeded: 0, failed: 0 };
        flushing = true;
        const batch = buffer;
        buffer = [];
        const groups = new Map();
        for (const w of batch) {
            const key = `${w.correlationId || ''}:${w.tenantId || ''}`;
            let group = groups.get(key);
            if (!group) {
                group = { records: [], options: { correlationId: w.correlationId, tenantId: w.tenantId } };
                groups.set(key, group);
            }
            group.records.push({ dataType: w.dataType, payload: w.payload });
        }
        let totalSucceeded = 0;
        let totalFailed = 0;
        for (const [, group] of groups) {
            try {
                const result = await client.writeBatch(group.records, group.options);
                totalSucceeded += result.succeeded;
                totalFailed += result.failed;
            }
            catch (err) {
                totalFailed += group.records.length;
                log.warn('[buffered-writer] Batch flush failed', {
                    count: group.records.length,
                    error: err.message,
                });
            }
        }
        log.debug('[buffered-writer] Flushed', {
            total: batch.length,
            succeeded: totalSucceeded,
            failed: totalFailed,
        });
        flushing = false;
        return { succeeded: totalSucceeded, failed: totalFailed };
    }
    const timer = setInterval(() => {
        flush().catch(() => { });
    }, flushInterval);
    if (timer && typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
    }
    function queue(dataType, payload, options) {
        buffer.push({
            dataType,
            payload,
            correlationId: options?.correlationId,
            tenantId: options?.tenantId,
        });
        if (buffer.length >= maxBuffer) {
            flush().catch(() => { });
        }
    }
    async function shutdown() {
        clearInterval(timer);
        if (buffer.length > 0) {
            log.info('[buffered-writer] Shutdown flush', { pending: buffer.length });
            await flush();
        }
    }
    return {
        queue,
        flush,
        shutdown,
        pending: () => buffer.length,
    };
}
