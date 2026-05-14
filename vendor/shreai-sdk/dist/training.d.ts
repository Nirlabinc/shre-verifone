export interface TrainingMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface TrainingRecord {
    id?: string;
    source: string;
    agentId: string;
    messages: TrainingMessage[];
    quality: number | null;
    model: string;
    tenantId: string;
    taskType?: string;
    domain?: string;
    durationMs?: number;
    tokens?: {
        input: number;
        output: number;
    };
    skills?: Array<{
        skill: string;
        level: number;
    }>;
    conversationType: 'chat' | 'voice' | 'fleet' | 'task' | 'evaluation';
    meta?: Record<string, unknown>;
}
export declare function enableBufferedTraining(opts?: {
    flushIntervalMs?: number;
    maxBufferSize?: number;
    publishFn?: (type: string, severity: string, data: Record<string, unknown>) => Promise<void>;
}): void;
export declare function shutdownBufferedTraining(): Promise<void>;
declare let _trainingPublishFn: ((type: string, severity: string, data: Record<string, unknown>) => Promise<void>) | null;
export declare function setTrainingPublisher(fn: typeof _trainingPublishFn): void;
export declare function getTrainingGateStats(): {
    accepted: number;
    rejected: number;
    gateEnabled: boolean;
};
interface TrainingGateResult {
    passed: boolean;
    reason?: string;
}
export declare function trainingGate(record: TrainingRecord): TrainingGateResult;
export declare function writeTrainingData(record: TrainingRecord): Promise<{
    ok: boolean;
    hash: string;
}>;
export declare function writeConversation(opts: {
    source: string;
    agentId: string;
    messages: TrainingMessage[];
    model: string;
    tenantId?: string;
    quality?: number | null;
    durationMs?: number;
    tokens?: {
        input: number;
        output: number;
    };
    taskType?: string;
    domain?: string;
    meta?: Record<string, unknown>;
}): Promise<{
    ok: boolean;
    hash: string;
}>;
export declare function writeVoiceInteraction(opts: {
    agentId: string;
    userTranscript: string;
    assistantResponse: string;
    model: string;
    tenantId?: string;
    quality?: number | null;
    durationMs?: number;
    sttModel?: string;
    ttsModel?: string;
}): Promise<{
    ok: boolean;
    hash: string;
}>;
export declare function writeFleetExecution(opts: {
    agentId: string;
    taskBrief: string;
    agentOutput: string;
    model: string;
    taskType?: string;
    domain?: string;
    quality?: number | null;
    durationMs?: number;
}): Promise<{
    ok: boolean;
    hash: string;
}>;
export declare function startWALReplay(intervalMs?: number): void;
export declare function stopWALReplay(): void;
export declare function getTrainingStats(): {
    written: number;
    failed: number;
    walQueued: number;
    walReplayed: number;
};
export {};
