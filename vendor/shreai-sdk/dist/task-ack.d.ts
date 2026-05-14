export type AckStatus = 'received' | 'accepted' | 'rejected' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'escalated';
export interface TaskAck {
    taskId: string;
    agentId: string;
    assignedBy: string;
    status: AckStatus;
    timestamp: string;
    plan?: string;
    progress?: number;
    phase?: string;
    result?: string;
    diagnosis?: FailureDiagnosis;
    metadata?: Record<string, unknown>;
}
export interface FailureDiagnosis {
    reason: string;
    category: 'missing_data' | 'missing_tool' | 'permission_denied' | 'timeout' | 'quality_low' | 'dependency_failed' | 'unknown';
    recommendation: string;
    retryable: boolean;
    retriesAttempted: number;
    maxRetries: number;
    errorDetail?: string;
}
export interface AckTrackerOptions {
    publishFn?: (type: string, severity: string, data: Record<string, unknown>) => void;
    cortexWrite?: (type: string, data: Record<string, unknown>) => Promise<void>;
    onTerminal?: (ack: TaskAck) => void;
    ackTimeoutMs?: number;
    completionTimeoutMs?: number;
    createTask?: (task: RemediationTask) => Promise<string | null>;
    updateTask?: (taskId: string, update: Record<string, unknown>) => Promise<void>;
    maxAckRetries?: number;
    maxAlternativeAgents?: number;
    getAlternativeAgent?: (taskId: string, failedAgentId: string) => string | null;
}
export interface RemediationTask {
    title: string;
    description: string;
    priority: string;
    source: string;
    parent_id?: string;
    tags?: string[];
}
interface TrackedTask {
    taskId: string;
    agentId: string;
    assignedBy: string;
    assignedAt: number;
    lastAckAt: number;
    currentStatus: AckStatus;
    acks: TaskAck[];
    ackRetries: number;
    triedAgents: string[];
    remediationTaskId?: string;
    title?: string;
}
export interface AckTracker {
    assigned(taskId: string, agentId: string, assignedBy: string, title?: string): void;
    ack(taskId: string, agentId: string, status: AckStatus, details?: Partial<TaskAck>): void;
    checkTimeouts(): Promise<TaskAck[]>;
    getState(taskId: string): TrackedTask | undefined;
    getOverdue(): TrackedTask[];
    getStats(): {
        tracked: number;
        overdue: number;
        completed: number;
        failed: number;
        remediated: number;
    };
}
export declare function createAckTracker(opts?: AckTrackerOptions): AckTracker;
export {};
