import { createLogger } from './logger.js';
const MS_PER_DAY = 86_400_000;
class SignalStore {
    windowMs;
    points = [];
    constructor(windowDays) {
        this.windowMs = windowDays * MS_PER_DAY;
    }
    add(value, timestampIso) {
        if (!Number.isFinite(value))
            return false;
        const ts = new Date(timestampIso).getTime();
        if (Number.isNaN(ts))
            return false;
        const dayBucket = Math.floor(ts / MS_PER_DAY);
        this.points.push({ dayBucket, value, timestamp: ts });
        this.prune(ts);
        return true;
    }
    get length() {
        return this.points.length;
    }
    getDailyBuckets() {
        const buckets = new Map();
        for (const p of this.points) {
            const existing = buckets.get(p.dayBucket);
            if (existing) {
                existing.sum += p.value;
                existing.count++;
            }
            else {
                buckets.set(p.dayBucket, { sum: p.value, count: 1 });
            }
        }
        const result = new Map();
        for (const [day, agg] of buckets) {
            result.set(day, agg.sum / agg.count);
        }
        return result;
    }
    prune(now) {
        const cutoff = now - this.windowMs;
        let i = 0;
        while (i < this.points.length && this.points[i].timestamp < cutoff) {
            i++;
        }
        if (i > 0) {
            this.points = this.points.slice(i);
        }
    }
}
class CorrelationEngineImpl {
    log;
    windowDays;
    maxLagDays;
    stores = new Map();
    services = new Set();
    signalKeys = new Set();
    totalSamples = 0;
    constructor(opts = {}) {
        this.windowDays = opts.windowDays ?? 14;
        this.maxLagDays = opts.maxLagDays ?? 3;
        this.log = createLogger('signal-correlation');
        this.log.info('Signal correlation engine initialized', {
            windowDays: this.windowDays,
            maxLagDays: this.maxLagDays,
        });
    }
    ingest(service, signal, value, timestamp) {
        const key = `${service}:${signal}`;
        let store = this.stores.get(key);
        if (!store) {
            store = new SignalStore(this.windowDays);
            this.stores.set(key, store);
        }
        const added = store.add(value, timestamp);
        if (!added) {
            this.log.warn('Skipping invalid sample (NaN/Infinity or invalid timestamp)', {
                service,
                signal,
                value,
                timestamp,
            });
            return;
        }
        this.services.add(service);
        this.signalKeys.add(key);
        this.totalSamples++;
    }
    correlate(serviceA, signalA, serviceB, signalB) {
        const keyA = `${serviceA}:${signalA}`;
        const keyB = `${serviceB}:${signalB}`;
        const storeA = this.stores.get(keyA);
        const storeB = this.stores.get(keyB);
        if (!storeA || !storeB || storeA.length < 2 || storeB.length < 2) {
            return null;
        }
        const bucketsA = storeA.getDailyBuckets();
        const bucketsB = storeB.getDailyBuckets();
        let bestR = 0;
        let bestLag = 0;
        let bestN = 0;
        let bestPValue = 1;
        for (let lag = -this.maxLagDays; lag <= this.maxLagDays; lag++) {
            const { r, n } = this.pearsonWithLag(bucketsA, bucketsB, lag);
            if (n < 3)
                continue;
            const pValue = this.computePValue(r, n);
            if (Math.abs(r) > Math.abs(bestR)) {
                bestR = r;
                bestLag = lag;
                bestN = n;
                bestPValue = pValue;
            }
        }
        if (bestN < 3)
            return null;
        return {
            serviceA,
            signalA,
            serviceB,
            signalB,
            correlation: round4(bestR),
            lag: bestLag,
            pValue: round4(bestPValue),
            sampleSize: bestN,
        };
    }
    correlateAll() {
        const keys = Array.from(this.signalKeys);
        const results = [];
        for (let i = 0; i < keys.length; i++) {
            for (let j = i + 1; j < keys.length; j++) {
                const [serviceA, signalA] = this.parseKey(keys[i]);
                const [serviceB, signalB] = this.parseKey(keys[j]);
                const pair = this.correlate(serviceA, signalA, serviceB, signalB);
                if (pair) {
                    results.push(pair);
                }
            }
        }
        return results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    }
    getTopCorrelations(n = 10) {
        return this.correlateAll().slice(0, n);
    }
    stats() {
        return {
            totalSamples: this.totalSamples,
            servicesTracked: this.services.size,
            signalsTracked: this.signalKeys.size,
        };
    }
    pearsonWithLag(bucketsA, bucketsB, lag) {
        const alignedA = [];
        const alignedB = [];
        for (const [day, valA] of bucketsA) {
            const valB = bucketsB.get(day + lag);
            if (valB !== undefined) {
                alignedA.push(valA);
                alignedB.push(valB);
            }
        }
        const n = alignedA.length;
        if (n < 2)
            return { r: 0, n };
        let sumA = 0;
        let sumB = 0;
        for (let i = 0; i < n; i++) {
            sumA += alignedA[i];
            sumB += alignedB[i];
        }
        const meanA = sumA / n;
        const meanB = sumB / n;
        let covAB = 0;
        let varA = 0;
        let varB = 0;
        for (let i = 0; i < n; i++) {
            const dA = alignedA[i] - meanA;
            const dB = alignedB[i] - meanB;
            covAB += dA * dB;
            varA += dA * dA;
            varB += dB * dB;
        }
        const denom = Math.sqrt(varA * varB);
        if (denom < 1e-12)
            return { r: 0, n };
        return { r: covAB / denom, n };
    }
    computePValue(r, n) {
        if (n <= 2)
            return 1;
        const r2 = r * r;
        if (r2 >= 1)
            return 0;
        const t = Math.abs(r) * Math.sqrt((n - 2) / (1 - r2));
        const p = 2 * (1 - normalCDF(t));
        return clamp(p, 0, 1);
    }
    parseKey(key) {
        const idx = key.indexOf(':');
        return [key.substring(0, idx), key.substring(idx + 1)];
    }
}
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
function round4(v) {
    return Math.round(v * 10000) / 10000;
}
function normalCDF(x) {
    if (x < -8)
        return 0;
    if (x > 8)
        return 1;
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);
    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp((-absX * absX) / 2);
    return 0.5 * (1.0 + sign * y);
}
export function createCorrelationEngine(opts) {
    return new CorrelationEngineImpl(opts);
}
