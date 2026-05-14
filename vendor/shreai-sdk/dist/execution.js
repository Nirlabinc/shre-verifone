import { createLogger } from './logger.js';
import { createCortexClient } from './cortex.js';
export const SUB_PHASE_WEIGHTS = {
    research: { start: 0.0, end: 0.15 },
    planning: { start: 0.15, end: 0.25 },
    implementation: { start: 0.25, end: 0.65 },
    testing: { start: 0.65, end: 0.8 },
    review: { start: 0.8, end: 0.88 },
    commit: { start: 0.88, end: 0.93 },
    delivery: { start: 0.93, end: 1.0 },
};
export const SUB_PHASE_ORDER = [
    'research',
    'planning',
    'implementation',
    'testing',
    'review',
    'commit',
    'delivery',
];
const TERMINAL_PHASES = new Set(['completed', 'failed', 'rejected']);
export function createExecutionTracker(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const cortex = opts.cortex ?? createCortexClient(serviceName);
    const bus = opts.eventBus;
    const qualityThreshold = opts.qualityThreshold ?? 3.0;
    const maxRetries = opts.maxRetries ?? 2;
    const cache = new Map();
    let cacheLoaded = false;
    const pendingWrites = [];
    const MAX_PENDING = 100;
    let flushTimer = null;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;
    async function flushPending() {
        if (pendingWrites.length === 0)
            return;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            const healthy = await cortex.healthy();
            if (!healthy)
                return;
            consecutiveFailures = 0;
        }
        const batch = pendingWrites.splice(0, 10);
        const records = batch.map((record) => ({
            dataType: 'execution_state',
            payload: { ...record, _id: record.taskId },
        }));
        const result = await cortex.writeBatch(records, { tenantId: serviceName });
        if (result.failed > 0) {
            const failedRecords = batch.slice(result.succeeded);
            pendingWrites.unshift(...failedRecords);
            consecutiveFailures++;
            log.warn('CortexDB batch flush partial failure', {
                succeeded: result.succeeded,
                failed: result.failed,
                pending: pendingWrites.length,
                failures: consecutiveFailures,
            });
        }
        else {
            consecutiveFailures = 0;
        }
    }
    flushTimer = setInterval(() => {
        flushPending().catch((e) => log.warn('Periodic flushPending failed:', { error: e.message }));
    }, 10_000);
    if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
        flushTimer.unref();
    }
    function emit(event, record) {
        if (!bus)
            return;
        bus
            .publish(`execution.${event}`, 'info', {
            taskId: record.taskId,
            agent: record.agent,
            model: record.model,
            phase: record.phase,
            subPhase: record.subPhase,
            traceId: record.traceId,
            quality: record.quality,
            progress: record.progress,
            retryCount: record.retryCount,
        })
            .catch((e) => log.warn('Event publish failed:', { error: e.message }));
    }
    function persist(record) {
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            if (pendingWrites.length < MAX_PENDING) {
                pendingWrites.push({ ...record });
            }
            else {
                log.warn('Write-ahead buffer full, dropping oldest entry', {
                    taskId: record.taskId,
                });
                pendingWrites.shift();
                pendingWrites.push({ ...record });
            }
            return;
        }
        cortex
            .write('execution_state', {
            ...record,
            _id: record.taskId,
        }, { tenantId: serviceName })
            .then((ok) => {
            if (!ok) {
                consecutiveFailures++;
                if (pendingWrites.length < MAX_PENDING) {
                    pendingWrites.push({ ...record });
                }
                log.warn('CortexDB write failed, buffered for retry', {
                    taskId: record.taskId,
                    pending: pendingWrites.length,
                });
            }
            else {
                consecutiveFailures = 0;
                if (pendingWrites.length > 0) {
                    flushPending().catch((e) => log.warn('Post-write flushPending failed:', { error: e.message }));
                }
            }
        })
            .catch(() => {
            consecutiveFailures++;
            if (pendingWrites.length < MAX_PENDING) {
                pendingWrites.push({ ...record });
            }
        });
    }
    async function ensureLoaded() {
        if (cacheLoaded)
            return;
        try {
            const result = await cortex.query('execution_state', {
                actor: serviceName,
            }, { limit: 200 });
            if (result?.data) {
                for (const row of result.data) {
                    const rec = row;
                    if (rec.taskId && !TERMINAL_PHASES.has(rec.phase)) {
                        cache.set(rec.taskId, rec);
                    }
                }
                log.info('Execution state loaded', { activeCount: cache.size });
            }
        }
        catch (err) {
            log.warn('Failed to load execution state from CortexDB — starting fresh', {}, err);
        }
        cacheLoaded = true;
    }
    async function start(startOpts) {
        await ensureLoaded();
        const now = new Date().toISOString();
        const record = {
            taskId: startOpts.taskId,
            agent: startOpts.agent,
            model: startOpts.model,
            sessionId: startOpts.sessionId,
            title: startOpts.title,
            phase: 'executing',
            subPhase: null,
            traceId: startOpts.traceId ?? startOpts.taskId,
            parentTaskId: startOpts.parentTaskId,
            progress: 0,
            retryCount: 0,
            startedAt: now,
            updatedAt: now,
            subPhaseTimestamps: {},
            meta: startOpts.meta ?? {},
        };
        cache.set(record.taskId, record);
        persist(record);
        emit('started', record);
        log.info('Execution started', {
            taskId: record.taskId,
            agent: record.agent,
            model: record.model,
        });
        return record;
    }
    async function transition(taskId, phase, note) {
        await ensureLoaded();
        const record = cache.get(taskId);
        if (!record) {
            log.warn('Transition on unknown task', { taskId, phase });
            return;
        }
        const prevPhase = record.phase;
        record.phase = phase;
        record.updatedAt = new Date().toISOString();
        if (note)
            record.progressNote = note;
        if (TERMINAL_PHASES.has(phase)) {
            record.completedAt = record.updatedAt;
        }
        persist(record);
        emit('transition', record);
        log.debug('Execution transition', { taskId, from: prevPhase, to: phase });
    }
    async function subTransition(taskId, subPhase, note) {
        await ensureLoaded();
        const record = cache.get(taskId);
        if (!record) {
            log.warn('Sub-transition on unknown task', { taskId, subPhase });
            return;
        }
        if (record.phase !== 'executing') {
            log.warn('Sub-transition ignored — not in executing phase', {
                taskId,
                subPhase,
                currentPhase: record.phase,
            });
            return;
        }
        const prevSubPhase = record.subPhase;
        const now = new Date().toISOString();
        record.subPhase = subPhase;
        record.updatedAt = now;
        if (note)
            record.progressNote = note;
        if (!record.subPhaseTimestamps)
            record.subPhaseTimestamps = {};
        record.subPhaseTimestamps[subPhase] = now;
        const weight = SUB_PHASE_WEIGHTS[subPhase];
        if (weight && record.progress < weight.start) {
            record.progress = weight.start;
        }
        persist(record);
        emit('sub_transition', record);
        log.debug('Execution sub-transition', {
            taskId,
            from: prevSubPhase,
            to: subPhase,
            progress: record.progress,
        });
    }
    async function reportTests(taskId, results) {
        await ensureLoaded();
        const record = cache.get(taskId);
        if (!record) {
            log.warn('reportTests on unknown task', { taskId });
            return;
        }
        if (results.output && results.output.length > 2000) {
            results.output = results.output.slice(0, 2000) + '\n... [truncated]';
        }
        if (results.failures && results.failures.length > 5) {
            results.failures = results.failures.slice(0, 5);
        }
        record.testResults = results;
        record.updatedAt = new Date().toISOString();
        persist(record);
        emit('test_results', record);
        log.info('Test results captured', {
            taskId,
            total: results.total,
            passed: results.passed,
            failed: results.failed,
            passRate: results.passRate,
        });
    }
    async function progressUpdate(taskId, ratio, note) {
        await ensureLoaded();
        const record = cache.get(taskId);
        if (!record)
            return;
        record.progress = Math.max(0, Math.min(1, ratio));
        record.updatedAt = new Date().toISOString();
        if (note)
            record.progressNote = note;
        persist(record);
    }
    async function complete(taskId, completeOpts = {}) {
        await ensureLoaded();
        const record = cache.get(taskId);
        if (!record) {
            return { accepted: false, phase: 'failed' };
        }
        record.quality = completeOpts.quality;
        record.resultSummary = completeOpts.resultSummary;
        record.progress = 1.0;
        record.updatedAt = new Date().toISOString();
        if (completeOpts.quality != null && completeOpts.quality < qualityThreshold) {
            if (record.retryCount < maxRetries) {
                record.phase = 'retrying';
                record.subPhase = null;
                record.retryCount++;
                record.progress = 0;
                persist(record);
                emit('quality_rejected', record);
                log.warn('Quality gate rejected', {
                    taskId,
                    quality: completeOpts.quality,
                    threshold: qualityThreshold,
                    retryCount: record.retryCount,
                });
                return { accepted: false, phase: 'retrying' };
            }
            else {
                record.phase = 'rejected';
                record.completedAt = record.updatedAt;
                persist(record);
                emit('rejected', record);
                log.warn('Quality gate final rejection', {
                    taskId,
                    quality: completeOpts.quality,
                    retries: record.retryCount,
                });
                return { accepted: false, phase: 'rejected' };
            }
        }
        record.phase = 'completed';
        record.completedAt = record.updatedAt;
        persist(record);
        emit('completed', record);
        log.info('Execution completed', { taskId, quality: completeOpts.quality });
        return { accepted: true, phase: 'completed' };
    }
    async function fail(taskId, reason) {
        await ensureLoaded();
        const record = cache.get(taskId);
        if (!record) {
            return { willRetry: false, retryCount: 0 };
        }
        record.updatedAt = new Date().toISOString();
        record.progressNote = reason;
        if (record.retryCount < maxRetries) {
            record.phase = 'retrying';
            record.subPhase = null;
            record.retryCount++;
            record.progress = 0;
            persist(record);
            emit('retrying', record);
            log.warn('Execution failed, will retry', { taskId, reason, retryCount: record.retryCount });
            return { willRetry: true, retryCount: record.retryCount };
        }
        record.phase = 'failed';
        record.completedAt = record.updatedAt;
        persist(record);
        emit('failed', record);
        log.error('Execution failed permanently', { taskId, reason, retries: record.retryCount });
        return { willRetry: false, retryCount: record.retryCount };
    }
    async function get(taskId) {
        await ensureLoaded();
        return cache.get(taskId) ?? null;
    }
    async function getActive() {
        await ensureLoaded();
        return Array.from(cache.values()).filter((r) => !TERMINAL_PHASES.has(r.phase));
    }
    async function getStuck(maxAgeMs) {
        await ensureLoaded();
        const cutoff = Date.now() - maxAgeMs;
        return Array.from(cache.values()).filter((r) => {
            if (r.phase !== 'executing')
                return false;
            const updated = new Date(r.updatedAt).getTime();
            return updated < cutoff;
        });
    }
    async function getTrace(traceId) {
        await ensureLoaded();
        const records = Array.from(cache.values()).filter((r) => r.traceId === traceId);
        try {
            const result = await cortex.query('execution_state', {
                traceId,
                actor: serviceName,
            }, { limit: 50, orderBy: 'startedAt', order: 'asc' });
            if (result?.data) {
                const cacheIds = new Set(records.map((r) => r.taskId));
                for (const row of result.data) {
                    const rec = row;
                    if (rec.taskId && !cacheIds.has(rec.taskId)) {
                        records.push(rec);
                    }
                }
            }
        }
        catch (err) {
            log.debug('[execution] CortexDB query failed, returning cache-only', {
                error: err.message,
            });
        }
        return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }
    async function remove(taskId) {
        cache.delete(taskId);
    }
    return {
        start,
        transition,
        subTransition,
        reportTests,
        progress: progressUpdate,
        complete,
        fail,
        get,
        getActive,
        getStuck,
        getTrace,
        remove,
    };
}
