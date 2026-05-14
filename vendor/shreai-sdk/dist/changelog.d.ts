import { type Logger } from './logger.js';
export type ChangeType = 'feature' | 'fix' | 'refactor' | 'docs' | 'test' | 'security' | 'performance' | 'architecture' | 'deprecation' | 'breaking';
export interface ChangelogEntry {
    agent: string;
    taskId?: string;
    title: string;
    type: ChangeType;
    summary: string;
    filesChanged?: string[];
    service?: string;
    model?: string;
    quality?: number;
    durationMs?: number;
    breaking?: string;
    architectureNotes?: string;
    knowledgeLearned?: string;
}
export interface ChangelogRecord extends ChangelogEntry {
    timestamp: string;
    source: string;
}
export interface ChangelogWriter {
    record(entry: ChangelogEntry): Promise<void>;
    getRecent(limit?: number): ChangelogRecord[];
    getByService(service: string, limit?: number): ChangelogRecord[];
    getByAgent(agent: string, limit?: number): ChangelogRecord[];
}
export interface ChangelogWriterOptions {
    logger?: Logger;
    repoRoot?: string;
    cortexWrite?: (dataType: string, data: Record<string, unknown>) => Promise<void>;
    publishFn?: (type: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    maxBuffer?: number;
    writeFiles?: boolean;
}
export declare function createChangelogWriter(serviceName: string, options?: ChangelogWriterOptions): ChangelogWriter;
export interface AuditEntry {
    timestamp: string;
    eventType: string;
    source: string;
    data: Record<string, unknown>;
    correlationId?: string;
}
export interface AuditWriter {
    start(): void;
    stop(): void;
    record(entry: Omit<AuditEntry, 'timestamp'>): void;
    query(filter?: {
        service?: string;
        eventType?: string;
        since?: string;
        limit?: number;
    }): AuditEntry[];
}
export interface AuditWriterOptions {
    subscribeFn: (pattern: string, handler: (event: any) => Promise<void>) => () => void;
    cortexWrite?: (dataType: string, data: Record<string, unknown>) => Promise<void>;
    logger?: Logger;
    patterns?: string[];
    maxBuffer?: number;
}
export declare function createAuditWriter(service: string, opts: AuditWriterOptions): AuditWriter;
