import { randomUUID } from 'node:crypto';
const taskDedup = new Map();
const DEFAULT_DEDUP_MS = 5 * 60_000;
function shouldCreateTask(key, windowMs) {
    const last = taskDedup.get(key) ?? 0;
    if (Date.now() - last < windowMs)
        return false;
    taskDedup.set(key, Date.now());
    if (taskDedup.size > 200) {
        const cutoff = Date.now() - windowMs;
        for (const [k, ts] of taskDedup) {
            if (ts < cutoff)
                taskDedup.delete(k);
        }
    }
    return true;
}
const recentTraces = [];
const MAX_RECENT_TRACES = 500;
const recentFailures = [];
const MAX_RECENT_FAILURES = 200;
export function getRecentTraces(limit = 50) {
    return recentTraces.slice(-limit);
}
export function getRecentFailures(limit = 50) {
    return recentFailures.slice(-limit);
}
export function getTraceStats() {
    const total = recentTraces.length;
    const failures = recentFailures.length;
    const durations = recentTraces.filter((t) => t.totalMs).map((t) => t.totalMs);
    const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const spanCounts = new Map();
    for (const f of recentFailures) {
        if (f.failure?.spanName) {
            spanCounts.set(f.failure.spanName, (spanCounts.get(f.failure.spanName) ?? 0) + 1);
        }
    }
    const topFailingSpans = [...spanCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([span, count]) => ({ span, count }));
    return {
        total,
        failures,
        recentFailureRate: total > 0 ? Math.round((failures / total) * 100) / 100 : 0,
        avgDurationMs,
        topFailingSpans,
    };
}
function suggestFix(spanName, errorMsg) {
    const lower = errorMsg.toLowerCase();
    if (lower.includes('econnrefused') || lower.includes('connection refused')) {
        return `Service at ${spanName} is not running. Check LaunchAgent status: launchctl list | grep shre`;
    }
    if (lower.includes('429') || lower.includes('rate limit')) {
        return `Rate limited at ${spanName}. Check API key rotation or increase rate limit budget.`;
    }
    if (lower.includes('401') || lower.includes('unauthorized')) {
        return `Auth failure at ${spanName}. Check API key validity or token expiration.`;
    }
    if (lower.includes('timeout') || lower.includes('aborted')) {
        return `Timeout at ${spanName}. Service may be overloaded or Ollama model loading slow.`;
    }
    if (lower.includes('budget') || lower.includes('blocked')) {
        return `Budget exceeded at ${spanName}. Check agent budget: GET /v1/budgets/:agentId`;
    }
    if (lower.includes('untrusted') || lower.includes('unknown agent')) {
        return `Agent not in trusted registry. Add to trusted-agents.json and restart shre-router.`;
    }
    if (lower.includes('no models') || lower.includes('model not found')) {
        return `Model unavailable at ${spanName}. Check Ollama tags or provider connectivity.`;
    }
    if (lower.includes('permission') || lower.includes('denied') || lower.includes('tool')) {
        return `Permission denied at ${spanName}. Check tool grants: GET /v1/tools/grants/:agentId`;
    }
    if (lower.includes('relation') || lower.includes('does not exist') || lower.includes('column')) {
        return `Database schema mismatch at ${spanName}. Run smart-refresh or check CortexDB views.`;
    }
    return `Failure at ${spanName}: ${errorMsg.slice(0, 200)}. Check service logs for details.`;
}
export class Trace {
    traceId;
    correlationId;
    service;
    _startedAt;
    _spans = [];
    _currentSpan = null;
    _request = {};
    _opts;
    _completed = false;
    constructor(service, correlationId, opts) {
        this.traceId = `trc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        this.correlationId = correlationId ?? randomUUID().slice(0, 12);
        this.service = service;
        this._startedAt = Date.now();
        this._opts = opts ?? {};
    }
    setRequest(meta) {
        this._request = { ...this._request, ...meta };
        return this;
    }
    span(name, data) {
        if (this._currentSpan && !this._currentSpan.endedAt) {
            this._currentSpan.endedAt = Date.now();
            this._currentSpan.durationMs = this._currentSpan.endedAt - this._currentSpan.startedAt;
            if (this._currentSpan.status !== 'error') {
                this._currentSpan.status = 'ok';
            }
        }
        const span = {
            name,
            startedAt: Date.now(),
            status: 'ok',
            data,
        };
        this._spans.push(span);
        this._currentSpan = span;
        return this;
    }
    fail(spanNameOrError, errorOrData, data) {
        let targetSpan;
        let error;
        let extraData;
        if (typeof spanNameOrError === 'string' && errorOrData instanceof Error) {
            targetSpan =
                this._spans.find((s) => s.name === spanNameOrError) ?? this._currentSpan ?? undefined;
            error = errorOrData;
            extraData = data;
        }
        else if (spanNameOrError instanceof Error) {
            targetSpan = this._currentSpan ?? undefined;
            error = spanNameOrError;
            extraData = errorOrData;
        }
        else {
            targetSpan =
                this._spans.find((s) => s.name === spanNameOrError) ?? this._currentSpan ?? undefined;
            error = new Error(spanNameOrError);
            extraData = errorOrData;
        }
        if (!targetSpan) {
            targetSpan = {
                name: typeof spanNameOrError === 'string' ? spanNameOrError : 'unknown',
                startedAt: Date.now(),
                status: 'error',
            };
            this._spans.push(targetSpan);
        }
        targetSpan.status = 'error';
        targetSpan.endedAt = Date.now();
        targetSpan.durationMs = targetSpan.endedAt - targetSpan.startedAt;
        targetSpan.error = {
            message: error.message,
            stack: error.stack,
            code: error.code,
        };
        if (extraData) {
            targetSpan.data = { ...targetSpan.data, ...extraData };
        }
        return this;
    }
    skip(spanName, reason) {
        const span = {
            name: spanName,
            startedAt: Date.now(),
            endedAt: Date.now(),
            durationMs: 0,
            status: 'skipped',
            data: reason ? { reason } : undefined,
        };
        this._spans.push(span);
        return this;
    }
    ack(spanName, opts) {
        const span = this._spans.find((s) => s.name === spanName);
        if (span) {
            const now = Date.now();
            span.ack = {
                received: true,
                ackId: opts?.ackId ?? `ack_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
                ackedAt: now,
                ackLatencyMs: span.startedAt ? now - span.startedAt : undefined,
                source: opts?.source,
            };
        }
        return this;
    }
    getAckGaps() {
        return this._spans
            .filter((s) => s.status === 'ok' && s.endedAt && !s.ack?.received)
            .map((s) => s.name);
    }
    end() {
        return this._complete('ok');
    }
    endWithError(spanName, error, extraData) {
        if (spanName && error) {
            this.fail(spanName, error, extraData);
        }
        return this._complete('error');
    }
    _complete(overrideStatus) {
        if (this._completed)
            return this.toRecord();
        this._completed = true;
        if (this._currentSpan && !this._currentSpan.endedAt) {
            this._currentSpan.endedAt = Date.now();
            this._currentSpan.durationMs = this._currentSpan.endedAt - this._currentSpan.startedAt;
        }
        const hasErrors = this._spans.some((s) => s.status === 'error');
        const status = overrideStatus ?? (hasErrors ? 'error' : 'ok');
        const record = this.toRecord();
        record.status = status;
        record.endedAt = new Date().toISOString();
        record.totalMs = Date.now() - this._startedAt;
        if (hasErrors) {
            const failedSpan = this._spans.find((s) => s.status === 'error');
            if (failedSpan) {
                record.failure = {
                    spanName: failedSpan.name,
                    error: failedSpan.error?.message ?? 'Unknown error',
                    errorCode: failedSpan.error?.code,
                    suggestion: suggestFix(failedSpan.name, failedSpan.error?.message ?? ''),
                };
            }
        }
        const ackableSpans = this._spans.filter((s) => s.status !== 'skipped');
        const ackedSpans = ackableSpans.filter((s) => s.ack?.received);
        const gaps = ackableSpans.filter((s) => !s.ack?.received).map((s) => s.name);
        if (ackableSpans.length > 0) {
            record.ackSummary = {
                total: ackableSpans.length,
                acked: ackedSpans.length,
                unacked: gaps.length,
                gaps,
            };
        }
        recentTraces.push(record);
        if (recentTraces.length > MAX_RECENT_TRACES)
            recentTraces.shift();
        if (hasErrors) {
            recentFailures.push(record);
            if (recentFailures.length > MAX_RECENT_FAILURES)
                recentFailures.shift();
        }
        this._asyncComplete(record).catch(() => { });
        this._opts.onComplete?.(record);
        return record;
    }
    async _asyncComplete(record) {
        if (this._opts.cortexWrite) {
            try {
                await this._opts.cortexWrite('request_trace', record);
            }
            catch {
            }
        }
        if (this._opts.publishFn) {
            const severity = record.status === 'error' ? 'warning' : 'info';
            try {
                await this._opts.publishFn('trace.completed', severity, {
                    traceId: record.traceId,
                    service: record.service,
                    status: record.status,
                    totalMs: record.totalMs,
                    failure: record.failure,
                    agentId: record.request?.agentId,
                });
            }
            catch {
            }
        }
        if (record.status === 'error' && record.failure && this._opts.autoCreateTasks !== false) {
            const dedupKey = `${record.service}:${record.failure.spanName}:${record.failure.errorCode ?? record.failure.error.slice(0, 50)}`;
            const dedupMs = this._opts.dedupWindowMs ?? DEFAULT_DEDUP_MS;
            if (shouldCreateTask(dedupKey, dedupMs)) {
                await this._createFailureTask(record);
            }
        }
    }
    async _createFailureTask(record) {
        const tasksUrl = this._opts.tasksUrl ?? 'http://127.0.0.1:5460';
        const traceRoute = record.spans
            .map((s) => {
            const dur = s.durationMs != null ? `${s.durationMs}ms` : '?';
            const icon = s.status === 'ok' ? '✓' : s.status === 'error' ? '✗' : '○';
            return `${icon} ${s.name} (${dur})`;
        })
            .join(' → ');
        const description = [
            `## Trace Route`,
            '```',
            traceRoute,
            '```',
            '',
            `**Trace ID:** \`${record.traceId}\``,
            `**Correlation ID:** \`${record.correlationId}\``,
            `**Service:** ${record.service}`,
            `**Total Duration:** ${record.totalMs}ms`,
            `**Agent:** ${record.request?.agentId ?? 'unknown'}`,
            `**Model:** ${record.request?.model ?? 'unknown'}`,
            '',
            `## Failure`,
            `**Span:** \`${record.failure.spanName}\``,
            `**Error:** ${record.failure.error}`,
            record.failure.errorCode ? `**Code:** ${record.failure.errorCode}` : '',
            '',
            `## Suggested Fix`,
            record.failure.suggestion ?? 'Check service logs.',
            '',
            `## Full Span Data`,
            '```json',
            JSON.stringify(record.spans
                .filter((s) => s.status === 'error')
                .map((s) => ({
                name: s.name,
                error: s.error,
                data: s.data,
                durationMs: s.durationMs,
            })), null, 2),
            '```',
        ]
            .filter(Boolean)
            .join('\n');
        try {
            await fetch(`${tasksUrl}/v1/intake`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `[Trace] ${record.failure.spanName} failed in ${record.service} — ${record.failure.error.slice(0, 80)}`,
                    description,
                    priority: 'high',
                    source: 'trace',
                    category: 'error',
                    dedupe_tag: `trace-${record.service}-${record.failure.spanName}`,
                    skip_decompose: true,
                    source_meta: {
                        traceId: record.traceId,
                        correlationId: record.correlationId,
                        service: record.service,
                        spanName: record.failure.spanName,
                        error: record.failure.error,
                        agentId: record.request?.agentId,
                        model: record.request?.model,
                        tags: ['trace', 'auto-heal', record.service, record.failure.spanName],
                    },
                }),
                signal: AbortSignal.timeout(5000),
            });
        }
        catch {
        }
    }
    toRecord() {
        return {
            traceId: this.traceId,
            correlationId: this.correlationId,
            service: this.service,
            startedAt: new Date(this._startedAt).toISOString(),
            spans: [...this._spans],
            request: { ...this._request },
            status: this._spans.some((s) => s.status === 'error') ? 'error' : 'ok',
        };
    }
}
export function createTrace(service, correlationId, opts) {
    return new Trace(service, correlationId, opts);
}
export function createTraceDefaults(config) {
    return {
        cortexWrite: config.cortexWrite,
        publishFn: config.publishFn,
        tasksUrl: config.tasksUrl ?? 'http://127.0.0.1:5460',
        autoCreateTasks: config.autoCreateTasks ?? true,
    };
}
export function createTraceMiddleware(service, opts) {
    return function traceMiddleware(...args) {
        if (args.length >= 3 &&
            args[0]?.headers &&
            typeof args[0]?.headers === 'object' &&
            typeof args[2] === 'function') {
            _expressTrace(service, opts, args[0], args[1], args[2]);
            return;
        }
        return _honoTrace(service, opts, args[0], args[1]);
    };
}
async function _honoTrace(service, opts, c, next) {
    const correlationId = c.req.header('x-correlation-id') ?? c.req.header('x-request-id') ?? randomUUID().slice(0, 12);
    const trace = new Trace(service, correlationId, opts);
    trace.setRequest({ method: c.req.method, path: c.req.path });
    c.set('trace', trace);
    const ackId = `ack_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    c.header('X-Trace-Id', trace.traceId);
    c.header('X-Correlation-Id', trace.correlationId);
    c.header('X-Ack-Id', ackId);
    try {
        await next();
        trace.ack('request', { ackId, source: service });
        if (c.res.status >= 400) {
            trace.endWithError('response', new Error(`HTTP ${c.res.status}`));
        }
        else {
            trace.end();
        }
    }
    catch (err) {
        trace.endWithError('unhandled', err instanceof Error ? err : new Error(String(err)));
        throw err;
    }
}
function _expressTrace(service, opts, req, res, next) {
    const correlationId = req.headers['x-correlation-id'] ??
        req.headers['x-request-id'] ??
        randomUUID().slice(0, 12);
    const trace = new Trace(service, correlationId, opts);
    trace.setRequest({ method: req.method, path: req.path || req.url });
    req.trace = trace;
    const ackId = `ack_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    res.setHeader('X-Trace-Id', trace.traceId);
    res.setHeader('X-Correlation-Id', trace.correlationId);
    res.setHeader('X-Ack-Id', ackId);
    res.on('finish', () => {
        trace.ack('request', { ackId, source: service });
        if (res.statusCode >= 400) {
            trace.endWithError('response', new Error(`HTTP ${res.statusCode}`));
        }
        else {
            trace.end();
        }
    });
    next();
}
export function traceContextHeaders(trace) {
    return {
        'X-Trace-Id': trace.traceId,
        'X-Correlation-Id': trace.correlationId,
        'X-Source-Service': trace.service,
        'X-Ack-Id': `ack_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    };
}
export function getAckGaps(limit = 50) {
    return recentTraces
        .filter((t) => t.ackSummary && t.ackSummary.unacked > 0)
        .slice(-limit)
        .reverse()
        .map((t) => ({
        traceId: t.traceId,
        service: t.service,
        gaps: t.ackSummary.gaps,
        ts: t.startedAt,
    }));
}
export function getAckStats() {
    const gapCounts = new Map();
    let fullyAcked = 0;
    let partialAck = 0;
    let noAck = 0;
    for (const t of recentTraces) {
        if (!t.ackSummary || t.ackSummary.total === 0)
            continue;
        if (t.ackSummary.unacked === 0)
            fullyAcked++;
        else if (t.ackSummary.acked > 0)
            partialAck++;
        else
            noAck++;
        for (const gap of t.ackSummary.gaps) {
            gapCounts.set(gap, (gapCounts.get(gap) || 0) + 1);
        }
    }
    const topGapSpans = [...gapCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([span, count]) => ({ span, count }));
    return { totalTraces: recentTraces.length, fullyAcked, partialAck, noAck, topGapSpans };
}
