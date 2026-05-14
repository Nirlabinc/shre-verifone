export type MLSignal = 'inference_latency' | 'model_drift' | 'training_loss' | 'gpu_utilization';
export interface MLSignalObservation {
    blockId: string;
    signal: MLSignal;
    value: number;
    timestamp: string;
}
export type MLActionType = 'batch_size_reduction' | 'model_rollback' | 'checkpoint_recovery' | 'gpu_memory_cleanup';
export interface MLImprovementAction {
    type: MLActionType;
    blockId: string;
    priority: number;
    reason: string;
    signal: MLSignal;
}
export interface MLSignalForecast {
    signal: MLSignal;
    currentValue: number;
    slope: number;
    daysToThreshold: number;
    breachProbability: number;
}
export type MLDegradationSeverity = 'none' | 'watch' | 'warning' | 'critical';
export interface MLDegradationForecast {
    blockId: string;
    ensembleProbability: number;
    severity: MLDegradationSeverity;
    signals: MLSignalForecast[];
    predictedBreachSignal: MLSignal | null;
    recommendedAction: MLImprovementAction | null;
    forecastedAt: string;
}
export interface MLDegradationEngineOptions {
    windowDays?: number;
    alertThreshold?: number;
    forecastHorizonDays?: number;
}
export interface MLDegradationEngine {
    record(observation: MLSignalObservation): void;
    recordBatch(observations: MLSignalObservation[]): void;
    forecast(blockId: string): MLDegradationForecast;
    forecastAll(): MLDegradationForecast[];
    getActiveAlerts(): MLDegradationForecast[];
    removeBlock(blockId: string): void;
    stats(): {
        totalObservations: number;
        blocksTracked: number;
        activeAlerts: number;
    };
}
export declare function createMLDegradationEngine(serviceName: string, opts?: MLDegradationEngineOptions): MLDegradationEngine;
