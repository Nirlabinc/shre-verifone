export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface ChatOptions {
    messages: ChatMessage[];
    agentId?: string;
    tenantId?: string;
    model?: string;
    stream?: boolean;
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
}
export interface ChatResponse {
    content: string;
    model?: string;
    tokenCount?: number;
    costUsd?: number;
}
export interface Article {
    id: string;
    title: string;
    content: string;
    category?: string;
    tags?: string[];
}
export interface IndexResponse {
    ok: boolean;
    workspaceId: string;
    collection: string;
    articlesProcessed: number;
    chunksIndexed: number;
    errors: number;
}
export interface EnrichIdentifier {
    email?: string;
    orgId?: string;
    externalCustomerId?: string;
}
export interface DeviceInfo {
    userAgent?: string;
    platform?: string;
    appVersion?: string;
    screenResolution?: string;
}
export interface EnrichedProfile {
    customer: {
        companyId: string | null;
        name: string | null;
        email: string | null;
        plan: string;
        posSystem: string | null;
        activeStores: number;
        onboardingStep: string | null;
    };
    device: {
        browser: string;
        os: string;
        appVersion: string | null;
        screenResolution: string | null;
    } | null;
    history: {
        recentTickets: Array<{
            id: string;
            title: string;
            status: string;
            created: string;
        }>;
        totalTickets: number;
        avgResolutionHours: number | null;
        csatAvg: number | null;
    };
    accountHealth: 'good' | 'fair' | 'needs-attention' | 'unknown';
}
export interface ShreClientOptions {
    apiKey: string;
    baseUrl?: string;
    workspaceId?: string;
    defaultAgentId?: string;
    timeoutMs?: number;
}
export declare class ShreClient {
    private apiKey;
    private baseUrl;
    private workspaceId?;
    private defaultAgentId;
    private timeoutMs;
    constructor(opts: ShreClientOptions);
    private request;
    chat(opts: ChatOptions): Promise<ChatResponse>;
    chatStream(opts: ChatOptions): AsyncGenerator<{
        type: 'delta' | 'route' | 'done';
        data: string | Record<string, unknown>;
    }>;
    indexKB(articles: Article[]): Promise<IndexResponse>;
    deleteKBArticle(articleId: string): Promise<{
        ok: boolean;
    }>;
    enrich(identifier: EnrichIdentifier, device?: DeviceInfo): Promise<EnrichedProfile>;
    health(): Promise<{
        status: string;
    }>;
    setWorkspace(workspaceId: string): void;
}
export default ShreClient;
