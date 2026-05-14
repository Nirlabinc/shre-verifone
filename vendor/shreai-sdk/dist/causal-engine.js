import { createLogger } from './logger.js';
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const DEFAULT_MAX_AGE = 30 * MS_PER_DAY;
const DOMAIN_RULES = [
    {
        causeDomain: 'git',
        causeType: 'commit',
        effectDomain: 'health',
        effectType: 'degradation',
        maxLagMs: 2 * MS_PER_HOUR,
        baseStrength: 0.7,
        mechanism: 'Code change may have introduced performance regression',
    },
    {
        causeDomain: 'deploy',
        causeType: 'deploy',
        effectDomain: 'health',
        effectType: 'degradation',
        maxLagMs: 30 * 60_000,
        baseStrength: 0.85,
        mechanism: 'Deployment may have introduced service degradation',
    },
    {
        causeDomain: 'health',
        causeType: 'degradation',
        effectDomain: 'sales',
        effectType: 'drop',
        maxLagMs: 4 * MS_PER_HOUR,
        baseStrength: 0.6,
        mechanism: 'Service degradation may have impacted sales processing',
    },
    {
        causeDomain: 'health',
        causeType: 'outage',
        effectDomain: 'sales',
        effectType: 'drop',
        maxLagMs: MS_PER_HOUR,
        baseStrength: 0.9,
        mechanism: 'Service outage directly blocked sales transactions',
    },
    {
        causeDomain: 'git',
        causeType: 'commit',
        effectDomain: 'task',
        effectType: 'failure',
        maxLagMs: MS_PER_HOUR,
        baseStrength: 0.65,
        mechanism: 'Code change may have broken task execution',
    },
    {
        causeDomain: 'deploy',
        causeType: 'deploy',
        effectDomain: 'task',
        effectType: 'failure',
        maxLagMs: 30 * 60_000,
        baseStrength: 0.8,
        mechanism: 'Deployment may have disrupted running tasks',
    },
    {
        causeDomain: 'alert',
        causeType: 'resource_exhaustion',
        effectDomain: 'health',
        effectType: 'degradation',
        maxLagMs: 10 * 60_000,
        baseStrength: 0.85,
        mechanism: 'Resource exhaustion caused service degradation',
    },
    {
        causeDomain: 'task',
        causeType: 'bulk_execution',
        effectDomain: 'health',
        effectType: 'degradation',
        maxLagMs: 15 * 60_000,
        baseStrength: 0.55,
        mechanism: 'Burst of task executions may have overloaded service',
    },
];
function ols(X, y) {
    const n = y.length;
    const k = X[0].length;
    const Xa = X.map((row) => [1, ...row]);
    const ka = k + 1;
    const XtX = Array.from({ length: ka }, () => new Array(ka).fill(0));
    for (let i = 0; i < ka; i++) {
        for (let j = 0; j < ka; j++) {
            let sum = 0;
            for (let r = 0; r < n; r++)
                sum += Xa[r][i] * Xa[r][j];
            XtX[i][j] = sum;
        }
    }
    const Xty = new Array(ka).fill(0);
    for (let i = 0; i < ka; i++) {
        let sum = 0;
        for (let r = 0; r < n; r++)
            sum += Xa[r][i] * y[r];
        Xty[i] = sum;
    }
    const aug = XtX.map((row, i) => [...row, Xty[i]]);
    for (let col = 0; col < ka; col++) {
        let maxRow = col;
        for (let row = col + 1; row < ka; row++) {
            if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col]))
                maxRow = row;
        }
        [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
        const pivot = aug[col][col];
        if (Math.abs(pivot) < 1e-12) {
            return {
                coefficients: new Array(ka).fill(0),
                residuals: y.slice(),
                rss: y.reduce((s, v) => s + v * v, 0),
            };
        }
        for (let j = col; j <= ka; j++)
            aug[col][j] /= pivot;
        for (let row = 0; row < ka; row++) {
            if (row === col)
                continue;
            const factor = aug[row][col];
            for (let j = col; j <= ka; j++)
                aug[row][j] -= factor * aug[col][j];
        }
    }
    const coefficients = aug.map((row) => row[ka]);
    const residuals = y.map((yi, r) => {
        let predicted = 0;
        for (let j = 0; j < ka; j++)
            predicted += Xa[r][j] * coefficients[j];
        return yi - predicted;
    });
    const rss = residuals.reduce((s, r) => s + r * r, 0);
    return { coefficients, residuals, rss };
}
function fCdf(f, df1, df2) {
    if (f <= 0)
        return 0;
    const x = df2 / (df2 + df1 * f);
    return 1 - incompleteBeta(x, df2 / 2, df1 / 2);
}
function incompleteBeta(x, a, b) {
    if (x <= 0)
        return 0;
    if (x >= 1)
        return 1;
    const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);
    const maxIter = 200;
    const eps = 1e-10;
    let c = 1;
    let d = 1 / Math.max(1 - ((a + b) * x) / (a + 1), eps);
    let h = d;
    for (let m = 1; m <= maxIter; m++) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
        d = 1 / Math.max(1 + aa * d, eps);
        c = Math.max(1 + aa / c, eps);
        h *= d * c;
        aa = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
        d = 1 / Math.max(1 + aa * d, eps);
        c = Math.max(1 + aa / c, eps);
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < eps)
            break;
    }
    return (front * h) / a;
}
function lnGamma(z) {
    if (z <= 0)
        return 0;
    const c = [
        76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
        0.1208650973866179e-2, -0.5395239384953e-5,
    ];
    let x = z;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++)
        ser += c[j] / ++x;
    return -tmp + Math.log((2.5066282746310005 * ser) / z);
}
function tTestPValue(t, df) {
    if (df <= 0)
        return 1;
    const x = df / (df + t * t);
    return incompleteBeta(x, df / 2, 0.5);
}
function welchTTest(a, b) {
    const n1 = a.length;
    const n2 = b.length;
    if (n1 < 2 || n2 < 2)
        return { tStatistic: 0, pValue: 1 };
    const mean1 = a.reduce((s, v) => s + v, 0) / n1;
    const mean2 = b.reduce((s, v) => s + v, 0) / n2;
    const var1 = a.reduce((s, v) => s + (v - mean1) ** 2, 0) / (n1 - 1);
    const var2 = b.reduce((s, v) => s + (v - mean2) ** 2, 0) / (n2 - 1);
    const se = Math.sqrt(var1 / n1 + var2 / n2);
    if (se < 1e-12)
        return { tStatistic: 0, pValue: 1 };
    const t = (mean1 - mean2) / se;
    const num = (var1 / n1 + var2 / n2) ** 2;
    const den = (var1 / n1) ** 2 / (n1 - 1) + (var2 / n2) ** 2 / (n2 - 1);
    const df = num / den;
    return { tStatistic: t, pValue: tTestPValue(t, df) };
}
class CausalEngineImpl {
    log;
    maxEventAge;
    grangerLags;
    bucketMs;
    significanceLevel;
    minProximityMs;
    maxProximityMs;
    cortexUrl;
    events = new Map();
    series = new Map();
    links = [];
    chains = [];
    constructor(opts = {}) {
        this.maxEventAge = opts.maxEventAge ?? DEFAULT_MAX_AGE;
        this.grangerLags = opts.grangerLags ?? 5;
        this.bucketMs = opts.bucketMs ?? MS_PER_HOUR;
        this.significanceLevel = opts.significanceLevel ?? 0.05;
        this.minProximityMs = opts.minProximityMs ?? 60_000;
        this.maxProximityMs = opts.maxProximityMs ?? MS_PER_HOUR;
        this.cortexUrl = opts.cortexUrl ?? 'http://127.0.0.1:5400';
        this.log = createLogger('causal-engine');
        this.log.info('Causal inference engine initialized', {
            grangerLags: this.grangerLags,
            bucketMs: this.bucketMs,
            significanceLevel: this.significanceLevel,
        });
    }
    ingestEvent(event) {
        const tsMs = new Date(event.timestamp).getTime();
        if (Number.isNaN(tsMs)) {
            this.log.warn('Invalid timestamp in event', { id: event.id });
            return;
        }
        this.events.set(event.id, { ...event, tsMs });
        this.pruneEvents();
        for (const [key, val] of Object.entries(event.payload)) {
            if (typeof val === 'number' && Number.isFinite(val)) {
                const seriesKey = `${event.domain}:${event.service ?? 'global'}:${key}`;
                this.addSeriesPoint(seriesKey, val, tsMs);
            }
        }
    }
    ingestTimeSeries(key, value, timestamp) {
        const ts = new Date(timestamp).getTime();
        if (Number.isNaN(ts) || !Number.isFinite(value))
            return;
        this.addSeriesPoint(key, value, ts);
    }
    addSeriesPoint(key, value, ts) {
        const bucket = Math.floor(ts / this.bucketMs);
        let arr = this.series.get(key);
        if (!arr) {
            arr = [];
            this.series.set(key, arr);
        }
        arr.push({ bucket, value, ts });
        const cutoff = Date.now() - this.maxEventAge;
        while (arr.length > 0 && arr[0].ts < cutoff)
            arr.shift();
    }
    pruneEvents() {
        const cutoff = Date.now() - this.maxEventAge;
        for (const [id, evt] of this.events) {
            if (evt.tsMs < cutoff)
                this.events.delete(id);
        }
    }
    grangerTest(causeKey, effectKey) {
        const causeSeries = this.getBucketedSeries(causeKey);
        const effectSeries = this.getBucketedSeries(effectKey);
        if (!causeSeries || !effectSeries)
            return null;
        const allBuckets = new Set([...causeSeries.keys(), ...effectSeries.keys()]);
        const sortedBuckets = [...allBuckets].sort((a, b) => a - b);
        if (sortedBuckets.length < this.grangerLags * 3)
            return null;
        const xVals = [];
        const yVals = [];
        let lastX = 0;
        let lastY = 0;
        for (const b of sortedBuckets) {
            lastX = causeSeries.get(b) ?? lastX;
            lastY = effectSeries.get(b) ?? lastY;
            xVals.push(lastX);
            yVals.push(lastY);
        }
        let bestResult = null;
        for (let lag = 1; lag <= this.grangerLags; lag++) {
            const result = this.grangerTestAtLag(causeKey, effectKey, xVals, yVals, lag);
            if (result && (!bestResult || result.fStatistic > bestResult.fStatistic)) {
                bestResult = result;
            }
        }
        return bestResult;
    }
    grangerTestAtLag(causeKey, effectKey, x, y, lag) {
        const n = y.length;
        if (n <= lag + 2)
            return null;
        const yTarget = [];
        const xRestricted = [];
        const xUnrestricted = [];
        for (let t = lag; t < n; t++) {
            yTarget.push(y[t]);
            const yLags = [];
            const xLags = [];
            for (let l = 1; l <= lag; l++) {
                yLags.push(y[t - l]);
                xLags.push(x[t - l]);
            }
            xRestricted.push(yLags);
            xUnrestricted.push([...yLags, ...xLags]);
        }
        const T = yTarget.length;
        if (T < lag * 2 + 3)
            return null;
        const restricted = ols(xRestricted, yTarget);
        const unrestricted = ols(xUnrestricted, yTarget);
        const rssR = restricted.rss;
        const rssU = unrestricted.rss;
        const q = lag;
        const k = 2 * lag + 1;
        if (rssU < 1e-12)
            return null;
        const fStat = (rssR - rssU) / q / (rssU / (T - k));
        if (!Number.isFinite(fStat) || fStat < 0)
            return null;
        const pValue = 1 - fCdf(fStat, q, T - k);
        return {
            causeKey,
            effectKey,
            fStatistic: Math.round(fStat * 1000) / 1000,
            pValue: Math.round(pValue * 10000) / 10000,
            isSignificant: pValue < this.significanceLevel,
            optimalLag: lag,
        };
    }
    grangerScan() {
        const keys = [...this.series.keys()];
        const results = [];
        for (let i = 0; i < keys.length; i++) {
            for (let j = 0; j < keys.length; j++) {
                if (i === j)
                    continue;
                const result = this.grangerTest(keys[i], keys[j]);
                if (result?.isSignificant) {
                    results.push(result);
                }
            }
        }
        return results.sort((a, b) => a.pValue - b.pValue);
    }
    interventionTest(eventId, seriesKey, windowMs) {
        const event = this.events.get(eventId);
        if (!event)
            return null;
        const series = this.series.get(seriesKey);
        if (!series || series.length < 6)
            return null;
        const w = windowMs ?? 2 * MS_PER_HOUR;
        const before = [];
        const after = [];
        for (const pt of series) {
            const diff = pt.ts - event.tsMs;
            if (diff >= -w && diff < 0)
                before.push(pt.value);
            else if (diff >= 0 && diff <= w)
                after.push(pt.value);
        }
        if (before.length < 2 || after.length < 2)
            return null;
        const beforeMean = before.reduce((s, v) => s + v, 0) / before.length;
        const afterMean = after.reduce((s, v) => s + v, 0) / after.length;
        const delta = afterMean - beforeMean;
        const deltaPct = beforeMean !== 0 ? (delta / Math.abs(beforeMean)) * 100 : 0;
        const { tStatistic, pValue } = welchTTest(before, after);
        return {
            eventId,
            affectedSeries: seriesKey,
            beforeMean: Math.round(beforeMean * 1000) / 1000,
            afterMean: Math.round(afterMean * 1000) / 1000,
            delta: Math.round(delta * 1000) / 1000,
            deltaPct: Math.round(deltaPct * 100) / 100,
            tStatistic: Math.round(tStatistic * 1000) / 1000,
            pValue: Math.round(pValue * 10000) / 10000,
            isSignificant: pValue < this.significanceLevel,
        };
    }
    inferLinks() {
        this.links = [];
        this.inferDomainRuleLinks();
        this.inferTemporalProximityLinks();
        this.inferGrangerLinks();
        const best = new Map();
        for (const link of this.links) {
            const key = `${link.causeId}→${link.effectId}`;
            const existing = best.get(key);
            if (!existing || link.strength > existing.strength) {
                best.set(key, link);
            }
        }
        this.links = [...best.values()].sort((a, b) => b.strength - a.strength);
        this.log.info('Causal links inferred', { count: this.links.length });
        return this.links;
    }
    inferDomainRuleLinks() {
        const eventList = [...this.events.values()].sort((a, b) => a.tsMs - b.tsMs);
        for (const rule of DOMAIN_RULES) {
            const causes = eventList.filter((e) => e.domain === rule.causeDomain && e.type === rule.causeType);
            const effects = eventList.filter((e) => e.domain === rule.effectDomain && e.type === rule.effectType);
            for (const cause of causes) {
                for (const effect of effects) {
                    const lag = effect.tsMs - cause.tsMs;
                    if (lag < 0 || lag > rule.maxLagMs)
                        continue;
                    const sameService = cause.service && effect.service && cause.service === effect.service;
                    const serviceBoost = sameService ? 0.15 : 0;
                    const proximityFactor = 1 - (lag / rule.maxLagMs) * 0.3;
                    const strength = Math.min(1, (rule.baseStrength + serviceBoost) * proximityFactor);
                    this.links.push({
                        causeId: cause.id,
                        effectId: effect.id,
                        causeDomain: rule.causeDomain,
                        effectDomain: rule.effectDomain,
                        method: 'domain_rule',
                        strength,
                        lagMs: lag,
                        mechanism: rule.mechanism + (sameService ? ` (same service: ${cause.service})` : ''),
                    });
                }
            }
        }
    }
    inferTemporalProximityLinks() {
        const eventList = [...this.events.values()].sort((a, b) => a.tsMs - b.tsMs);
        for (let i = 0; i < eventList.length; i++) {
            for (let j = i + 1; j < eventList.length; j++) {
                const cause = eventList[i];
                const effect = eventList[j];
                const lag = effect.tsMs - cause.tsMs;
                if (lag < this.minProximityMs || lag > this.maxProximityMs)
                    continue;
                if (cause.domain === effect.domain && cause.type === effect.type)
                    continue;
                if (!cause.service || !effect.service || cause.service !== effect.service)
                    continue;
                const proximityFactor = 1 - lag / this.maxProximityMs;
                const strength = 0.4 * proximityFactor;
                if (strength < 0.15)
                    continue;
                this.links.push({
                    causeId: cause.id,
                    effectId: effect.id,
                    causeDomain: cause.domain,
                    effectDomain: effect.domain,
                    method: 'temporal_proximity',
                    strength,
                    lagMs: lag,
                    mechanism: `Temporally proximate events on ${cause.service} (${Math.round(lag / 1000)}s apart)`,
                });
            }
        }
    }
    inferGrangerLinks() {
        const grangerResults = this.grangerScan();
        for (const result of grangerResults) {
            const [causeDomain] = result.causeKey.split(':');
            const [effectDomain] = result.effectKey.split(':');
            const strength = Math.min(0.95, 1 - result.pValue);
            this.links.push({
                causeId: `granger:${result.causeKey}`,
                effectId: `granger:${result.effectKey}`,
                causeDomain: causeDomain ?? 'custom',
                effectDomain: effectDomain ?? 'custom',
                method: 'granger',
                strength,
                lagMs: result.optimalLag * this.bucketMs,
                mechanism: `${result.causeKey} Granger-causes ${result.effectKey} (F=${result.fStatistic}, p=${result.pValue}, lag=${result.optimalLag}h)`,
            });
        }
    }
    inferChains() {
        if (this.links.length === 0)
            this.inferLinks();
        this.chains = [];
        const adj = new Map();
        for (const link of this.links) {
            const existing = adj.get(link.causeId) ?? [];
            existing.push(link);
            adj.set(link.causeId, existing);
        }
        const effectIds = new Set(this.links.map((l) => l.effectId));
        const roots = this.links.map((l) => l.causeId).filter((id) => !effectIds.has(id));
        const uniqueRoots = [...new Set(roots)];
        for (const rootId of uniqueRoots) {
            this.buildChainsFromRoot(rootId, adj, [], new Set());
        }
        this.chains.sort((a, b) => b.confidence - a.confidence);
        this.log.info('Causal chains built', { count: this.chains.length });
        return this.chains;
    }
    buildChainsFromRoot(nodeId, adj, pathSoFar, visited) {
        if (visited.has(nodeId))
            return;
        visited.add(nodeId);
        const outgoing = adj.get(nodeId) ?? [];
        if (outgoing.length === 0 && pathSoFar.length > 0) {
            const confidence = pathSoFar.reduce((c, l) => c * l.strength, 1) * Math.pow(0.9, pathSoFar.length - 1);
            const rootEvent = this.events.get(pathSoFar[0].causeId);
            const leafEvent = this.events.get(pathSoFar[pathSoFar.length - 1].effectId);
            const mechanism = pathSoFar.map((l) => l.mechanism).join(' → ');
            this.chains.push({
                links: [...pathSoFar],
                rootCause: rootEvent ?? {
                    domain: 'custom',
                    type: 'unknown',
                    id: pathSoFar[0].causeId,
                    timestamp: '',
                    payload: {},
                },
                finalEffect: leafEvent ?? {
                    domain: 'custom',
                    type: 'unknown',
                    id: pathSoFar[pathSoFar.length - 1].effectId,
                    timestamp: '',
                    payload: {},
                },
                confidence: Math.round(confidence * 1000) / 1000,
                mechanism,
            });
            return;
        }
        for (const link of outgoing) {
            this.buildChainsFromRoot(link.effectId, adj, [...pathSoFar, link], new Set(visited));
        }
        if (pathSoFar.length >= 2) {
            const confidence = pathSoFar.reduce((c, l) => c * l.strength, 1) * Math.pow(0.9, pathSoFar.length - 1);
            const rootEvent = this.events.get(pathSoFar[0].causeId);
            const leafEvent = this.events.get(pathSoFar[pathSoFar.length - 1].effectId);
            this.chains.push({
                links: [...pathSoFar],
                rootCause: rootEvent ?? {
                    domain: 'custom',
                    type: 'unknown',
                    id: pathSoFar[0].causeId,
                    timestamp: '',
                    payload: {},
                },
                finalEffect: leafEvent ?? {
                    domain: 'custom',
                    type: 'unknown',
                    id: pathSoFar[pathSoFar.length - 1].effectId,
                    timestamp: '',
                    payload: {},
                },
                confidence: Math.round(confidence * 1000) / 1000,
                mechanism: pathSoFar.map((l) => l.mechanism).join(' → '),
            });
        }
    }
    explain(eventId) {
        if (this.links.length === 0)
            this.inferLinks();
        if (this.chains.length === 0)
            this.inferChains();
        const relevant = this.chains.filter((c) => c.finalEffect.id === eventId || c.links.some((l) => l.effectId === eventId));
        const directCauses = this.links
            .filter((l) => l.effectId === eventId)
            .sort((a, b) => b.strength - a.strength);
        const rootCauses = relevant.map((chain) => ({
            event: chain.rootCause,
            confidence: chain.confidence,
            path: chain.links,
        }));
        const event = this.events.get(eventId);
        const contributing = [];
        if (event) {
            for (const [, e] of this.events) {
                if (e.id === eventId)
                    continue;
                const diff = Math.abs(e.tsMs - event.tsMs);
                if (diff < this.maxProximityMs && e.service === event.service) {
                    contributing.push(e);
                }
            }
        }
        let narrative = '';
        if (rootCauses.length > 0) {
            const top = rootCauses[0];
            narrative = `Root cause: ${top.event.domain}/${top.event.type} (${top.event.id}) with ${Math.round(top.confidence * 100)}% confidence. `;
            narrative += `Chain: ${top.path.map((l) => l.mechanism).join(' → ')}`;
        }
        else if (directCauses.length > 0) {
            narrative = `Direct cause: ${directCauses[0].causeId} (${directCauses[0].method}, strength=${directCauses[0].strength})`;
        }
        else {
            narrative =
                'No causal links found for this event. Consider ingesting more cross-domain events.';
        }
        return {
            eventId,
            rootCauses: rootCauses.sort((a, b) => b.confidence - a.confidence),
            contributingFactors: contributing,
            narrative,
        };
    }
    async persistToCortex() {
        let written = 0;
        for (const link of this.links) {
            try {
                const res = await fetch(`${this.cortexUrl}/v1/write`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        data_type: 'relational',
                        payload: {
                            table: 'causal_links',
                            cause_id: link.causeId,
                            effect_id: link.effectId,
                            cause_domain: link.causeDomain,
                            effect_domain: link.effectDomain,
                            method: link.method,
                            strength: link.strength,
                            lag_ms: link.lagMs,
                            mechanism: link.mechanism,
                            inferred_at: new Date().toISOString(),
                        },
                    }),
                });
                if (res.ok)
                    written++;
            }
            catch {
            }
        }
        this.log.info('Persisted causal links to CortexDB', { written, total: this.links.length });
        return written;
    }
    async loadFromCortex() {
        let loaded = 0;
        try {
            const res = await fetch(`${this.cortexUrl}/v1/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sql: `SELECT * FROM changelog WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 100`,
                }),
            });
            if (res.ok) {
                const data = (await res.json());
                for (const row of data.data ?? []) {
                    this.ingestEvent({
                        domain: 'git',
                        type: 'commit',
                        id: `commit-${row.id ?? loaded}`,
                        timestamp: row.created_at ?? new Date().toISOString(),
                        service: row.service,
                        payload: row,
                    });
                    loaded++;
                }
            }
        }
        catch {
        }
        try {
            const res = await fetch(`${this.cortexUrl}/v1/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sql: `SELECT * FROM heartbeats WHERE error_rate > 0.1 AND ts > NOW() - INTERVAL '7 days' ORDER BY ts DESC LIMIT 200`,
                }),
            });
            if (res.ok) {
                const data = (await res.json());
                for (const row of data.data ?? []) {
                    this.ingestEvent({
                        domain: 'health',
                        type: 'degradation',
                        id: `health-${row.node_id}-${loaded}`,
                        timestamp: row.ts ?? new Date().toISOString(),
                        service: row.node_id,
                        payload: { error_rate: row.error_rate, latency: row.avg_latency_p95, cpu: row.avg_cpu },
                    });
                    loaded++;
                }
            }
        }
        catch {
        }
        try {
            const res = await fetch(`${this.cortexUrl}/v1/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sql: `SELECT * FROM tasks WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '7 days' ORDER BY updated_at DESC LIMIT 100`,
                }),
            });
            if (res.ok) {
                const data = (await res.json());
                for (const row of data.data ?? []) {
                    this.ingestEvent({
                        domain: 'task',
                        type: 'failure',
                        id: `task-${row.id ?? loaded}`,
                        timestamp: row.updated_at ?? new Date().toISOString(),
                        service: row.assigned_to,
                        payload: row,
                    });
                    loaded++;
                }
            }
        }
        catch {
        }
        this.log.info('Loaded events from CortexDB', { loaded });
        return loaded;
    }
    getBucketedSeries(key) {
        const raw = this.series.get(key);
        if (!raw || raw.length < 3)
            return null;
        const buckets = new Map();
        for (const pt of raw) {
            const existing = buckets.get(pt.bucket);
            if (existing) {
                existing.sum += pt.value;
                existing.count++;
            }
            else {
                buckets.set(pt.bucket, { sum: pt.value, count: 1 });
            }
        }
        const result = new Map();
        for (const [b, agg] of buckets) {
            result.set(b, agg.sum / agg.count);
        }
        return result;
    }
    stats() {
        const domains = {};
        for (const evt of this.events.values()) {
            domains[evt.domain] = (domains[evt.domain] ?? 0) + 1;
        }
        return {
            events: this.events.size,
            timeSeries: this.series.size,
            links: this.links.length,
            chains: this.chains.length,
            domains,
        };
    }
}
export function createCausalEngine(opts) {
    return new CausalEngineImpl(opts);
}
