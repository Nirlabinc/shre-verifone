export type Provider = 'anthropic' | 'openai' | 'google' | 'nvidia' | 'xai' | 'ollama' | 'ollama-remote' | 'ollama-gpu' | 'claude-cli' | 'perplexity' | 'bedrock' | 'vertex' | 'keith' | 'github';
export type Tier = 'economy' | 'standard' | 'premium';
export type ExpertiseDomain = 'code' | 'reasoning' | 'agentic' | 'multimodal' | 'extraction' | 'conversation' | 'security' | 'data' | 'long-context';
export interface ModelEntry {
    name: string;
    provider: string;
    tier: Tier;
    pricing: {
        inputPer1M: number;
        outputPer1M: number;
    };
    contextWindow: number;
    capabilityScore: number;
    local: boolean;
    expertise?: Partial<Record<ExpertiseDomain, number>>;
}
export interface GateMapping {
    primary: string;
    fallback: string;
}
export interface AgentModelOverride {
    model: string;
}
export interface ModelConfig {
    version: number;
    catalog: Record<string, ModelEntry>;
    roles: Record<string, string>;
    gates: Record<string, GateMapping>;
    defaultFallbackChain: string[];
    agents: {
        defaults: {
            model: string;
            councilModel: string;
        };
        overrides: Record<string, AgentModelOverride>;
    };
    openclaw?: {
        syncEnabled: boolean;
        primaryModel: string;
        fallbacks: string[];
    };
}
export type TaskType = 'conversation' | 'extraction' | 'code' | 'agentic' | 'reasoning' | 'multimodal' | 'data' | 'unknown';
export type Complexity = 'simple' | 'medium' | 'hard' | 'expert';
export interface SignalResult {
    taskType: TaskType;
    complexity: Complexity;
    modality: 'text' | 'multimodal';
    latencySensitive: boolean;
    budget: 'economy' | 'standard' | 'premium';
    confidence: number;
}
export interface RouteRequest {
    prompt: string;
    agentId?: string;
    budget?: string;
    taskType?: TaskType;
}
export interface RouteResult {
    model: string;
    provider: string;
    fallbackModel?: string;
    fallbackProvider?: string;
    gate: string;
    confidence: number;
    signals: SignalResult;
    reasoning: string;
}
export type EventSeverity = 'info' | 'warn' | 'warning' | 'critical' | 'resolved' | 'success' | 'failure';
export interface ShreEvent {
    id: string;
    source: string;
    type: string;
    severity: EventSeverity;
    data: Record<string, unknown>;
    ts: string;
    correlationId?: string;
}
export interface TaskCompleteEvent {
    agentId: string;
    sessionKey: string;
    taskType?: string;
    summary?: string;
    transcript?: string;
    duration?: number;
    timestamp?: string;
    appId?: string;
    appSkillIds?: string[];
}
export interface EvaluationResult {
    agentId: string;
    sessionKey: string;
    quality: number;
    skills: SkillAssessment[];
    reasoning: string;
    industries?: string[];
    taskType?: string;
    timestamp: string;
}
export interface SkillAssessment {
    skillId: string;
    domain: string;
    category: string;
    demonstratedLevel: number;
    confidence: number;
    evidence: string;
}
export interface CostRecord {
    ts: string;
    sessionId?: string;
    agentId?: string;
    model: string;
    fallbackModel?: string;
    taskType?: string;
    complexity?: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    localSavingsUsd: number;
    routingLatencyMs?: number;
    confidence?: number;
    actualTokens?: boolean;
    tokenSource?: 'actual' | 'estimated';
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    modelLatencyMs?: number;
}
export type CortexDataType = 'route_decision' | 'evaluation' | 'skill_transition' | 'training_data' | 'industry_experience' | 'memory_turn' | 'agent_event' | 'cost_event' | 'health_heartbeat' | string;
export interface CortexWriteRequest {
    data_type: CortexDataType;
    payload: Record<string, unknown>;
    actor: string;
    correlationId?: string;
    tenantId?: string;
}
export interface CortexQueryRequest {
    data_type: CortexDataType;
    filters?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    orderBy?: string;
    order?: 'asc' | 'desc';
}
export interface CortexQueryResponse {
    data: Record<string, unknown>[];
    total: number;
    cached: boolean;
    tier?: 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
}
export interface CortexSearchRequest {
    query: string;
    data_type?: CortexDataType;
    limit?: number;
    min_score?: number;
}
export interface CortexSearchResult {
    data: Record<string, unknown>;
    score: number;
}
export interface CortexSearchResponse {
    results: CortexSearchResult[];
}
export interface ServiceEntry {
    port: number;
    dir: string;
    protocol?: 'https' | 'http';
    type?: string;
    host?: string;
    health_check?: boolean;
}
export interface InfraEntry {
    port: number;
    host?: string;
    protocol?: 'https' | 'http';
}
export interface PortsConfig {
    services: Record<string, ServiceEntry>;
    infrastructure: Record<string, InfraEntry>;
}
export interface HonoLikeContext {
    req: {
        header(name: string): string | undefined;
        method: string;
        url: string;
        path?: string;
        json(): Promise<Record<string, unknown>>;
        raw?: unknown;
        headers?: Record<string, string | undefined>;
    };
    res?: {
        status?: number;
    };
    json(body: unknown, status?: number): Response;
    get(key: string): any;
    set(key: string, value: unknown): void;
}
export interface TaskMemoryTool {
    id: string;
    type: 'system' | 'app' | 'skill';
    origin: 'planned' | 'discovered';
    reason?: string;
}
export interface TaskMemoryPipe {
    id: string;
    from: string;
    to: string;
    dataType: string;
    direction: 'push' | 'pull';
}
export interface TaskMemoryNode {
    id: string;
    service: string;
    access: 'read' | 'write' | 'read_write';
    endpoint?: string;
}
export interface TaskMemoryAgent {
    id: string;
    role: 'predecessor' | 'collaborator' | 'successor' | 'reviewer';
    contribution?: string;
}
export interface TaskMemoryStorage {
    id: string;
    type: 'cortexdb' | 'file' | 'rag' | 'redis' | 'sqlite' | 'nas';
    dataType: string;
    path?: string;
    access: 'read' | 'write' | 'read_write';
}
export interface TaskMemoryConfidence {
    overall: number;
    signals: {
        skillMatch: number;
        completeness: number;
        historicalFit: number;
        availability: number;
        contextQuality: number;
    };
    band: 'very-low' | 'low' | 'medium' | 'high' | 'very-high';
    computedAt: string;
}
export interface TaskMemoryBenchmark {
    agentId: string;
    score: number;
    dimensions: {
        qualityAvg: number;
        completionRate: number;
        speedScore: number;
        resourceDiscovery: number;
        contextContribution: number;
    };
    sampleSize: number;
    signature: string;
    computedAt: string;
}
export interface TaskMemory {
    version: 1;
    tools: TaskMemoryTool[];
    pipes: TaskMemoryPipe[];
    nodes: TaskMemoryNode[];
    agents: TaskMemoryAgent[];
    storage: TaskMemoryStorage[];
    notes?: string[];
    confidence?: TaskMemoryConfidence;
    benchmarks?: TaskMemoryBenchmark[];
    updatedAt: string;
}
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export interface LogEntry {
    ts: string;
    service: string;
    level: LogLevel;
    msg: string;
    correlationId?: string;
    data?: Record<string, unknown>;
    durationMs?: number;
    error?: {
        message: string;
        stack?: string;
        code?: string;
    };
}
