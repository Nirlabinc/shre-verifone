export type HealRiskTier = 'low' | 'medium' | 'high' | 'never';
export interface HealActionDef {
    id: string;
    label: string;
    risk: HealRiskTier;
    autoApprove: boolean;
    description: string;
    execute: (params: Record<string, unknown>) => Promise<boolean>;
    verify: (params: Record<string, unknown>) => Promise<boolean>;
    timeoutMs?: number;
    cooldownMs?: number;
    matchTags?: string[];
}
export interface HealResult {
    actionId: string;
    executed: boolean;
    success: boolean;
    verified: boolean;
    autoApproved: boolean;
    durationMs: number;
    error?: string;
    completedAt: string;
    risk: HealRiskTier;
    params: Record<string, unknown>;
}
export interface HealActionRunnerOptions {
    publishFn?: (event: string, severity: string, data: Record<string, unknown>) => Promise<void>;
    onApprovalRequired?: (action: HealActionDef, params: Record<string, unknown>) => Promise<void>;
    maxHealsPerHour?: number;
    maxHistorySize?: number;
}
export interface HealActionRunner {
    register(action: HealActionDef): void;
    unregister(actionId: string): void;
    heal(actionId: string, params?: Record<string, unknown>): Promise<HealResult>;
    findActions(tag: string): HealActionDef[];
    autoHeal(tag: string, params?: Record<string, unknown>): Promise<HealResult | null>;
    getHistory(limit?: number): HealResult[];
    getActions(): HealActionDef[];
    getBudget(): {
        used: number;
        remaining: number;
        max: number;
    };
    stats(): {
        totalAttempts: number;
        successCount: number;
        failureCount: number;
        escalatedCount: number;
        registeredActions: number;
    };
}
export declare function createHealActionRunner(serviceName: string, opts?: HealActionRunnerOptions): HealActionRunner;
export declare function createBuiltinHealActions(platform: {
    execSync: (cmd: string, opts?: {
        timeout?: number;
        encoding?: string;
    }) => string;
    fetch: typeof fetch;
    portsJson: Record<string, unknown>;
}): HealActionDef[];
