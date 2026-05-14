import { type Logger } from './logger.js';
import type { CostRecord } from './types.js';
export type BudgetAction = 'allow' | 'force-cheap' | 'local-only' | 'block';
export interface BudgetCheck {
    action: BudgetAction;
    reason: string;
    dailySpentUsd: number;
    dailyLimitUsd: number;
    dailyPct: number;
    weeklySpentUsd: number;
    weeklyLimitUsd: number;
    weeklyPct: number;
}
export interface CostClientConfig {
    service: string;
    meterUrl?: string;
    routerUrl?: string;
    budgetCacheTtlMs?: number;
    timeoutMs?: number;
    logger?: Logger;
    publishFn?: (type: string, severity: 'info' | 'warning' | 'critical', data: Record<string, unknown>) => Promise<void>;
}
export interface CostClient {
    record(event: CostRecord): void;
    checkBudget(agentId: string): Promise<BudgetCheck>;
    canProceed(agentId: string): Promise<boolean>;
}
export declare function createCostClient(config: CostClientConfig): CostClient;
