export type EventDomain = 'git' | 'health' | 'sales' | 'task' | 'deploy' | 'alert' | 'custom';
export interface CausalEvent {
    domain: EventDomain;
    type: string;
    id: string;
    timestamp: string;
    service?: string;
    payload: Record<string, unknown>;
}
export interface CausalLink {
    causeId: string;
    effectId: string;
    causeDomain: EventDomain;
    effectDomain: EventDomain;
    method: 'granger' | 'intervention' | 'temporal_proximity' | 'domain_rule';
    strength: number;
    lagMs: number;
    mechanism?: string;
}
export interface CausalChain {
    links: CausalLink[];
    rootCause: CausalEvent;
    finalEffect: CausalEvent;
    confidence: number;
    mechanism: string;
}
export interface Explanation {
    eventId: string;
    rootCauses: Array<{
        event: CausalEvent;
        confidence: number;
        path: CausalLink[];
    }>;
    contributingFactors: CausalEvent[];
    narrative: string;
}
export interface TimeSeries {
    key: string;
    points: Array<{
        timestamp: number;
        value: number;
    }>;
}
export interface GrangerResult {
    causeKey: string;
    effectKey: string;
    fStatistic: number;
    pValue: number;
    isSignificant: boolean;
    optimalLag: number;
}
export interface InterventionResult {
    eventId: string;
    affectedSeries: string;
    beforeMean: number;
    afterMean: number;
    delta: number;
    deltaPct: number;
    tStatistic: number;
    pValue: number;
    isSignificant: boolean;
}
export interface CausalEngineOptions {
    cortexUrl?: string;
    maxEventAge?: number;
    grangerLags?: number;
    bucketMs?: number;
    significanceLevel?: number;
    minProximityMs?: number;
    maxProximityMs?: number;
}
export interface CausalEngine {
    ingestEvent(event: CausalEvent): void;
    ingestTimeSeries(key: string, value: number, timestamp: string): void;
    grangerTest(causeKey: string, effectKey: string): GrangerResult | null;
    interventionTest(eventId: string, seriesKey: string, windowMs?: number): InterventionResult | null;
    grangerScan(): GrangerResult[];
    inferLinks(): CausalLink[];
    inferChains(): CausalChain[];
    explain(eventId: string): Explanation;
    persistToCortex(): Promise<number>;
    loadFromCortex(): Promise<number>;
    stats(): {
        events: number;
        timeSeries: number;
        links: number;
        chains: number;
        domains: Record<string, number>;
    };
}
export declare function createCausalEngine(opts?: CausalEngineOptions): CausalEngine;
