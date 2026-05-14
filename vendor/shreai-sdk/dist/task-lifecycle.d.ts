export interface TaskLifecycleOptions {
    service: string;
    token: string;
    defaultTtlMs?: number;
    defaultPriority?: 'critical' | 'high' | 'medium' | 'low';
    log?: (msg: string, meta?: Record<string, unknown>) => void;
}
export interface IssueTaskOptions {
    tag: string;
    title: string;
    description?: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    tags?: string[];
    category?: string;
    ttlMs?: number;
}
export interface TaskLifecycleClient {
    createIssue(opts: IssueTaskOptions): Promise<string | null>;
    resolveIssue(tag: string, reason: string): Promise<boolean>;
    isOpen(tag: string): Promise<boolean>;
    getOpenIssues(): Map<string, string>;
}
export declare function createTaskLifecycle(opts: TaskLifecycleOptions): TaskLifecycleClient;
