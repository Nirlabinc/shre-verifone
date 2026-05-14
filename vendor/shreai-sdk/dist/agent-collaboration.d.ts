import { createLogger } from './logger.js';
export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';
export interface AgentMessage {
    id: string;
    from: string;
    to: string;
    type: 'info' | 'request' | 'reply' | 'help' | 'capability' | 'conflict-warning';
    priority: MessagePriority;
    payload: Record<string, unknown>;
    correlationId?: string;
    timestamp: string;
    ttlMs?: number;
}
export interface FileIntent {
    agentId: string;
    files: string[];
    taskId?: string;
    declaredAt: string;
    expiresAt: string;
}
export interface CapabilityRequest {
    id: string;
    agentId: string;
    description: string;
    urgency: 'low' | 'medium' | 'high';
    status: 'pending' | 'in-progress' | 'fulfilled' | 'rejected';
    fulfilledBy?: string;
    toolName?: string;
    requestedAt: string;
}
export interface AgentActivity {
    agentId: string;
    taskId?: string;
    description: string;
    startedAt: string;
    lastPingAt: string;
}
export interface CollaborationBus {
    send(to: string, type: AgentMessage['type'], payload: Record<string, unknown>, priority?: MessagePriority): Promise<void>;
    request(to: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<AgentMessage>;
    onMessage(handler: (msg: AgentMessage) => void | Promise<void>): void;
    declareIntent(agentId: string, files: string[], taskId?: string): void;
    checkConflicts(agentId: string, files: string[]): FileIntent[];
    clearIntent(agentId: string): void;
    requestCapability(agentId: string, description: string, urgency?: 'low' | 'medium' | 'high'): Promise<string>;
    onCapabilityRequest(handler: (req: CapabilityRequest) => void | Promise<void>): void;
    fulfillCapability(requestId: string, toolName: string, fulfilledBy: string): void;
    announceActivity(agentId: string, taskId: string | undefined, description: string): void;
    getActiveAgents(): Map<string, AgentActivity>;
    onAgentActivity(handler: (activity: AgentActivity) => void | Promise<void>): void;
    requestHelp(from: string, to: string, description: string, context?: Record<string, unknown>): Promise<void>;
    onHelpRequest(handler: (msg: AgentMessage) => void | Promise<void>): void;
}
export interface CollaborationBusOptions {
    agentId: string;
    publishFn?: (type: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    subscribeFn?: (type: string, handler: (data: Record<string, unknown>) => void) => void;
    intentTtlMs?: number;
    logger?: ReturnType<typeof createLogger>;
}
export interface ScaffoldedTool {
    toolName: string;
    description: string;
    scaffoldedAt: string;
    status: 'draft' | 'reviewed' | 'deployed';
}
export interface ScaffoldResult {
    definition: Record<string, unknown>;
    executor: string;
    filePath: string;
}
export interface CapabilityScaffolder {
    scaffold(description: string, toolName: string): ScaffoldResult;
    getScaffolded(): Array<ScaffoldedTool>;
    updateStatus(toolName: string, status: 'reviewed' | 'deployed'): void;
}
export interface CapabilityScaffolderOptions {
    toolsDir: string;
    publishFn?: (type: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    logger?: ReturnType<typeof createLogger>;
}
export declare function createCollaborationBus(serviceName: string, options: CollaborationBusOptions): CollaborationBus;
export declare function createCapabilityScaffolder(options: CapabilityScaffolderOptions): CapabilityScaffolder;
