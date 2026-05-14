export type ConnectorType = 'node' | 'tool' | 'app' | 'pipe';
export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'degraded';
export interface ConnectorHealth {
    status: ConnectorStatus;
    lastCheckedAt: string | null;
    latencyMs: number | null;
    error: string | null;
    metadata?: Record<string, unknown>;
}
export interface TestResult {
    ok: boolean;
    latencyMs: number;
    error?: string;
    details?: Record<string, unknown>;
}
export interface ConnectorContext {
    tenantId?: string;
    companyId?: string;
    agentId?: string;
    correlationId?: string;
    timeout?: number;
}
export interface ConnectorEvents {
    'status-change': (from: ConnectorStatus, to: ConnectorStatus) => void;
    error: (error: Error) => void;
    execute: (operation: string, durationMs: number) => void;
    'health-check': (result: TestResult) => void;
}
export interface BaseConnector<T extends ConnectorType = ConnectorType> {
    readonly type: T;
    readonly id: string;
    readonly name: string;
    status(): ConnectorHealth;
    test(): Promise<TestResult>;
    connect(credentials?: Record<string, unknown>): Promise<void>;
    disconnect(): Promise<void>;
    execute(operation: string, input?: unknown, ctx?: ConnectorContext): Promise<unknown>;
    on<E extends keyof ConnectorEvents>(event: E, listener: ConnectorEvents[E]): void;
    off<E extends keyof ConnectorEvents>(event: E, listener: ConnectorEvents[E]): void;
}
export interface NodeConnectorConfig {
    id: string;
    name: string;
    category?: string;
    authType?: string;
    connect: (credentials?: Record<string, unknown>) => Promise<void>;
    disconnect: () => Promise<void>;
    test: () => Promise<TestResult>;
    execute?: (operation: string, input?: unknown, ctx?: ConnectorContext) => Promise<unknown>;
    healthIntervalMs?: number;
}
export interface NodeConnector extends BaseConnector<'node'> {
    readonly category: string;
    readonly authType: string;
}
export declare function createNodeConnector(config: NodeConnectorConfig): NodeConnector;
export interface ToolConnectorConfig {
    id: string;
    name: string;
    category?: string;
    nodeIds: string[];
    mutating?: boolean;
    execute: (input: unknown, ctx?: ConnectorContext) => Promise<unknown>;
    validate?: (input: unknown) => {
        valid: boolean;
        errors?: string[];
    };
}
export interface ToolConnector extends BaseConnector<'tool'> {
    readonly nodeIds: string[];
    readonly mutating: boolean;
    validate(input: unknown): {
        valid: boolean;
        errors?: string[];
    };
}
export declare function createToolConnector(config: ToolConnectorConfig): ToolConnector;
export interface AppConnectorConfig {
    id: string;
    name: string;
    toolIds: string[];
    initialize?: (ctx?: ConnectorContext) => Promise<void>;
    teardown?: () => Promise<void>;
    onEvent?: (event: string, data: unknown) => void;
}
export interface AppConnector extends BaseConnector<'app'> {
    readonly toolIds: string[];
}
export declare function createAppConnector(config: AppConnectorConfig): AppConnector;
export type PipeDirection = 'one-way' | 'two-way';
export type PipeTransport = 'tls' | 'mtls' | 'local' | 'tailscale' | 'plaintext';
export interface PipeConnectorConfig {
    id: string;
    name: string;
    sourceNodeId: string;
    targetNodeId: string;
    direction: PipeDirection;
    transport?: PipeTransport;
    schedule?: string;
    transform?: (data: unknown) => Promise<unknown>;
    execute: (input: unknown, ctx?: ConnectorContext) => Promise<unknown>;
    test?: () => Promise<TestResult>;
}
export interface PipeConnector extends BaseConnector<'pipe'> {
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
    readonly direction: PipeDirection;
    readonly transport: PipeTransport;
}
export declare function createPipeConnector(config: PipeConnectorConfig): PipeConnector;
export interface ConnectorRegistry {
    register(connector: BaseConnector): void;
    get(id: string): BaseConnector | undefined;
    getByType(type: ConnectorType): BaseConnector[];
    list(): BaseConnector[];
    testAll(): Promise<Map<string, TestResult>>;
    disconnectAll(): Promise<void>;
}
export declare function createConnectorRegistry(): ConnectorRegistry;
