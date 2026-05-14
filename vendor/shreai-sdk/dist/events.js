import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';
import { createResilience } from './resilience.js';
import { resolveRedisPassword } from './redis.js';
import { createLamportClock } from './lamport-clock.js';
const WAL_ELIGIBLE_PRIORITIES = new Set(['critical', 'high']);
const CRITICAL_STREAM_KEY = 'shre:critical';
const BACKGROUND_STREAM_KEY = 'shre:background';
function resolveRedisPasswordSync() {
    return resolveRedisPassword();
}
export const SHRE_STREAM = 'shre:stream';
const STREAM_KEY = SHRE_STREAM;
const DLQ_STREAM_KEY = 'shre:dlq';
export const EventTypes = {
    TASK_COMPLETE: 'task.complete',
    TASK_DEGRADED: 'fleet.task.degraded',
    EVALUATION_COMPLETE: 'evaluation.complete',
    EVALUATION_STARTED: 'evaluation.started',
    EVALUATION_PROGRESS: 'evaluation.progress',
    SKILL_UPDATED: 'skill.updated',
    SKILL_GAP_DETECTED: 'skill.gap_detected',
    SKILL_DECAYED: 'skill.decayed',
    COST_RECORDED: 'cost.recorded',
    BUDGET_WARNING: 'budget.warning',
    BUDGET_EXCEEDED: 'budget.exceeded',
    FINETUNE_COMPLETE: 'finetune.complete',
    SERVICE_STARTED: 'service.started',
    SERVICE_STOPPING: 'service.stopping',
    SERVICE_HEALTH: 'service.health',
    FLEET_AGENT_CRASH: 'fleet.agent.crash_unrecoverable',
    FEED_POST: 'feed.post',
    AUDIT_AGENT_SPAWN: 'audit.agent.spawn',
    AUDIT_AGENT_DELEGATE: 'audit.agent.delegate',
    AUDIT_SKILL_EXECUTE: 'audit.skill.execute',
    AUDIT_CONFIG_CHANGE: 'audit.config.change',
    AUDIT_AUTH_EVENT: 'audit.auth.event',
    AUDIT_WRITE_OP: 'audit.write.operation',
    AUDIT_SYSTEM: 'audit.system',
    DEGRADATION_DETECTED: 'degradation.detected',
    REGISTRY_TENANT_SYNCED: 'registry.tenant.synced',
    REGISTRY_APP_ENABLED: 'registry.app.enabled',
    REGISTRY_APP_DISABLED: 'registry.app.disabled',
    REGISTRY_AGENT_ASSIGNED: 'registry.agent.assigned',
    REGISTRY_AGENT_UNASSIGNED: 'registry.agent.unassigned',
    REGISTRY_AGENT_DEACTIVATED: 'registry.agent.deactivated',
    REGISTRY_SOURCE_ADDED: 'registry.source.added',
    REGISTRY_SOURCE_REMOVED: 'registry.source.removed',
    REGISTRY_USER_ADDED: 'registry.user.added',
    BILLING_STOPPED: 'billing.stopped',
    BILLING_RESUMED: 'billing.resumed',
    NODE_SCHEMA_PROVISIONED: 'node.schema_provisioned',
    BLOCK_MINED: 'block.mined',
    BLOCK_REJECTED: 'block.rejected',
    MINING_REWARD: 'mining.reward',
    SALE_COMPLETED: 'sale.completed',
    SALE_VOIDED: 'sale.voided',
    SALE_REFUNDED: 'sale.refunded',
    TRANSACTION_RECORDED: 'transaction.recorded',
    INVENTORY_UPDATED: 'inventory.updated',
    INVENTORY_LOW_STOCK: 'inventory.low_stock',
    INVENTORY_RECEIVED: 'inventory.received',
    ORDER_RECEIVED: 'order.received',
    ORDER_CONFIRMED: 'order.confirmed',
    ORDER_FAILED: 'order.failed',
    ORDER_COMPLETED: 'order.completed',
    DATA_SYNC_STARTED: 'data.sync.started',
    DATA_SYNC_COMPLETED: 'data.sync.completed',
    DATA_SYNC_FAILED: 'data.sync.failed',
    DATA_CLEANING_COMPLETED: 'data.cleaning.completed',
    PIPE_EXECUTION_COMPLETED: 'pipe.execution.completed',
    PIPE_EXECUTION_FAILED: 'pipe.execution.failed',
    WEBHOOK_RECEIVED: 'webhook.received',
    PREDICTION_GENERATED: 'prediction.generated',
    PREDICTION_ALERT: 'prediction.alert',
    CODE_COMMITTED: 'code.committed',
    DEPLOY_COMPLETED: 'deploy.completed',
    LOOP_COMPLETE: 'loop.complete',
    LOOP_FAILED: 'loop.failed',
    LOOP_SLOW: 'loop.slow',
    ERROR_OCCURRED: 'error.occurred',
    ERROR_RESOLVED: 'error.resolved',
    ERROR_ESCALATED: 'error.escalated',
    CRON_JOB_FIRED: 'cron.job.fired',
    CRON_JOB_COMPLETED: 'cron.job.completed',
    CRON_JOB_FAILED: 'cron.job.failed',
    AUTOMATION_RULE_FIRED: 'automation.rule.fired',
    AUTOMATION_RULE_COMPLETED: 'automation.rule.completed',
    AUTOMATION_RULE_FAILED: 'automation.rule.failed',
    AUTOMATION_ESCALATED: 'automation.escalated',
    AUTOMATION_ESCALATION_RESOLVED: 'automation.escalation.resolved',
    AUTOMATION_ESCALATION_MAXED: 'automation.escalation.maxed',
    AUTOMATION_GATEWAY_ERROR: 'automation.gateway.error',
    PUSH_SENT: 'push.notification.sent',
    PUSH_FAILED: 'push.notification.failed',
    DEVICE_REGISTERED: 'device.registered',
    DEVICE_UNREGISTERED: 'device.unregistered',
    SERVICE_DOWN: 'service.down',
    SERVICE_CRITICAL: 'service.critical',
    CANCEL_OPERATIONS: 'cancel.operations',
    PREEMPT_TASK: 'preempt.task',
};
const PUBSUB_CHANNEL = 'shre:events';
const MAX_STREAM_LEN = 10_000;
const MAX_DLQ_LEN = 5_000;
const BLOCK_MS = 5_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const MAX_HANDLER_RETRIES = 3;
const MAX_BUFFER = 1_000;
const RECONNECT_INTERVAL_MS = 30_000;
const eventSchemas = new Map();
export function registerEventSchema(eventType, schema) {
    eventSchemas.set(eventType, schema);
}
function validateEvent(event) {
    const schema = eventSchemas.get(event.type);
    if (!schema)
        return { valid: true, errors: [], hasSchema: false };
    const errors = [];
    const data = event.data ?? {};
    if (schema.required) {
        for (const field of schema.required) {
            if (data[field] === undefined || data[field] === null) {
                errors.push(`missing required field: ${field}`);
            }
        }
    }
    if (schema.types) {
        for (const [field, expectedType] of Object.entries(schema.types)) {
            if (data[field] !== undefined && data[field] !== null) {
                if (typeof data[field] !== expectedType) {
                    errors.push(`${field}: expected ${expectedType}, got ${typeof data[field]}`);
                }
            }
        }
    }
    return { valid: errors.length === 0, errors, hasSchema: true };
}
const fabricSchemas = [
    [
        'order.received',
        { required: ['orderId', 'source'], types: { orderId: 'string', source: 'string' } },
    ],
    ['order.confirmed', { required: ['orderId', 'source'], types: { orderId: 'string' } }],
    [
        'order.failed',
        { required: ['orderId', 'error'], types: { orderId: 'string', error: 'string' } },
    ],
    ['sale.completed', { required: ['total'], types: { total: 'number' } }],
    ['inventory.updated', { types: { itemCount: 'number' } }],
    ['inventory.low_stock', { required: ['itemCode'], types: { itemCode: 'string' } }],
    ['data.sync.completed', { required: ['source'], types: { source: 'string' } }],
    [
        'data.cleaning.completed',
        { required: ['rule', 'domain'], types: { rule: 'string', domain: 'string' } },
    ],
    [
        'pipe.execution.completed',
        { required: ['pipeId', 'runId'], types: { pipeId: 'string', runId: 'string' } },
    ],
    ['pipe.execution.failed', { required: ['pipeId'], types: { pipeId: 'string' } }],
];
for (const [type, schema] of fabricSchemas)
    registerEventSchema(type, schema);
