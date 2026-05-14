import type { ModelConfig, ModelEntry, ExpertiseDomain } from './types.js';
export declare function loadConfig(path?: string): ModelConfig;
export declare function reloadConfig(path?: string): ModelConfig;
export declare function startWatching(): void;
export declare function stopWatching(): void;
export declare function onReload(fn: (cfg: ModelConfig) => void): () => void;
export declare function resolveRole(role: string): string;
export declare function resolveGate(gateKey: string): {
    primary: string;
    fallback: string;
};
export declare function getAgentModel(agentId: string): string;
export declare function getModel(modelId: string): ModelEntry | undefined;
export declare function getModelPricing(modelId: string): {
    inputPer1M: number;
    outputPer1M: number;
    local: boolean;
};
export declare function estimateCost(modelId: string, promptTokens: number, completionTokens: number): number;
export declare function matchByExpertise(domain: ExpertiseDomain, minScore?: number): Array<{
    modelId: string;
    model: ModelEntry;
    score: number;
}>;
export declare function cheapestExpert(domain: ExpertiseDomain, minScore?: number): string | null;
export declare function getFallbackChain(): string[];
