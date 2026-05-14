export interface TelemetryConfig {
    endpoint?: string;
    version?: string;
    debug?: boolean;
    metricIntervalMs?: number;
    disableInstrumentations?: string[];
}
export declare function initTelemetry(serviceName: string, config?: TelemetryConfig): () => Promise<void>;