const platformSchemas = [
    ['task.complete', { required: ['taskId'], types: { taskId: 'string' } }],
    ['evaluation.complete', { required: ['agentId'], types: { agentId: 'string' } }],
    ['evaluation.started', { required: ['agentId'], types: { agentId: 'string' } }],
    [
        'evaluation.progress',
        { required: ['completed', 'total'], types: { completed: 'number', total: 'number' } },
    ],
    ['service.started', { required: ['service'], types: { service: 'string' } }],
    [
        'service.health',
        { required: ['service', 'status'], types: { service: 'string', status: 'string' } },
    ],
    ['cost.recorded', { required: ['model'], types: { model: 'string' } }],
    [
        'skill.updated',
        { required: ['agentId', 'skill'], types: { agentId: 'string', skill: 'string' } },
    ],
    ['training.rejected', { required: ['reason'], types: { reason: 'string' } }],
    [
        'consistency.drift',
        { required: ['sampled', 'missing'], types: { sampled: 'number', missing: 'number' } },
    ],
];
for (const [type, schema] of platformSchemas)
    registerEventSchema(type, schema);
export function createEventBus(serviceName, opts = {}) {
    const log = opts.logger ?? createLogger(serviceName);
    const clock = createLamportClock(serviceName);
    const host = opts.redisHost ?? process.env.REDIS_HOST ?? '127.0.0.1';
    const port = opts.redisPort ?? (Number(process.env.REDIS_PORT) || 6379);
    const password = process.env.REDIS_NO_AUTH === '1'
        ? undefined
        : (opts.redisPassword ?? resolveRedisPasswordSync());
    if (!password && process.env.REDIS_NO_AUTH !== '1') {
        log.warn('REDIS_PASSWORD not found in env, vault, or cortexdb/.env — event bus may fail to authenticate');
    }
    const groupName = opts.consumerGroup ?? serviceName;
    const consumerId = opts.consumerId ?? `${serviceName}-${process.pid}`;
    const redisOpts = {
        host,
        port,
        password,
        maxRetriesPerRequest: null,
        retryStrategy: (times) => Math.min(times * INITIAL_RETRY_MS, MAX_RETRY_MS),
        lazyConnect: true,
        reconnectOnError: (err) => {
            if (err.message.includes('NOAUTH') || err.message.includes('ERR AUTH')) {
                log.warn('Redis NOAUTH in event bus — will reconnect');
                return true;
            }
            return false;
        },
    };
    const writeClient = new Redis(redisOpts);
    const readClient = new Redis(redisOpts);
    const subClient = new Redis(redisOpts);
    let _connected = false;
    let _shutdownRequested = false;
    const handlers = new Map();
    const _dedupEnabled = opts.enableDedup !== false;
    const _dedupTtl = opts.dedupTtlSeconds ?? 3600;
    const _dedupMaxSize = opts.dedupMaxSetSize ?? 100_000;
    const _strictValidation = opts.strictValidation ?? false;
    const _orderedDomains = new Set(opts.orderedDomains ?? []);
    const ORDER_BUFFER_SIZE = opts.orderBufferSize ?? 50;
    const ORDER_FLUSH_MS = opts.orderFlushIntervalMs ?? 2000;
    const _domainBuffers = new Map();
    let _eventsPublished = 0;
    let _eventsDelivered = 0;
    let _eventsDlq = 0;
    let _eventsDedupSkipped = 0;
    const cancellationCallbacks = new Map();
    const cancelledTokens = new Set();
    const handlerResilience = createResilience({
        service: serviceName,
        logger: log,
        defaults: {
            maxRetries: MAX_HANDLER_RETRIES - 1,
            baseDelayMs: 500,
            backoff: 2,
            jitter: 0,
            timeoutMs: 30_000,
        },
    });
    const _buffer = [];
    const PRIORITY_RANK = { critical: 3, high: 2, normal: 1, background: 0 };
    function evictLowestPriority() {
        let evictIdx = 0;
        let lowestRank = 4;
        for (let i = 0; i < _buffer.length; i++) {
            const p = _buffer[i].data?._priority || 'normal';
            const rank = PRIORITY_RANK[p] ?? 1;
            if (rank < lowestRank) {
                lowestRank = rank;
                evictIdx = i;
                if (rank === 0)
                    break;
            }
        }
        _buffer.splice(evictIdx, 1);
    }
    let _reconnectAttempts = 0;
    let _reconnectTimer = null;
    const BUFFER_WAL_DIR = join(homedir(), '.shre', 'events');
    function persistBuffer() {
        try {
            mkdirSync(BUFFER_WAL_DIR, { recursive: true });
            const walPath = join(BUFFER_WAL_DIR, `${serviceName}.buffer.json`);
            writeFileSync(walPath, JSON.stringify(_buffer));
        }
        catch (err) {
            log.debug('[events] Buffer persist failed (best-effort)', { error: err.message });
        }
    }
    function loadPersistedBuffer() {
        try {
            const walPath = join(BUFFER_WAL_DIR, `${serviceName}.buffer.json`);
            if (!existsSync(walPath))
                return;
            const raw = readFileSync(walPath, 'utf-8');
            const entries = JSON.parse(raw);
            if (Array.isArray(entries) && entries.length > 0) {
                _buffer.unshift(...entries);
                while (_buffer.length > MAX_BUFFER)
                    _buffer.shift();
                log.info('Recovered buffered events from WAL', { count: entries.length });
            }
            writeFileSync(walPath, '[]');
        }
        catch (err) {
            log.debug('[events] Buffer recovery failed (best-effort)', { error: err.message });
        }
    }
    loadPersistedBuffer();
    const EVENT_WAL_DIR = join(homedir(), '.shre', 'event-wal');
    const EVENT_WAL_PATH = join(EVENT_WAL_DIR, `${serviceName}-pending.jsonl`);
    const WAL_EXPIRY_MS = 60 * 60 * 1000;
    function ensureWalDir() {
        try {
            mkdirSync(EVENT_WAL_DIR, { recursive: true });
        }
        catch {
        }
    }
    function appendToEventWAL(entry) {
        try {
            ensureWalDir();
            const { appendFileSync } = require('node:fs');
            appendFileSync(EVENT_WAL_PATH, JSON.stringify(entry) + '\n', 'utf-8');
        }
        catch (err) {
            log.debug('[events] WAL append failed (best-effort)', { error: err.message });
        }
    }
    function removeFromEventWAL(walId) {
        try {
            if (!existsSync(EVENT_WAL_PATH))
                return;
            const raw = readFileSync(EVENT_WAL_PATH, 'utf-8');
            const lines = raw.split('\n').filter((l) => {
                if (!l.trim())
                    return false;
                try {
                    const entry = JSON.parse(l);
                    return entry.id !== walId;
                }
                catch {
                    return false;
                }
            });
            writeFileSync(EVENT_WAL_PATH, lines.length > 0 ? lines.join('\n') + '\n' : '');
        }
        catch (err) {
            log.debug('[events] WAL remove failed (best-effort)', { error: err.message });
        }
    }
    function readEventWAL() {
        try {
            if (!existsSync(EVENT_WAL_PATH))
                return [];
            const raw = readFileSync(EVENT_WAL_PATH, 'utf-8');
            const now = Date.now();
            const entries = [];
            for (const line of raw.split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const entry = JSON.parse(line);
                    if (now - entry.writtenAt > WAL_EXPIRY_MS)
                        continue;
                    entries.push(entry);
                }
                catch {
                }
            }
            return entries;
        }
        catch {
            return [];
        }
    }
    function truncateEventWAL() {
        try {
            if (existsSync(EVENT_WAL_PATH)) {
                writeFileSync(EVENT_WAL_PATH, '');
            }
        }
        catch {
        }
    }
    async function replayPendingEvents() {
        const entries = readEventWAL();
        if (entries.length === 0)
            return;
        log.info('[events] Replaying pending WAL events', { count: entries.length });
        let replayed = 0;
        let failed = 0;
        for (const entry of entries) {
            try {
                if (!_connected) {
                    log.warn('[events] WAL replay aborted — Redis not connected', {
                        remaining: entries.length - replayed,
                    });
                    break;
                }
                const event = {
                    id: entry.id,
                    source: serviceName,
                    type: entry.type,
                    severity: entry.severity,
                    data: { ...entry.data, _lamport: clock.stamp(), _walReplay: true },
                    ts: new Date().toISOString(),
                    ...(entry.correlationId && { correlationId: entry.correlationId }),
                };
                await writeClient.xadd(entry.priority === 'critical' ? CRITICAL_STREAM_KEY : STREAM_KEY, 'MAXLEN', '~', String(MAX_STREAM_LEN), '*', 'event', JSON.stringify(event));
                removeFromEventWAL(entry.id);
                replayed++;
            }
            catch (err) {
                failed++;
                log.warn('[events] WAL replay failed for entry', {
                    walId: entry.id,
                    type: entry.type,
                    error: err.message,
                });
            }
        }
        if (replayed > 0 || failed > 0) {
            log.info('[events] WAL replay complete', {
                replayed,
                failed,
                expired: entries.length - replayed - failed,
            });
        }
        if (failed === 0) {
            truncateEventWAL();
        }
    }
    let _walReplayRunning = false;
    let _lastWalReplayAt = null;
    const _lastWalReplayResult = { replayed: 0, failed: 0 };
    async function guardedReplayPendingEvents() {
        if (_walReplayRunning)
            return;
        _walReplayRunning = true;
        try {
            await replayPendingEvents();
            _lastWalReplayAt = new Date().toISOString();
        }
        finally {
            _walReplayRunning = false;
        }
    }
    const _walReplayTimer = setTimeout(() => {
        guardedReplayPendingEvents().catch((err) => {
            log.warn('[events] WAL replay startup error', { error: err.message });
        });
    }, 5_000);
    if (_walReplayTimer && typeof _walReplayTimer === 'object' && 'unref' in _walReplayTimer) {
        _walReplayTimer.unref();
    }
    const _walContinuousTimer = setInterval(() => {
        if (!_connected)
            return;
        guardedReplayPendingEvents().catch((err) => {
            log.debug('[events] WAL continuous replay error', { error: err.message });
        });
    }, 60_000);
    if (_walContinuousTimer &&
        typeof _walContinuousTimer === 'object' &&
        'unref' in _walContinuousTimer) {
        _walContinuousTimer.unref();
    }
    async function connect() {
        if (_connected)
            return;
        try {
            await Promise.all([writeClient.connect(), readClient.connect(), subClient.connect()]);
            _connected = true;
            log.info('Event bus connected', { host, port });
        }
        catch (err) {
            log.warn('Event bus connection failed — operating in degraded mode', {}, err);
            startReconnectLoop();
        }
    }
    writeClient.on('error', (err) => {
        if (!_shutdownRequested)
            log.warn('Event bus write client error', {}, err);
    });
    readClient.on('error', (err) => {
        if (!_shutdownRequested)
            log.warn('Event bus read client error', {}, err);
    });
    subClient.on('error', (err) => {
        if (!_shutdownRequested)
            log.warn('Event bus sub client error', {}, err);
    });
    function startReconnectLoop() {
        if (_reconnectTimer || _shutdownRequested)
            return;
        _reconnectTimer = setInterval(async () => {
            if (_connected || _shutdownRequested) {
                stopReconnectLoop();
                return;
            }
            _reconnectAttempts++;
            log.info('Attempting Redis reconnect', {
                attempt: _reconnectAttempts,
                buffered: _buffer.length,
            });
            try {
                await Promise.allSettled([
                    writeClient.disconnect(),
                    readClient.disconnect(),
                    subClient.disconnect(),
                ]);
                await Promise.all([writeClient.connect(), readClient.connect(), subClient.connect()]);
                _connected = true;
                log.info('Redis reconnected successfully', {
                    attempt: _reconnectAttempts,
                    buffered: _buffer.length,
                });
                _reconnectAttempts = 0;
                stopReconnectLoop();
                await drainBuffer();
            }
            catch (err) {
                log.warn('Redis reconnect failed', { attempt: _reconnectAttempts }, err);
            }
        }, RECONNECT_INTERVAL_MS);
    }
    function stopReconnectLoop() {
        if (_reconnectTimer) {
            clearInterval(_reconnectTimer);
            _reconnectTimer = null;
        }
    }
    async function drainBuffer() {
        if (_buffer.length === 0)
            return;
        log.info('Draining event buffer', { count: _buffer.length });
        let drained = 0;
        while (_buffer.length > 0 && _connected) {
            const item = _buffer.shift();
            try {
                await publish(item.type, item.severity, item.data, item.correlationId);
                drained++;
            }
            catch (err) {
                _buffer.unshift(item);
                log.warn('Buffer drain interrupted — Redis disconnected again', {
                    drained,
                    remaining: _buffer.length,
                });
                break;
            }
        }
        if (drained > 0) {
            log.info('Buffer drained', { drained, remaining: _buffer.length });
        }
        persistBuffer();
    }
    for (const client of [writeClient, readClient, subClient]) {
        client.on('close', () => {
            if (!_shutdownRequested && _connected) {
                _connected = false;
                log.warn('Redis connection lost — buffering events until reconnected');
                startReconnectLoop();
            }
        });
    }
    const connectPromise = connect();
    async function ensureGroup() {
        try {
            await writeClient.xgroup('CREATE', STREAM_KEY, groupName, '0', 'MKSTREAM');
        }
        catch (err) {
            if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) {
                log.warn('Failed to create consumer group', { groupName }, err);
            }
        }
    }
    let _disconnectedWarned = false;
    async function publish(type, severity, data, correlationId) {
        await connectPromise;
        if (!_connected) {
            if (_buffer.length >= MAX_BUFFER) {
                evictLowestPriority();
            }
            _buffer.push({ type, severity, data, correlationId, timestamp: new Date().toISOString() });
            persistBuffer();
            if (!_disconnectedWarned) {
                log.warn('Event bus disconnected — buffering events until reconnected', {
                    type,
                    bufferSize: _buffer.length,
                });
                _disconnectedWarned = true;
            }
            return;
        }
        _disconnectedWarned = false;
        const event = {
            id: randomUUID().slice(0, 12),
            source: serviceName,
            type,
            severity,
            data: { ...data, _lamport: clock.stamp(), _schemaVersion: eventSchemas.has(type) ? 1 : 0 },
            ts: new Date().toISOString(),
            ...(correlationId && { correlationId }),
        };
        const validation = validateEvent(event);
        if (!validation.valid) {
            log.warn('Event schema validation failed — sending to DLQ', {
                type,
                errors: validation.errors,
            });
            await sendToDLQ(event, `schema_validation: ${validation.errors.join('; ')}`);
            return;
        }
        if (_strictValidation && !validation.hasSchema) {
            log.warn('Event published without registered schema (strict mode)', {
                type,
                source: serviceName,
            });
        }
        try {
            await writeClient.xadd(STREAM_KEY, 'MAXLEN', '~', String(MAX_STREAM_LEN), '*', 'event', JSON.stringify(event));
            _eventsPublished++;
            log.debug('Event published', { type, severity });
        }
        catch (err) {
            log.warn('Event publish failed', { type }, err);
        }
    }
    async function sendToDLQ(event, reason) {
        try {
            const dlqEntry = {
                event: JSON.stringify(event),
                reason,
                failed_at: new Date().toISOString(),
                consumer: consumerId,
            };
            await writeClient.xadd(DLQ_STREAM_KEY, 'MAXLEN', '~', String(MAX_DLQ_LEN), '*', ...Object.entries(dlqEntry).flat());
            _eventsDlq++;
            log.debug('Event sent to DLQ', { type: event.type, reason });
        }
        catch (err) {
            log.warn('DLQ write failed', { type: event.type }, err);
        }
    }
    async function ensureGroupForStream(streamKey) {
        try {
            await writeClient.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
        }
        catch (err) {
            if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) {
                log.warn('Failed to create consumer group for stream', { streamKey, groupName }, err);
            }
        }
    }
    async function publishToStream(streamKey, maxLen, event) {
        try {
            await writeClient.xadd(streamKey, 'MAXLEN', '~', String(maxLen), '*', 'event', JSON.stringify(event));
            log.debug('Event published to stream', { type: event.type, stream: streamKey });
        }
        catch (err) {
            log.warn('Event publish to stream failed', { type: event.type, stream: streamKey }, err);
        }
    }
    async function publishPriority(type, severity, priority, data, correlationId) {
        await connectPromise;
        const eventId = randomUUID().slice(0, 12);
        const event = {
            id: eventId,
            source: serviceName,
            type,
            severity,
            data: { ...data, _priority: priority },
            ts: new Date().toISOString(),
            ...(correlationId && { correlationId }),
        };
        const validation = validateEvent(event);
        if (!validation.valid) {
            log.warn('Event schema validation failed — sending to DLQ', {
                type,
                errors: validation.errors,
            });
            await sendToDLQ(event, `schema_validation: ${validation.errors.join('; ')}`);
            return;
        }
        const walEligible = WAL_ELIGIBLE_PRIORITIES.has(priority);
        if (walEligible) {
            appendToEventWAL({
                id: eventId,
                type,
                severity,
                priority,
                data: { ...data, _priority: priority },
                correlationId,
                writtenAt: Date.now(),
            });
        }
        if (!_connected) {
            if (_buffer.length >= MAX_BUFFER)
                evictLowestPriority();
            _buffer.push({
                type,
                severity,
                data: { ...data, _priority: priority },
                correlationId,
                timestamp: new Date().toISOString(),
            });
            persistBuffer();
            return;
        }
        const streamKey = priority === 'critical'
            ? CRITICAL_STREAM_KEY
            : priority === 'background'
                ? BACKGROUND_STREAM_KEY
                : STREAM_KEY;
        await publishToStream(streamKey, MAX_STREAM_LEN, event);
        if (walEligible) {
            removeFromEventWAL(eventId);
        }
    }
    function createCancellationToken(correlationId) {
        const tokenId = `cancel:${correlationId}:${randomUUID().slice(0, 8)}`;
        if (!cancellationCallbacks.has(correlationId)) {
            cancellationCallbacks.set(correlationId, new Set());
        }
        const token = {
            id: tokenId,
            cancel(reason) {
                cancelledTokens.add(correlationId);
                const cbs = cancellationCallbacks.get(correlationId);
                if (cbs) {
                    const dummyEvent = {
                        id: tokenId,
                        source: serviceName,
                        type: EventTypes.CANCEL_OPERATIONS,
                        severity: 'warning',
                        data: { reason, correlationId },
                        ts: new Date().toISOString(),
                    };
                    for (const cb of cbs) {
                        try {
                            cb(reason, dummyEvent);
                        }
                        catch (err) {
                            log.warn('Cancellation callback error', { correlationId }, err);
                        }
                    }
                }
            },
            onCancel(cb) {
                cancellationCallbacks.get(correlationId).add(cb);
            },
            isCancelled() {
                return cancelledTokens.has(correlationId);
            },
        };
        return token;
    }
    async function cancelCorrelated(correlationId, reason) {
        cancelledTokens.add(correlationId);
        const cbs = cancellationCallbacks.get(correlationId);
        if (cbs) {
            const cancelEvent = {
                id: randomUUID().slice(0, 12),
                source: serviceName,
                type: EventTypes.CANCEL_OPERATIONS,
                severity: 'critical',
                data: { reason, correlationId },
                ts: new Date().toISOString(),
                correlationId,
            };
            for (const cb of cbs) {
                try {
                    await cb(reason, cancelEvent);
                }
                catch (err) {
                    log.warn('Cancellation callback error during cancelCorrelated', { correlationId }, err);
                }
            }
        }
        await publishPriority(EventTypes.CANCEL_OPERATIONS, 'critical', 'critical', { reason, correlationId }, correlationId);
        log.info('Cancelled all operations for correlation', {
            correlationId,
            reason,
            callbacksFired: cbs?.size ?? 0,
        });
    }
    async function broadcast(type, severity, data) {
        await connectPromise;
        if (!_connected)
            return;
        const event = {
            id: randomUUID().slice(0, 12),
            source: serviceName,
            type,
            severity,
            data,
            ts: new Date().toISOString(),
        };
        try {
            await writeClient.publish(PUBSUB_CHANNEL, JSON.stringify(event));
        }
        catch (err) {
            log.warn('Event broadcast failed', { type }, err);
        }
    }
    function matchesPattern(type, pattern) {
        if (pattern === '*')
            return true;
        if (pattern.endsWith('.*')) {
            return type.startsWith(pattern.slice(0, -1));
        }
        return type === pattern;
    }
    async function dispatchToHandlers(event) {
        for (const [pattern, handlerSet] of handlers) {
            if (matchesPattern(event.type, pattern)) {
                for (const handler of handlerSet) {
                    try {
                        await handlerResilience.wrap(`handler:${pattern}:${event.type}`, async () => {
                            await handler(event);
                        });
                    }
                    catch (err) {
                        log.error('Event handler exhausted retries — sending to DLQ', {
                            type: event.type,
                            pattern,
                            attempts: MAX_HANDLER_RETRIES,
                        }, err);
                        await sendToDLQ(event, `handler_failed: ${pattern} after ${MAX_HANDLER_RETRIES} attempts: ${err.message ?? err}`);
                    }
                }
            }
        }
    }
    function bufferOrderedEvent(domain, event, messageId) {
        if (!_domainBuffers.has(domain)) {
            _domainBuffers.set(domain, { events: [], timer: null });
        }
        const buf = _domainBuffers.get(domain);
        buf.events.push({ event, messageId });
        if (buf.events.length >= ORDER_BUFFER_SIZE) {
            flushDomainBuffer(domain);
        }
        else if (!buf.timer) {
            buf.timer = setTimeout(() => flushDomainBuffer(domain), ORDER_FLUSH_MS);
        }
    }
    async function flushDomainBuffer(domain) {
        const buf = _domainBuffers.get(domain);
        if (!buf || buf.events.length === 0)
            return;
        if (buf.timer) {
            clearTimeout(buf.timer);
            buf.timer = null;
        }
        const entries = buf.events.splice(0);
        entries.sort((a, b) => {
            const aLamport = a.event.data?._lamport;
            const bLamport = b.event.data?._lamport;
            return (aLamport?.lamport ?? 0) - (bLamport?.lamport ?? 0);
        });
        for (const { event, messageId } of entries) {
            try {
                await dispatchToHandlers(event);
                _eventsDelivered++;
                await readClient.xack(STREAM_KEY, groupName, messageId);
            }
            catch (err) {
                log.error('Ordered event dispatch error', { type: event.type, domain }, err);
            }
        }
    }
    async function pollStream() {
        await connectPromise;
        await ensureGroup();
        while (!_shutdownRequested && _connected) {
            try {
                const results = await readClient.xreadgroup('GROUP', groupName, consumerId, 'COUNT', '10', 'BLOCK', String(BLOCK_MS), 'STREAMS', STREAM_KEY, '>');
                if (!results)
                    continue;
                for (const result of results) {
                    const messages = result[1];
                    for (const [messageId, fields] of messages) {
                        try {
                            const eventJson = fields[1];
                            if (!eventJson)
                                continue;
                            const event = JSON.parse(eventJson);
                            const remoteLamport = event.data?._lamport;
                            if (remoteLamport?.lamport) {
                                clock.receive(remoteLamport.lamport);
                            }
                            if (_dedupEnabled && event.id) {
                                const dedupKey = `shre:event:seen:${groupName}`;
                                const added = await readClient.sadd(dedupKey, event.id);
                                if (added === 0) {
                                    _eventsDedupSkipped++;
                                    log.debug('Duplicate event skipped', { id: event.id, type: event.type });
                                    await readClient.xack(STREAM_KEY, groupName, messageId);
                                    continue;
                                }
                                await readClient.expire(dedupKey, _dedupTtl, 'NX');
                                if (Math.random() < 0.01) {
                                    const size = await readClient.scard(dedupKey);
                                    if (size > _dedupMaxSize) {
                                        await readClient.spop(dedupKey, size - _dedupMaxSize);
                                    }
                                }
                            }
                            const eventDomain = event.type?.split('.')[0] ?? '';
                            if (eventDomain && _orderedDomains.has(eventDomain)) {
                                bufferOrderedEvent(eventDomain, event, messageId);
                                continue;
                            }
                            await dispatchToHandlers(event);
                            _eventsDelivered++;
                            await readClient.xack(STREAM_KEY, groupName, messageId);
                        }
                        catch (err) {
                            log.error('Event processing error', { messageId }, err);
                        }
                    }
                }
            }
            catch (err) {
                if (_shutdownRequested)
                    break;
                log.warn('Stream poll error — retrying', {}, err);
                await new Promise((r) => setTimeout(r, INITIAL_RETRY_MS));
            }
        }
    }
    const CRITICAL_BLOCK_MS = 1_000;
    async function pollCriticalStream() {
        await connectPromise;
        await ensureGroupForStream(CRITICAL_STREAM_KEY);
        while (!_shutdownRequested && _connected) {
            try {
                const results = await readClient.xreadgroup('GROUP', groupName, consumerId, 'COUNT', '10', 'BLOCK', String(CRITICAL_BLOCK_MS), 'STREAMS', CRITICAL_STREAM_KEY, '>');
                if (!results)
                    continue;
                for (const result of results) {
                    const messages = result[1];
                    for (const [messageId, fields] of messages) {
                        try {
                            const eventJson = fields[1];
                            if (!eventJson)
                                continue;
                            const event = JSON.parse(eventJson);
                            const remoteLamport2 = event.data?._lamport;
                            if (remoteLamport2?.lamport) {
                                clock.receive(remoteLamport2.lamport);
                            }
                            if (_dedupEnabled && event.id) {
                                const dedupKey = `shre:event:seen:critical:${groupName}`;
                                const added = await readClient.sadd(dedupKey, event.id);
                                if (added === 0) {
                                    _eventsDedupSkipped++;
                                    log.debug('Duplicate critical event skipped', { id: event.id, type: event.type });
                                    await readClient.xack(CRITICAL_STREAM_KEY, groupName, messageId);
                                    continue;
                                }
                                await readClient.expire(dedupKey, _dedupTtl, 'NX');
                                if (Math.random() < 0.01) {
                                    const size = await readClient.scard(dedupKey);
                                    if (size > _dedupMaxSize) {
                                        await readClient.spop(dedupKey, size - _dedupMaxSize);
                                    }
                                }
                            }
                            await dispatchToHandlers(event);
                            _eventsDelivered++;
                            await readClient.xack(CRITICAL_STREAM_KEY, groupName, messageId);
                        }
                        catch (err) {
                            log.error('Critical event processing error', { messageId }, err);
                        }
                    }
                }
            }
            catch (err) {
                if (_shutdownRequested)
                    break;
                log.warn('Critical stream poll error — retrying', {}, err);
                await new Promise((r) => setTimeout(r, INITIAL_RETRY_MS));
            }
        }
    }
    let pollStarted = false;
    let criticalPollStarted = false;
    function subscribe(typePattern, handler) {
        if (!handlers.has(typePattern)) {
            handlers.set(typePattern, new Set());
        }
        handlers.get(typePattern).add(handler);
        if (!pollStarted) {
            pollStarted = true;
            pollStream().catch((err) => {
                log.error('Stream poll fatal', {}, err);
            });
        }
        if (!criticalPollStarted) {
            criticalPollStarted = true;
            pollCriticalStream().catch((err) => {
                log.error('Critical stream poll fatal', {}, err);
            });
        }
        return () => {
            const set = handlers.get(typePattern);
            if (set) {
                set.delete(handler);
                if (set.size === 0)
                    handlers.delete(typePattern);
            }
        };
    }
    async function shutdown() {
        _shutdownRequested = true;
        stopReconnectLoop();
        for (const [domain, buf] of _domainBuffers) {
            if (buf.timer) {
                clearTimeout(buf.timer);
                buf.timer = null;
            }
            if (buf.events.length > 0) {
                try {
                    await flushDomainBuffer(domain);
                }
                catch (err) {
                    log.warn('Domain buffer flush failed during shutdown', {
                        domain,
                        error: err.message,
                    });
                }
            }
        }
        _domainBuffers.clear();
        log.info('Event bus shutting down', { bufferedEvents: _buffer.length });
        persistBuffer();
        try {
            await Promise.allSettled([writeClient.quit(), readClient.quit(), subClient.quit()]);
        }
        catch (err) {
            log.debug('[events] Shutdown error (ignored)', { error: err.message });
        }
        _connected = false;
    }
    return {
        publish,
        subscribe,
        broadcast,
        connected: () => _connected,
        bufferSize: () => _buffer.length,
        shutdown,
        publishPriority,
        createCancellationToken,
        cancelCorrelated,
        clock: () => clock,
        walStats: () => ({
            pendingCount: readEventWAL().length,
            lastReplayAt: _lastWalReplayAt,
            lastReplayResult: _lastWalReplayResult,
        }),
        metrics: () => ({
            published: _eventsPublished,
            delivered: _eventsDelivered,
            dlq: _eventsDlq,
            dedupSkipped: _eventsDedupSkipped,
            bufferSize: _buffer.length,
        }),
    };
}
export function createLifecycleEmitter(bus, serviceName, meta = {}) {
    const base = {
        service: serviceName,
        host: hostname(),
        pid: process.pid,
        ...meta,
    };
    return {
        started() {
            bus.publish('service.started', 'info', { ...base, uptime: 0 }).catch(() => { });
        },
        healthy(metrics) {
            bus
                .publish('service.health', 'info', {
                ...base,
                uptime: process.uptime(),
                memMB: Math.round(process.memoryUsage().rss / 1_048_576),
                ...metrics,
            })
                .catch(() => { });
        },
        stopping(reason) {
            bus
                .publish('service.stopping', 'warning', { ...base, reason: reason ?? 'signal' })
                .catch(() => { });
        },
    };
}
