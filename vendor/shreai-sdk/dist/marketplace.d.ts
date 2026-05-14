export interface MarketplaceAgent {
    id: string;
    name: string;
    description: string;
    category: 'c-suite' | 'specialist' | 'council' | 'business' | 'custom';
    skills: string[];
    capabilities: string[];
    anatomyPosition: {
        system: string;
        organ: string;
        function: string;
    };
    pricing: {
        model: 'per-month' | 'per-task' | 'per-token' | 'free';
        basePrice: number;
        currency: string;
    };
    metrics: {
        tasksCompleted: number;
        avgQuality: number;
        avgResponseMs: number;
        activeInstances: number;
    };
    status: 'available' | 'beta' | 'deprecated';
    publishedAt: string;
    updatedAt: string;
}
export interface MarketplaceSkill {
    id: string;
    name: string;
    description: string;
    category: string;
    agents: string[];
    version: string;
    pricing: {
        model: 'included' | 'addon' | 'premium';
        price: number;
    };
}
export interface DeploymentRequest {
    agentId: string;
    targetWorkspace: string;
    targetTenant: string;
    skills: string[];
    config?: Record<string, unknown>;
}
export interface DeploymentResult {
    success: boolean;
    instanceId: string;
    workspace: string;
    agent: string;
    skills: string[];
    feedbackWired: boolean;
    mibReporting: boolean;
}
export declare function createMarketplaceClient(config?: {
    cortexUrl?: string;
}): {
    isCoreIP: (agentId: string) => boolean;
    registerAgent: (agent: Omit<MarketplaceAgent, "metrics" | "publishedAt" | "updatedAt">) => Promise<void>;
    registerSkill: (skill: MarketplaceSkill) => Promise<void>;
    deployAgent: (request: DeploymentRequest) => Promise<DeploymentResult>;
    reportUsage: (agentId: string, usage: {
        tasksCompleted: number;
        tokensUsed: number;
        durationMs: number;
        workspace: string;
    }) => Promise<void>;
    getCatalog: () => Promise<{
        agents: MarketplaceAgent[];
        skills: MarketplaceSkill[];
    }>;
    CORE_IP: readonly ["shre", "main"];
};
