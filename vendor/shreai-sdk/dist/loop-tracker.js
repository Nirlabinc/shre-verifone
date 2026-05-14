import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
const log = createLogger('loop-tracker');
const MAX_RECENT = 500;
const MAX_SLOW = 100;
const recentLoops = [];
const slowLoops = [];
const SLOW_THRESHOLD_MS = 10_000;
const percentileWindows = {};
const PERCENTILE_WINDOW = 1000;
function recordDuration(key, ms) {
    if (!percentileWindows[key]) {
        percentileWindows[key] = { durations: [], maxSize: PERCENTILE_WINDOW };
    }
    const win = percentileWindows[key];
    win.durations.push(ms);
    if (win.durations.length > win.maxSize) {
        win.durations.shift();
    }
}
function getPercentile(key, p) {
    const win = percentileWindows[key];
    if (!win || win.durations.length === 0)
        return null;
    const sorted = [...win.durations].sort((a, b) => a - b);
    const idx = Math.min(Math.floor(sorted.length * (p / 100)), sorted.length - 1);
    return sorted[idx] ?? null;
}
export class Loop {
    callbacks;
    record;
    currentSegment = null;
    closed = false;
    constructor(service, opts, callbacks) {
        this.callbacks = callbacks;
        const now = Date.now();
        this.record = {
            loopId: randomUUID(),
            correlationId: opts.correlationId ?? randomUUID(),
            traceId: opts.traceId,
            service,
            agentId: opts.agentId,
            sessionId: opts.sessionId,
            tenantId: opts.tenantId,
            model: opts.model,
            requestType: opts.requestType,
            startedAt: new Date(now).toISOString(),
            status: 'open',
            segments: [],
            marks: [],
            partialCount: 0,
            partials: [],
        };
    }
    get loopId() {
        return this.record.loopId;
    }
    get correlationId() {
        return this.record.correlationId;
    }
    segment(name, data) {
        if (this.closed)
            return this;
        this.closeCurrentSegment();
        const now = Date.now();
        this.currentSegment = {
            name,
            startedAt: now,
            data,
        };
        return this;
    }
    mark(name, _data) {
        if (this.closed)
            return this;
        const now = Date.now();
        const loopStart = new Date(this.record.startedAt).getTime();
        this.record.marks.push({
            name,
            ts: now,
            offsetMs: now - loopStart,
        });
        return this;
    }
    partial(note) {
        if (this.closed)
            return this;
        this.record.partialCount++;
        this.record.partials.push({ ts: Date.now(), note });
        this.record.status = 'partial';
        return this;
    }
    setModel(model) {
        this.record.model = model;
        return this;
    }
    complete(opts) {
        if (this.closed)
            return this.record;
        this.closeCurrentSegment();
        const now = Date.now();
        const loopStart = new Date(this.record.startedAt).getTime();
        this.record.endedAt = new Date(now).toISOString();
        this.record.totalMs = now - loopStart;
        this.record.status = 'complete';
        this.record.quality = opts?.quality;
        this.record.tokensIn = opts?.tokensIn;
        this.record.tokensOut = opts?.tokensOut;
        this.record.completionType = opts?.completionType;
        this.record.breakdown = this.computeBreakdown();
        this.closed = true;
        this.persist();
        return this.record;
    }
    fail(error, segment) {
        if (this.closed)
            return this.record;
        this.closeCurrentSegment();
        const now = Date.now();
        const loopStart = new Date(this.record.startedAt).getTime();
        this.record.endedAt = new Date(now).toISOString();
        this.record.totalMs = now - loopStart;
        this.record.status = 'failed';
        this.record.error = { message: error, segment };
        this.record.breakdown = this.computeBreakdown();
        this.closed = true;
        this.persist();
        return this.record;
    }
    timeout() {
        return this.fail('Loop exceeded timeout threshold', this.currentSegment?.name);
    }
    toRecord() {
        return { ...this.record };
    }
    closeCurrentSegment() {
        if (!this.currentSegment)
            return;
        const now = Date.now();
        this.currentSegment.endedAt = now;
        this.currentSegment.durationMs = now - this.currentSegment.startedAt;
        this.record.segments.push(this.currentSegment);
        this.currentSegment = null;
    }
    computeBreakdown() {
        const bySegment = {};
        const totalMs = this.record.totalMs ?? 1;
        for (const seg of this.record.segments) {
            const ms = seg.durationMs ?? 0;
            if (!bySegment[seg.name]) {
                bySegment[seg.name] = { totalMs: 0, count: 0, avgMs: 0 };
            }
            bySegment[seg.name].totalMs += ms;
            bySegment[seg.name].count++;
        }
        const pctBySegment = {};
        let bottleneck = { segment: 'unknown', durationMs: 0, pctOfTotal: 0 };
        for (const [name, stats] of Object.entries(bySegment)) {
            stats.avgMs = Math.round(stats.totalMs / stats.count);
            const pct = Math.round((stats.totalMs / totalMs) * 10000) / 100;
            pctBySegment[name] = pct;
            if (stats.totalMs > bottleneck.durationMs) {
                bottleneck = { segment: name, durationMs: stats.totalMs, pctOfTotal: pct };
            }
        }
        const loopStart = new Date(this.record.startedAt).getTime();
        const ttftMark = this.record.marks.find((m) => m.name === 'ttft');
        const firstPartial = this.record.partials[0];
        return {
            bySegment,
            ttftMs: ttftMark?.offsetMs,
            timeToFirstPartialMs: firstPartial ? firstPartial.ts - loopStart : undefined,
            timeToCompleteMs: this.record.totalMs,
            pctBySegment,
            bottleneck,
        };
    }
    persist() {
        recentLoops.push(this.record);
        if (recentLoops.length > MAX_RECENT)
            recentLoops.shift();
        if (this.record.totalMs && this.record.totalMs > SLOW_THRESHOLD_MS) {
            slowLoops.push(this.record);
            if (slowLoops.length > MAX_SLOW)
                slowLoops.shift();
            log.warn('[loop-tracker] Slow loop detected', {
                loopId: this.record.loopId,
                totalMs: this.record.totalMs,
                bottleneck: this.record.breakdown?.bottleneck.segment,
                agentId: this.record.agentId,
            });
        }
        if (this.record.totalMs) {
            recordDuration('loop:total', this.record.totalMs);
            recordDuration(`loop:${this.record.requestType}`, this.record.totalMs);
            if (this.record.agentId) {
                recordDuration(`loop:agent:${this.record.agentId}`, this.record.totalMs);
            }
            for (const seg of this.record.segments) {
                if (seg.durationMs) {
                    recordDuration(`segment:${seg.name}`, seg.durationMs);
                }
            }
            const ttft = this.record.breakdown?.ttftMs;
            if (ttft)
                recordDuration('mark:ttft', ttft);
        }
        this.callbacks.onComplete?.(this.record);
        this.callbacks
            .cortexWrite?.('loop_record', {
            _id: this.record.loopId,
            ...this.record,
        })
            .catch(() => { });
        this.callbacks
            .publishFn?.(this.record.status === 'failed' ? 'loop.failed' : 'loop.complete', this.record.status === 'failed' ? 'warning' : 'info', {
            loopId: this.record.loopId,
            correlationId: this.record.correlationId,
            agentId: this.record.agentId,
            totalMs: this.record.totalMs,
            status: this.record.status,
            bottleneck: this.record.breakdown?.bottleneck.segment,
            partialCount: this.record.partialCount,
            quality: this.record.quality,
        })
            .catch(() => { });
    }
}
export function createLoopTracker(service, callbacks = {}) {
    return {
        start(opts) {
            return new Loop(service, opts, callbacks);
        },
    };
}
export function getRecentLoops(limit = 50) {
    return recentLoops.slice(-limit).reverse();
}
export function getSlowLoops(limit = 50) {
    return slowLoops.slice(-limit).reverse();
}
export function getLoopStats() {
    const complete = recentLoops.filter((l) => l.status === 'complete');
    const failed = recentLoops.filter((l) => l.status === 'failed');
    const partial = recentLoops.filter((l) => l.status === 'partial');
    const durations = complete.filter((l) => l.totalMs).map((l) => l.totalMs);
    const avgTotal = durations.length > 0 ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0;
    const partialCounts = recentLoops.map((l) => l.partialCount);
    const avgPartial = partialCounts.length > 0
        ? Math.round((partialCounts.reduce((s, c) => s + c, 0) / partialCounts.length) * 10) / 10
        : 0;
    const byType = {};
    const typeGroups = {};
    for (const l of complete) {
        if (!l.totalMs)
            continue;
        const t = l.requestType;
        if (!typeGroups[t])
            typeGroups[t] = [];
        typeGroups[t].push(l.totalMs);
    }
    for (const [type, durs] of Object.entries(typeGroups)) {
        const avg = Math.round(durs.reduce((s, d) => s + d, 0) / durs.length);
        byType[type] = {
            count: durs.length,
            avgMs: avg,
            p95Ms: getPercentile(`loop:${type}`, 95),
        };
    }
    const segNames = new Set();
    for (const l of recentLoops) {
        for (const seg of l.segments)
            segNames.add(seg.name);
    }
    const bySegment = {};
    for (const name of segNames) {
        const key = `segment:${name}`;
        const win = percentileWindows[key];
        if (!win || win.durations.length === 0)
            continue;
        const avg = Math.round(win.durations.reduce((s, d) => s + d, 0) / win.durations.length);
        bySegment[name] = {
            avgMs: avg,
            p50Ms: getPercentile(key, 50),
            p95Ms: getPercentile(key, 95),
        };
    }
    const ttftWin = percentileWindows['mark:ttft'];
    const ttft = ttftWin && ttftWin.durations.length > 0
        ? {
            avgMs: Math.round(ttftWin.durations.reduce((s, d) => s + d, 0) / ttftWin.durations.length),
            p50Ms: getPercentile('mark:ttft', 50),
            p95Ms: getPercentile('mark:ttft', 95),
        }
        : null;
    return {
        total: recentLoops.length,
        complete: complete.length,
        failed: failed.length,
        partial: partial.length,
        avgTotalMs: avgTotal,
        p50Ms: getPercentile('loop:total', 50),
        p95Ms: getPercentile('loop:total', 95),
        p99Ms: getPercentile('loop:total', 99),
        slowCount: slowLoops.length,
        avgPartialCount: avgPartial,
        byRequestType: byType,
        bySegment,
        ttft,
    };
}
export function getAgentLoopStats(agentId) {
    const agentLoops = recentLoops.filter((l) => l.agentId === agentId);
    if (agentLoops.length === 0)
        return null;
    const durations = agentLoops.filter((l) => l.totalMs).map((l) => l.totalMs);
    const avgMs = durations.length > 0 ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0;
    const partials = agentLoops.map((l) => l.partialCount);
    const avgPartial = Math.round((partials.reduce((s, c) => s + c, 0) / partials.length) * 10) / 10;
    const bottlenecks = {};
    for (const l of agentLoops) {
        const bn = l.breakdown?.bottleneck.segment;
        if (bn)
            bottlenecks[bn] = (bottlenecks[bn] ?? 0) + 1;
    }
    const topBn = Object.entries(bottlenecks).sort((a, b) => b[1] - a[1])[0];
    return {
        total: agentLoops.length,
        avgMs,
        p50Ms: getPercentile(`loop:agent:${agentId}`, 50),
        p95Ms: getPercentile(`loop:agent:${agentId}`, 95),
        avgPartialCount: avgPartial,
        topBottleneck: topBn?.[0] ?? null,
    };
}
