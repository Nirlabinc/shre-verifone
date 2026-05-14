export type QualitySignal = 'quality_score' | 'confidence' | 'escalation_freq' | 'latency_pct' | 'watch_rate';
export interface SignalObservation {
    blockId: string;
    signal: QualitySignal;
    value: number;
    timestamp: string;
}
export interface SignalForecast {
    signal: QualitySignal;
    currentValue: number;
    slope: number;
    daysToThreshold: number;
    breachProbability: number;
}
export type DegradationSeverity = 'none' | 'watch' | 'warning' | 'critical';
export type ActionType = 'prompt_patch' | 'lora_signal' | 'routing_weight' | 'golden_test' | 'investigation';
export interface ImprovementAction {
    type: ActionType;
    blockId: string;
    priority: number;
    reason: string;
    signal: QualitySignal;
}
export interface DegradationForecast {
    blockId: string;
    ensembleProbability: number;
    severity: DegradationSeverity;
    signals: SignalForecast[];
    predictedBreachSignal: QualitySignal | null;
    recommendedAction: ImprovementAction | null;
    forecastedAt: string;
}
export interface DegradationEngineOptions {
    windowDays?: number;
    alertThreshold?: number;
    forecastHorizonDays?: number;
}
export interface DegradationEngine {
    record(observation: SignalObservation): void;
    recordBatch(observations: SignalObservation[]): void;
    forecast(blockId: string): DegradationForecast;
    forecastAll(): DegradationForecast[];
    trendReport(): string;
    getActiveAlerts(): DegradationForecast[];
    removeBlock(blockId: string): void;
    stats(): {
        totalObservations: number;
        blocksTracked: number;
        activeAlerts: number;
    };
}
export declare function createDegradationEngine(serviceName: string, opts?: DegradationEngineOptions): DegradationEngine;
