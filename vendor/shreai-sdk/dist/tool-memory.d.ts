export interface ToolSelectionPattern {
    intent: string;
    domain: string;
    toolsUsed: string[];
    agentId: string;
    storeId?: string;
    quality: number;
    shared: boolean;
    ts: string;
}
export interface ToolSelectionMatch {
    tools: string[];
    agentId?: string;
    confidence: number;
    source: 'exact' | 'domain' | 'structural';
}
export interface ToolMemoryStats {
    totalPatterns: number;
    learnedPatterns: number;
    sharedPatterns: number;
    topIntents: Array<{
        intent: string;
        count: number;
    }>;
    topTools: Array<{
        tool: string;
        count: number;
    }>;
    agentCoverage: Record<string, number>;
}
interface ToolMemoryOptions {
    cortexWrite?: (type: string, data: Record<string, unknown>) => Promise<void>;
    cortexQuery?: (sql: string, params?: unknown[]) => Promise<unknown[]>;
    publishFn?: (type: string, severity: string, data: Record<string, unknown>) => void;
    minQuality?: number;
    learnThreshold?: number;
    maxPatterns?: number;
}
export interface ToolMemory {
    learn(pattern: Omit<ToolSelectionPattern, 'ts' | 'shared'>): Promise<void>;
    lookup(intent: string, domain: string, agentId?: string): ToolSelectionMatch | null;
    getSharedTools(intent: string): string[];
    getStats(): ToolMemoryStats;
    flush(): Promise<void>;
}
export declare function createToolMemory(_service: string, opts?: ToolMemoryOptions): ToolMemory;
export {};
