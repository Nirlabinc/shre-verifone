import type { DiagnosticEngine, DiagnosticReport, KnownErrorPattern } from './diagnostic-engine.js';
interface RAGClientLike {
    search(query: string, tenantId: string | null, limit?: number): Promise<Array<{
        content: string;
        score?: number;
        metadata?: Record<string, unknown>;
    }>>;
}
export declare function registerMLDiagnosticPatterns(engine: DiagnosticEngine): void;
export interface EnrichedDiagnosticReport extends DiagnosticReport {
    mlSystemsContext: Array<{
        content: string;
        chapter?: number;
        category?: string;
        relevance: number;
    }>;
    textbookRemediationSteps: string[];
}
export declare function enrichDiagnosticWithRAG(report: DiagnosticReport, ragClient: RAGClientLike): Promise<EnrichedDiagnosticReport>;
export declare const ML_DIAGNOSTIC_PATTERNS: KnownErrorPattern[];
export {};
