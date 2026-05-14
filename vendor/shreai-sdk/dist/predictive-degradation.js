import { createLogger } from './logger.js';
const ALL_SIGNALS = [
    'quality_score',
    'confidence',
    'escalation_freq',
    'latency_pct',
    'watch_rate',
];
const SIGNAL_WEIGHTS = {
    quality_score: 0.3,
    confidence: 0.25,
    escalation_freq: 0.2,
    latency_pct: 0.15,
    watch_rate: 0.1,
};
const ALERT_THRESHOLDS = {
    quality_score: 0.7,
    confidence: 0.65,
    escalation_freq: 0.4,
    latency_pct: 0.8,
    watch_rate: 0.35,
};
const LOWER_IS_WORSE = new Set(['quality_score', 'confidence']);
const SIGNAL_ACTION_MAP = {
    quality_score: 'prompt_patch',
    confidence: 'lora_signal',
    escalation_freq: 'routing_weight',
    latency_pct: 'golden_test',
    watch_rate: 'investigation',
};
const MS_PER_DAY = 86_400_000;
class SignalTimeSeries {
    windowMs;
    points = [];
    anchorTime = 0;
    constructor(windowDays) {
        this.windowMs = windowDays * MS_PER_DAY;
    }
    add(value, timestampIso) {
        if (!Number.isFinite(value))
            return false;
        const ts = new Date(timestampIso).getTime();
        if (Number.isNaN(ts))
            return false;
        if (this.points.length === 0) {
            this.anchorTime = ts;
        }
        const dayOffset = (ts - this.anchorTime) / MS_PER_DAY;
        this.points.push({ dayOffset, value, timestamp: ts });
        this.prune(ts);
        return true;
    }
    get length() {
        return this.points.length;
    }
    currentValue() {
        if (this.points.length === 0)
            return 0;
        return this.points[this.points.length - 1].value;
    }
    slope() {
        const n = this.points.length;
        if (n < 2)
            return 0;
        let sumX = 0;
        let sumY = 0;
        let sumXY = 0;
        let sumX2 = 0;
        for (const p of this.points) {
            sumX += p.dayOffset;
            sumY += p.value;
            sumXY += p.dayOffset * p.value;
            sumX2 += p.dayOffset * p.dayOffset;
        }
        const denom = n * sumX2 - sumX * sumX;
        if (Math.abs(denom) < 1e-12)
            return 0;
        return (n * sumXY - sumX * sumY) / denom;
    }
    prune(now) {
        const cutoff = now - this.windowMs;
        let i = 0;
        while (i < this.points.length && this.points[i].timestamp < cutoff) {
            i++;
        }
        if (i > 0) {
            this.points = this.points.slice(i);
            if (this.points.length > 0) {
                this.anchorTime = this.points[0].timestamp;
                for (const p of this.points) {
                    p.dayOffset = (p.timestamp - this.anchorTime) / MS_PER_DAY;
                }
            }
        }
    }
}
class DegradationEngineImpl {
    log;
    windowDays;
    alertThreshold;
    forecastHorizonDays;
    serviceName;
    series = new Map();
    blockIds = new Set();
    totalObs = 0;
    constructor(serviceName, opts = {}) {
        this.serviceName = serviceName;
        this.log = createLogger(`${serviceName}:predictive-degradation`);
        this.windowDays = opts.windowDays ?? 14;
        this.alertThreshold = opts.alertThreshold ?? 0.6;
        this.forecastHorizonDays = opts.forecastHorizonDays ?? 7;
        this.log.info('Predictive degradation engine initialized', {
            windowDays: this.windowDays,
            alertThreshold: this.alertThreshold,
            forecastHorizonDays: this.forecastHorizonDays,
        });
    }
    record(observation) {
        const key = `${observation.blockId}:${observation.signal}`;
        let ts = this.series.get(key);
        if (!ts) {
            ts = new SignalTimeSeries(this.windowDays);
            this.series.set(key, ts);
        }
        const added = ts.add(observation.value, observation.timestamp);
        if (!added) {
            this.log.warn('Skipping invalid observation (NaN/Infinity value or invalid timestamp)', {
                blockId: observation.blockId,
                signal: observation.signal,
                value: observation.value,
                timestamp: observation.timestamp,
            });
            return;
        }
        this.blockIds.add(observation.blockId);
        this.totalObs++;
    }
    recordBatch(observations) {
        for (const obs of observations) {
            this.record(obs);
        }
    }
    forecast(blockId) {
        const signalForecasts = [];
        for (const signal of ALL_SIGNALS) {
            signalForecasts.push(this.forecastSignal(blockId, signal));
        }
        let weightedSum = 0;
        let activeWeightSum = 0;
        for (const sf of signalForecasts) {
            const key = `${blockId}:${sf.signal}`;
            const ts = this.series.get(key);
            if (ts && ts.length >= 2) {
                weightedSum += SIGNAL_WEIGHTS[sf.signal] * sf.breachProbability;
                activeWeightSum += SIGNAL_WEIGHTS[sf.signal];
            }
        }
        const ensemble = activeWeightSum > 0 ? clamp(weightedSum / activeWeightSum, 0, 1) : 0;
        const severity = this.classifySeverity(ensemble);
        let predictedBreachSignal = null;
        let minDays = Infinity;
        for (const sf of signalForecasts) {
            if (sf.daysToThreshold > 0 && sf.daysToThreshold < minDays) {
                minDays = sf.daysToThreshold;
                predictedBreachSignal = sf.signal;
            }
        }
        let recommendedAction = null;
        if (ensemble >= this.alertThreshold && predictedBreachSignal) {
            recommendedAction = this.generateAction(blockId, predictedBreachSignal, ensemble);
        }
        const forecast = {
            blockId,
            ensembleProbability: round4(ensemble),
            severity,
            signals: signalForecasts,
            predictedBreachSignal,
            recommendedAction,
            forecastedAt: new Date().toISOString(),
        };
        if (severity === 'warning' || severity === 'critical') {
            this.log.warn('Degradation alert', {
                blockId,
                severity,
                ensemble: round4(ensemble),
                predictedBreachSignal,
            });
        }
        return forecast;
    }
    forecastAll() {
        const results = [];
        for (const blockId of this.blockIds) {
            results.push(this.forecast(blockId));
        }
        return results.sort((a, b) => b.ensembleProbability - a.ensembleProbability);
    }
    trendReport() {
        const forecasts = this.forecastAll();
        if (forecasts.length === 0) {
            return `[${this.serviceName}] Predictive degradation: no blocks tracked.`;
        }
        const lines = [
            `=== Predictive Degradation Report (${this.serviceName}) ===`,
            `Blocks tracked: ${this.blockIds.size} | Total observations: ${this.totalObs}`,
            `Window: ${this.windowDays}d | Horizon: ${this.forecastHorizonDays}d`,
            '',
        ];
        for (const f of forecasts) {
            const icon = f.severity === 'critical'
                ? '[CRIT]'
                : f.severity === 'warning'
                    ? '[WARN]'
                    : f.severity === 'watch'
                        ? '[WATCH]'
                        : '[OK]';
            lines.push(`${icon} ${f.blockId} — P=${(f.ensembleProbability * 100).toFixed(1)}% (${f.severity})`);
            for (const sf of f.signals) {
                const dir = sf.slope > 0 ? '+' : '';
                const breach = sf.daysToThreshold > 0 ? `breach in ~${sf.daysToThreshold.toFixed(1)}d` : 'stable';
                lines.push(`    ${sf.signal}: ${sf.currentValue.toFixed(3)} (${dir}${sf.slope.toFixed(4)}/d) — ${breach}`);
            }
            if (f.recommendedAction) {
                lines.push(`    -> Action: ${f.recommendedAction.type} (P${f.recommendedAction.priority}) — ${f.recommendedAction.reason}`);
            }
            lines.push('');
        }
        return lines.join('\n');
    }
    getActiveAlerts() {
        return this.forecastAll().filter((f) => f.severity === 'warning' || f.severity === 'critical');
    }
    removeBlock(blockId) {
        for (const signal of ALL_SIGNALS) {
            this.series.delete(`${blockId}:${signal}`);
        }
        this.blockIds.delete(blockId);
        this.log.info('Block removed from degradation tracking', { blockId });
    }
    stats() {
        const alerts = this.getActiveAlerts();
        return {
            totalObservations: this.totalObs,
            blocksTracked: this.blockIds.size,
            activeAlerts: alerts.length,
        };
    }
    forecastSignal(blockId, signal) {
        const key = `${blockId}:${signal}`;
        const ts = this.series.get(key);
        if (!ts || ts.length < 2) {
            return {
                signal,
                currentValue: ts ? ts.currentValue() : 0,
                slope: 0,
                daysToThreshold: -1,
                breachProbability: 0,
            };
        }
        const currentValue = ts.currentValue();
        const slope = ts.slope();
        const threshold = ALERT_THRESHOLDS[signal];
        const lowerWorse = LOWER_IS_WORSE.has(signal);
        let daysToThreshold = this.computeDaysToThreshold(currentValue, slope, threshold, lowerWorse);
        if (daysToThreshold > 365) {
            daysToThreshold = 365;
        }
        const breachProbability = this.computeBreachProbability(daysToThreshold, currentValue, threshold, lowerWorse);
        return {
            signal,
            currentValue: round4(currentValue),
            slope: round4(slope),
            daysToThreshold: daysToThreshold > 0 ? round4(daysToThreshold) : -1,
            breachProbability: round4(breachProbability),
        };
    }
    computeDaysToThreshold(current, slope, threshold, lowerWorse) {
        if (lowerWorse) {
            if (current <= threshold)
                return 0;
            if (slope === 0)
                return 365;
            if (slope > 0)
                return -1;
            return (threshold - current) / slope;
        }
        else {
            if (current >= threshold)
                return 0;
            if (slope === 0)
                return 365;
            if (slope < 0)
                return -1;
            return (threshold - current) / slope;
        }
    }
    computeBreachProbability(daysToThreshold, currentValue, threshold, lowerWorse) {
        if (daysToThreshold === 0)
            return 1.0;
        if (daysToThreshold < 0) {
            const distance = lowerWorse ? currentValue - threshold : threshold - currentValue;
            const proximity = Math.max(0, 1 - distance * 3);
            return clamp(proximity * 0.15, 0, 0.15);
        }
        const horizon = this.forecastHorizonDays;
        if (daysToThreshold <= horizon) {
            const t = daysToThreshold / horizon;
            return clamp(0.95 - t * 0.65, 0.3, 0.95);
        }
        const overshoot = daysToThreshold - horizon;
        return clamp(0.3 * Math.exp(-overshoot / horizon), 0, 0.3);
    }
    classifySeverity(ensemble) {
        if (ensemble >= 0.8)
            return 'critical';
        if (ensemble >= 0.6)
            return 'warning';
        if (ensemble >= 0.3)
            return 'watch';
        return 'none';
    }
    generateAction(blockId, signal, ensemble) {
        const actionType = SIGNAL_ACTION_MAP[signal];
        const priority = ensemble >= 0.8 ? 9 : ensemble >= 0.7 ? 7 : 5;
        const reasons = {
            quality_score: `Quality score trending below threshold — recommend prompt tuning for ${blockId}`,
            confidence: `Model confidence declining — recommend LoRA fine-tune signal for ${blockId}`,
            escalation_freq: `Escalation frequency rising — recommend routing weight adjustment for ${blockId}`,
            latency_pct: `Latency approaching max TTL — recommend golden test validation for ${blockId}`,
            watch_rate: `Watch-flagged outcomes increasing — recommend manual investigation of ${blockId}`,
        };
        return {
            type: actionType,
            blockId,
            priority,
            reason: reasons[signal],
            signal,
        };
    }
}
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
function round4(v) {
    return Math.round(v * 10000) / 10000;
}
export function createDegradationEngine(serviceName, opts) {
    return new DegradationEngineImpl(serviceName, opts);
}
