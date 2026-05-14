import { type Logger } from './logger.js';
export type DegradationSeverity = 'minor' | 'major' | 'critical';
export interface DegradationEvent {
    service: string;
    component: string;
    severity: DegradationSeverity;
    message: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
}
export interface DegradationReporter {
    report(component: string, severity: DegradationSeverity, message: string, metadata?: Record<string, unknown>): void;
    getRecent(limit?: number): DegradationEvent[];
    getCounts(): Record<string, number>;
}
export interface DegradationReporterOptions {
    logger?: Logger;
    publishFn?: (type: string, severity: 'info' | 'warning' | 'critical', data: Record<string, unknown>) => Promise<void>;
}
export declare function createDegradationReporter(serviceName: string, opts?: DegradationReporterOptions): DegradationReporter;
