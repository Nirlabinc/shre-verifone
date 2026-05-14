import { createLogger } from './logger.js';
import { createCortexClient, createBufferedWriter } from './cortex.js';
import { z } from 'zod';
const log = createLogger('shre-sdk:training');
const TrainingMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1, 'Message content cannot be empty'),
});
const TrainingRecordSchema = z
    .object({
    id: z.string().optional(),
    source: z.string().min(1),
    agentId: z.string().min(1),
    messages: z.array(TrainingMessageSchema).min(1, 'At least one message required'),
    quality: z.number().nullable(),
    model: z.string().min(1),
    tenantId: z.string().min(1),
    taskType: z.string().optional(),
    domain: z.string().optional(),
    durationMs: z.number().optional(),
    tokens: z.object({ input: z.number(), output: z.number() }).optional(),
    skills: z.array(z.object({ skill: z.string(), level: z.number() })).optional(),
    conversationType: z.enum(['chat', 'voice', 'fleet', 'task', 'evaluation']),
    meta: z.record(z.unknown()).optional(),
})
    .passthrough();
function sanitizeForJson(obj) {
    if (obj === null || obj === undefined)
        return obj;
    if (typeof obj === 'number' && (isNaN(obj) || !isFinite(obj)))
        return null;
    if (typeof obj === 'string')
        return obj;
    if (Array.isArray(obj))
        return obj.map(sanitizeForJson);
    if (typeof obj === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v !== 'function' && typeof v !== 'symbol') {
                result[k] = sanitizeForJson(v);
            }
        }
        return result;
    }
    return obj;
}
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const WAL_DIR = join(homedir(), '.shre', 'training', 'wal');
const BACKUP_DIR = join(homedir(), '.shre', 'training', 'backup');
const REJECTED_DIR = join(homedir(), '.shre', 'training', 'rejected');
function ensureDirs() {
    for (const dir of [WAL_DIR, BACKUP_DIR, REJECTED_DIR]) {
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
    }
}
function contentHash(record) {
    const content = record.messages.map((m) => m.content).join('|');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
let cortex = null;
let bufferedWriter = null;
function getCortex() {
    if (!cortex)
        cortex = createCortexClient('training-writer');
    return cortex;
}
export function enableBufferedTraining(opts) {
    if (bufferedWriter)
        return;
    bufferedWriter = createBufferedWriter(getCortex(), {
        flushIntervalMs: opts?.flushIntervalMs ?? 5_000,
        maxBufferSize: opts?.maxBufferSize ?? 50,
        logger: log,
    });
    if (opts?.publishFn) {
        _trainingPublishFn = opts.publishFn;
    }
    log.info('Training buffered write mode enabled', {
        flushIntervalMs: opts?.flushIntervalMs ?? 5_000,
    });
}
export async function shutdownBufferedTraining() {
    if (bufferedWriter) {
        await bufferedWriter.shutdown();
        bufferedWriter = null;
    }
}
const RETRY_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];
const MAX_WAL_AGE_MS = 24 * 60 * 60 * 1000;
const TRAINING_GATE_ENABLED = process.env.TRAINING_GATE_ENABLED !== 'false';
const TRAINING_QUALITY_THRESHOLD = 0.7;
const TRAINING_GROUNDING_THRESHOLD = 0.7;
let _trainingRejectionCount = 0;
let _trainingAcceptCount = 0;
let _trainingPublishFn = null;
export function setTrainingPublisher(fn) {
    _trainingPublishFn = fn;
}
export function getTrainingGateStats() {
    return {
        accepted: _trainingAcceptCount,
        rejected: _trainingRejectionCount,
        gateEnabled: TRAINING_GATE_ENABLED,
    };
}
const SANITIZED_REFUSAL_PATTERNS = [
    /as an ai.*?i (?:can't|cannot)(?!.*(?:permission|access|authorized|credentials))/i,
    /i'm (?:sorry|afraid).*?(?:can't|cannot|unable)(?!.*(?:permission|access|authorized|data.+not available))/i,
    /beyond (?:my|the) (?:scope|capability)(?!.*(?:permission|access))/i,
];
export function trainingGate(record) {
    if (!TRAINING_GATE_ENABLED)
        return { passed: true };
    const qualityNormalized = record.quality !== null && record.quality !== undefined
        ? record.quality >= 2
            ? record.quality / 5
            : record.quality
        : null;
    if (qualityNormalized !== null && qualityNormalized < TRAINING_QUALITY_THRESHOLD) {
        return {
            passed: false,
            reason: `quality_below_threshold (${qualityNormalized.toFixed(2)} < ${TRAINING_QUALITY_THRESHOLD})`,
        };
    }
    const groundingScore = record.meta?.groundingScore;
    if (groundingScore !== undefined && groundingScore < TRAINING_GROUNDING_THRESHOLD) {
        return {
            passed: false,
            reason: `grounding_below_threshold (${groundingScore.toFixed(2)} < ${TRAINING_GROUNDING_THRESHOLD})`,
        };
    }
    const assistantMessages = record.messages.filter((m) => m.role === 'assistant');
    for (const msg of assistantMessages) {
        for (const pattern of SANITIZED_REFUSAL_PATTERNS) {
            if (pattern.test(msg.content)) {
                return { passed: false, reason: `contains_sanitized_refusal` };
            }
        }
    }
    return { passed: true };
}
function writeRejectedTraining(record, reason) {
    try {
        ensureDirs();
        const rejectedFile = join(REJECTED_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
        const entry = sanitizeForJson({
            ...record,
            _rejectedAt: new Date().toISOString(),
            _rejectionReason: reason,
            _hash: contentHash(record),
        });
        appendFileSync(rejectedFile, JSON.stringify(entry) + '\n');
        log.info('Training record rejected and saved for review', {
            reason,
            source: record.source,
            agentId: record.agentId,
            quality: record.quality,
        });
    }
    catch (err) {
        log.error('Failed to write rejected training record', { error: err.message });
    }
}
export async function writeTrainingData(record) {
    ensureDirs();
    const validation = TrainingRecordSchema.safeParse(record);
    if (!validation.success) {
        log.error('Training record failed schema validation — skipping write', {
            errors: validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            source: record.source,
            agentId: record.agentId,
        });
        return { ok: false, hash: '' };
    }
    const gateResult = trainingGate(record);
    if (!gateResult.passed) {
        writeRejectedTraining(record, gateResult.reason);
        _trainingRejectionCount++;
        if (_trainingPublishFn) {
            _trainingPublishFn('training.rejected', 'warning', {
                source: record.source,
                agentId: record.agentId,
                reason: gateResult.reason,
                quality: record.quality,
            }).catch(() => { });
        }
        return { ok: false, hash: contentHash(record) };
    }
    _trainingAcceptCount++;
    const hash = contentHash(record);
    if (!record.id)
        record.id = `train-${hash}-${Date.now()}`;
    const enrichedRecord = sanitizeForJson({
        ...record,
        _hash: hash,
        _writtenAt: new Date().toISOString(),
        _totalChars: record.messages.reduce((sum, m) => sum + m.content.length, 0),
    });
    try {
        const backupFile = join(BACKUP_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
        appendFileSync(backupFile, JSON.stringify(enrichedRecord) + '\n');
    }
    catch (err) {
        log.error('CRITICAL: Local training backup failed', { error: err.message, hash });
    }
    const cortexPayload = {
        id: record.id,
        hash,
        source: record.source,
        agentId: record.agentId,
        messages: record.messages,
        quality: record.quality,
        model: record.model,
        tenantId: record.tenantId,
        taskType: record.taskType,
        domain: record.domain,
        durationMs: record.durationMs,
        tokens: record.tokens,
        skills: record.skills,
        conversationType: record.conversationType,
        meta: record.meta,
        totalChars: enrichedRecord._totalChars,
        timestamp: enrichedRecord._writtenAt,
    };
    if (bufferedWriter) {
        bufferedWriter.queue('training_record', cortexPayload);
        log.info('Training data buffered', {
            hash,
            source: record.source,
            agentId: record.agentId,
            type: record.conversationType,
            chars: enrichedRecord._totalChars,
            pending: bufferedWriter.pending(),
        });
        return { ok: true, hash };
    }
    try {
        await getCortex().write('training_record', cortexPayload);
        log.info('Training data written', {
            hash,
            source: record.source,
            agentId: record.agentId,
            type: record.conversationType,
            chars: enrichedRecord._totalChars,
            quality: record.quality,
        });
        return { ok: true, hash };
    }
    catch (err) {
        log.warn('CortexDB write failed, queuing to WAL', { error: err.message, hash });
        try {
            const walEntry = {
                record: enrichedRecord,
                hash,
                attempts: 0,
                createdAt: Date.now(),
                lastAttemptAt: 0,
            };
            const walFile = join(WAL_DIR, `${hash}.json`);
            writeFileSync(walFile, JSON.stringify(walEntry));
        }
        catch (walErr) {
            log.error('WAL write also failed — data only in local backup', {
                error: walErr.message,
                hash,
            });
        }
        return { ok: false, hash };
    }
}
export async function writeConversation(opts) {
    return writeTrainingData({
        source: opts.source,
        agentId: opts.agentId,
        messages: opts.messages,
        quality: opts.quality ?? null,
        model: opts.model,
        tenantId: opts.tenantId || 'platform',
        conversationType: 'chat',
        durationMs: opts.durationMs,
        tokens: opts.tokens,
        taskType: opts.taskType,
        domain: opts.domain,
        meta: opts.meta,
    });
}
export async function writeVoiceInteraction(opts) {
    return writeTrainingData({
        source: 'shre-voice',
        agentId: opts.agentId,
        messages: [
            { role: 'user', content: opts.userTranscript },
            { role: 'assistant', content: opts.assistantResponse },
        ],
        quality: opts.quality ?? null,
        model: opts.model,
        tenantId: opts.tenantId || 'platform',
        conversationType: 'voice',
        durationMs: opts.durationMs,
        meta: { sttModel: opts.sttModel, ttsModel: opts.ttsModel },
    });
}
export async function writeFleetExecution(opts) {
    return writeTrainingData({
        source: 'shre-fleet',
        agentId: opts.agentId,
        messages: [
            { role: 'system', content: 'You are a fleet agent executing a task.' },
            { role: 'user', content: opts.taskBrief },
            { role: 'assistant', content: opts.agentOutput },
        ],
        quality: opts.quality ?? null,
        model: opts.model,
        tenantId: 'platform',
        taskType: opts.taskType,
        domain: opts.domain,
        conversationType: 'fleet',
        durationMs: opts.durationMs,
    });
}
let replayTimer = null;
export function startWALReplay(intervalMs = 60_000) {
    if (replayTimer)
        return;
    replayTimer = setInterval(async () => {
        try {
            await replayWAL();
        }
        catch (err) {
            log.debug('WAL replay cycle error', { error: err.message });
        }
    }, intervalMs);
    replayTimer.unref();
    log.info('Training WAL replay started', { intervalMs });
}
async function replayWAL() {
    ensureDirs();
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(WAL_DIR).filter((f) => f.endsWith('.json'));
    if (files.length === 0)
        return;
    log.info(`WAL replay: ${files.length} entries pending`);
    for (const file of files) {
        const walPath = join(WAL_DIR, file);
        try {
            const raw = readFileSync(walPath, 'utf-8');
            const entry = JSON.parse(raw);
            if (Date.now() - entry.createdAt > MAX_WAL_AGE_MS) {
                log.warn('WAL entry expired (24h), archiving', { hash: entry.hash });
                const archivePath = join(BACKUP_DIR, `wal-expired-${file}`);
                writeFileSync(archivePath, raw);
                unlinkSync(walPath);
                continue;
            }
            const backoffMs = RETRY_BACKOFF_MS[Math.min(entry.attempts, RETRY_BACKOFF_MS.length - 1)] ?? 60000;
            if (Date.now() - entry.lastAttemptAt < backoffMs)
                continue;
            entry.attempts++;
            entry.lastAttemptAt = Date.now();
            await getCortex().write('training_record', {
                ...entry.record,
                _walReplay: true,
                _walAttempt: entry.attempts,
            });
            unlinkSync(walPath);
            log.info('WAL entry replayed successfully', { hash: entry.hash, attempts: entry.attempts });
        }
        catch (err) {
            try {
                const entry = JSON.parse(readFileSync(walPath, 'utf-8'));
                entry.attempts++;
                entry.lastAttemptAt = Date.now();
                if (entry.attempts >= RETRY_BACKOFF_MS.length) {
                    log.error('WAL entry max retries reached, archiving', { hash: entry.hash });
                    const archivePath = join(BACKUP_DIR, `wal-failed-${file}`);
                    writeFileSync(archivePath, JSON.stringify(entry));
                    unlinkSync(walPath);
                }
                else {
                    writeFileSync(walPath, JSON.stringify(entry));
                }
            }
            catch (err) {
                log.warn('[training] WAL file itself corrupted, leaving in place', {
                    error: err.message,
                });
            }
        }
    }
}
export function stopWALReplay() {
    if (replayTimer) {
        clearInterval(replayTimer);
        replayTimer = null;
    }
}
const stats = {
    written: 0,
    failed: 0,
    walQueued: 0,
    walReplayed: 0,
};
export function getTrainingStats() {
    return { ...stats };
}
