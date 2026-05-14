export interface DashboardWidget {
    type: 'metric' | 'chart' | 'table' | 'data-grid' | 'todo' | 'link-card';
    title: string;
    data: unknown;
    width?: 1 | 2 | 3 | 4;
    options?: Record<string, unknown>;
}
export interface DashboardConfig {
    title: string;
    description?: string;
    columns?: 1 | 2 | 3 | 4;
    widgets: DashboardWidget[];
    refreshIntervalMs?: number;
}
export type TemplateName = 'sales-overview' | 'ops-dashboard' | 'financial-summary' | 'agent-performance' | 'service-health' | 'custom';
export interface DashboardBuilder {
    fromTemplate(name: TemplateName, data: Record<string, unknown>): DashboardConfig;
    metric(title: string, value: number | string, opts?: {
        delta?: number;
        unit?: string;
        trend?: 'up' | 'down' | 'flat';
    }): DashboardWidget;
    chart(title: string, data: Array<Record<string, unknown>>, opts?: {
        type?: 'bar' | 'line' | 'pie' | 'area';
        xKey?: string;
        yKey?: string;
    }): DashboardWidget;
    table(title: string, rows: Array<Record<string, unknown>>, opts?: {
        columns?: string[];
    }): DashboardWidget;
    dataGrid(title: string, rows: Array<Record<string, unknown>>, opts?: {
        pageSize?: number;
        sortable?: boolean;
    }): DashboardWidget;
    autoChart(title: string, data: Array<Record<string, unknown>>): DashboardWidget;
    extractMetrics(data: Array<Record<string, unknown>>, valueKey: string): Array<DashboardWidget>;
    render(config: DashboardConfig): string;
    renderWidgets(widgets: DashboardWidget[]): string;
}
export declare function createDashboardBuilder(serviceName?: string, _options?: Record<string, unknown>): DashboardBuilder;
export interface DashboardStreamOptions {
    intervalMs?: number;
    fetchData: () => Promise<Record<string, unknown>>;
    template: TemplateName;
    logger?: any;
}
export interface DashboardStream {
    start(): AsyncGenerator<string, void, unknown>;
    stop(): void;
    getLatest(): string | null;
    toSSE(data: string): string;
}
export declare function createDashboardStream(options: DashboardStreamOptions): DashboardStream;
export declare function createDashboardSSEHandler(options: DashboardStreamOptions): {
    handler: (req: any, res: any) => void;
    stopAll: () => void;
};
