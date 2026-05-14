import { createLogger } from './logger.js';
const ALL_ML_SIGNALS = [
    'inference_latency',
    'model_drift',
    'training_loss',
    'gpu_utilization',
];
const ML_SIGNAL_WEIGHTS = {
    inference_latency: 0.3,
    model_drift: 0.3,
    training_loss: 0.2,
    gpu_utilization: 0.2,
};
const ML_ALERT_THRESHOLDS = {
    inference_latency: 0.8,
    model_drift: 0.3,
    training_loss: 0.5,
    gpu_utilization: 0.95,
};
const ML_SIGNAL_ACTION_MAP = {
    inference_latency: 'batch_size_reduction',
    model_drift: 'model_rollback',
    training_loss: 'checkpoint_recovery',
    gpu_utilization: 'gpu_memory_cleanup',
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
        if (this.points.length === 0)
            this.anchorTime = ts;
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
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
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
        while (i < this.points.length && this.points[i].timestamp < cutoff)
            i++;
        if (i > 0)
            this.points = this.points.slice(i);
    }
}
export function createMLDegradationEngine(serviceName, opts = {}) {
    const windowDays = opts.windowDays ?? 14;
    const alertThreshold = opts.alertThreshold ?? 0.6;
    const forecastHorizonDays = opts.forecastHorizonDays ?? 7;
    const log = createLogger(`${serviceName}:ml-degradation`);
    const series = new Map();
    let totalObs = 0;
    function getOrCreateSeries(blockId, signal) {
        let blockMap = series.get(blockId);
        if (!blockMap) {
            blockMap = new Map();
            series.set(blockId, blockMap);
        }
        let ts = blockMap.get(signal);
        if (!ts) {
            ts = new SignalTimeSeries(windowDays);
            blockMap.set(signal, ts);
        }
        return ts;
    }
    function forecastSignal(blockId, signal) {
        const ts = series.get(blockId)?.get(signal);
        if (!ts || ts.length < 2) {
            return {
                signal,
                currentValue: ts?.currentValue() ?? 0,
                slope: 0,
                daysToThreshold: -1,
                breachProbability: 0,
            };
        }
        const current = ts.currentValue();
        const slopePerDay = ts.slope();
        const threshold = ML_ALERT_THRESHOLDS[signal];
        let daysToThreshold = -1;
        let breachProbability = 0;
        if (current >= threshold) {
            daysToThreshold = 0;
            breachProbability = 1.0;
        }
        else if (slopePerDay > 0) {
            daysToThreshold = (threshold - current) / slopePerDay;
            if (daysToThreshold <= forecastHorizonDays) {
                breachProbability = Math.min(1.0, 1.0 - daysToThreshold / (forecastHorizonDays * 2));
            }
        }
        return {
            signal,
            currentValue: current,
            slope: slopePerDay,
            daysToThreshold,
            breachProbability,
        };
    }
    function forecastBlock(blockId) {
        const signalForecasts = ALL_ML_SIGNALS.map((s) => forecastSignal(blockId, s));
        let ensemble = 0;
        for (const sf of signalForecasts) {
            ensemble += sf.breachProbability * ML_SIGNAL_WEIGHTS[sf.signal];
        }
        ensemble = Math.min(1.0, ensemble);
        let severity = 'none';
        if (ensemble >= 0.8)
            severity = 'critical';
        else if (ensemble >= 0.6)
            severity = 'warning';
        else if (ensemble >= 0.3)
            severity = 'watch';
        let worstSignal = null;
        for (const sf of signalForecasts) {
            if (!worstSignal || sf.breachProbability > worstSignal.breachProbability) {
                worstSignal = sf;
            }
        }
        const predictedBreachSignal = worstSignal && worstSignal.breachProbability > 0 ? worstSignal.signal : null;
        let recommendedAction = null;
        if (predictedBreachSignal && severity !== 'none') {
            const priorityMap = {
                none: 1,
                watch: 3,
                warning: 6,
                critical: 9,
            };
            recommendedAction = {
                type: ML_SIGNAL_ACTION_MAP[predictedBreachSignal],
                blockId,
                priority: priorityMap[severity],
                reason: `${predictedBreachSignal} trending toward breach (P=${ensemble.toFixed(2)}, slope=${worstSignal.slope.toFixed(4)}/day)`,
                signal: predictedBreachSignal,
            };
        }
        return {
            blockId,
            ensembleProbability: ensemble,
            severity,
            signals: signalForecasts,
            predictedBreachSignal,
            recommendedAction,
            forecastedAt: new Date().toISOString(),
        };
    }
    return {
        record(observation) {
            const ts = getOrCreateSeries(observation.blockId, observation.signal);
            if (ts.add(observation.value, observation.timestamp)) {
                totalObs++;
            }
            else {
                log.warn('[ml-degradation] Invalid observation dropped', {
                    blockId: observation.blockId,
                    signal: observation.signal,
                });
            }
        },
        recordBatch(observations) {
            for (const obs of observations) {
                this.record(obs);
            }
        },
        forecast(blockId) {
            return forecastBlock(blockId);
        },
        forecastAll() {
            return Array.from(series.keys()).map((id) => forecastBlock(id));
        },
        getActiveAlerts() {
            return this.forecastAll().filter((f) => f.ensembleProbability >= alertThreshold);
        },
        removeBlock(blockId) {
            series.delete(blockId);
        },
        stats() {
            const alerts = this.getActiveAlerts();
            return {
                totalObservations: totalObs,
                blocksTracked: series.size,
                activeAlerts: alerts.length,
            };
        },
    };
}
