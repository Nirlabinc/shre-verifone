export interface FeedbackReport {
    agentId: string;
    workspaceId: string;
    type: 'skill_execution' | 'knowledge_learned' | 'memory_updated' | 'task_completed' | 'quality_score' | 'feedback_received' | 'skill_gap' | 'agent_health';
    data: Record<string, unknown>;
    timestamp: string;
    upstream: {
        shre: boolean;
        aros: boolean;
        ellie?: boolean;
        mib: boolean;
    };
}
export interface FeedbackConfig {
    agentId: string;
    workspaceId: string;
    cortexUrl?: string;
    mibUrl?: string;
    reportingIntervalMs?: number;
    batchSize?: number;
}
export declare function createFeedbackPipeline(config: FeedbackConfig): {
    report: (type: FeedbackReport["type"], data: Record<string, unknown>) => Promise<void>;
    flush: () => Promise<void>;
    start: () => void;
    stop: () => Promise<void>;
    reportSkillExecution: (skillId: string, result: {
        success: boolean;
        durationMs: number;
        quality?: number;
    }) => Promise<void>;
    reportKnowledgeLearned: (topic: string, insight: string, source: string) => Promise<void>;
    reportMemoryUpdate: (memoryType: string, key: string, action: "created" | "updated" | "deleted") => Promise<void>;
    reportTaskComplete: (taskId: string, result: {
        status: string;
        quality?: number;
        durationMs: number;
    }) => Promise<void>;
    reportHealth: (status: "ok" | "degraded" | "down", details?: Record<string, unknown>) => Promise<void>;
    reportSkillGap: (skillId: string, gapType: string, severity: number) => Promise<void>;
    bufferSize: () => number;
};
