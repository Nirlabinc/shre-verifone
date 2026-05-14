export interface CorrelationPair {
    serviceA: string;
    signalA: string;
    serviceB: string;
    signalB: string;
    correlation: number;
    lag: number;
    pValue: number;
    sampleSize: number;
}
export interface CorrelationEngineOptions {
    windowDays?: number;
    maxLagDays?: number;
}
export interface CorrelationEngine {
    ingest(service: string, signal: string, value: number, timestamp: string): void;
    correlate(serviceA: string, signalA: string, serviceB: string, signalB: string): CorrelationPair | null;
    correlateAll(): CorrelationPair[];
    getTopCorrelations(n?: number): CorrelationPair[];
    stats(): {
        totalSamples: number;
        servicesTracked: number;
        signalsTracked: number;
    };
}
export declare function createCorrelationEngine(opts?: CorrelationEngineOptions): CorrelationEngine;
