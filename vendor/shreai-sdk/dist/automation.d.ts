export interface CreateRuleRequest {
    name: string;
    workspace_id: string;
    org_node_id?: string;
    description?: string;
    trigger_type: 'schedule' | 'event' | 'threshold' | 'webhook' | 'chain';
    trigger_config: Record<string, unknown>;
    actions: Array<{
        type: string;
        config: Record<string, unknown>;
        continueOnFailure?: boolean;
        timeoutMs?: number;
    }>;
    escalation?: {
        enabled: boolean;
        waitWindowMs: number;
        maxDepth: number;
        autoResolveOnClear: boolean;
        notifyOnEscalate: boolean;
    };
    tags?: string[];
    cooldown_ms?: number;
    max_runs_per_hour?: number;
    created_by?: string;
}
export interface AutomationRule {
    id: string;
    name: string;
    workspace_id: string;
    org_node_id: string | null;
    trigger_type: string;
    trigger_config: Record<string, unknown>;
    actions: Array<Record<string, unknown>>;
    escalation: Record<string, unknown>;
    enabled: boolean;
    status: string;
    tags: string[];
    created_at: number;
    updated_at: number;
}
export interface RuleFilters {
    org_node_id?: string;
    trigger_type?: string;
    status?: string;
    limit?: number;
    offset?: number;
}
export interface AutomationClient {
    createRule(rule: CreateRuleRequest): Promise<AutomationRule>;
    triggerRule(ruleId: string, context?: Record<string, unknown>): Promise<{
        ok: boolean;
        runId?: string;
    }>;
    resolveEscalation(chainId: string, resolvedBy: string, note: string): Promise<boolean>;
    listRules(workspaceId: string, filters?: RuleFilters): Promise<AutomationRule[]>;
    getTemplates(category?: string): Promise<Array<Record<string, unknown>>>;
}
export declare function createAutomationClient(serviceName: string, opts?: {
    url?: string;
}): AutomationClient;
