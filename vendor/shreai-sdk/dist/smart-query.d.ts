export interface TableSchema {
    name: string;
    schema?: string;
    columns: ColumnDef[];
    foreignKeys?: ForeignKey[];
    description?: string;
}
export interface ColumnDef {
    name: string;
    type: 'text' | 'integer' | 'numeric' | 'boolean' | 'timestamp' | 'json';
    label?: string;
    nullable?: boolean;
    description?: string;
}
export interface ForeignKey {
    column: string;
    references: {
        table: string;
        column: string;
    };
}
export interface QueryIntent {
    select: string[];
    from: string;
    joins?: string[];
    where?: Record<string, unknown>;
    groupBy?: string[];
    orderBy?: {
        column: string;
        dir: 'asc' | 'desc';
    }[];
    limit?: number;
}
export interface SmartQuery {
    registerTable(schema: TableSchema): void;
    registerTables(schemas: TableSchema[]): void;
    buildQuery(intent: QueryIntent): {
        sql: string;
        params: unknown[];
        labels: Record<string, string>;
    };
    resolveColumn(alias: string): {
        table: string;
        column: string;
    } | null;
    inferJoins(tables: string[]): {
        from: string;
        joins: Array<{
            table: string;
            on: string;
        }>;
    } | null;
    getSchema(): TableSchema[];
    detectChanges(liveColumns: Record<string, string[]>): Array<{
        table: string;
        added: string[];
        removed: string[];
        changed: string[];
    }>;
}
export interface SmartQueryOptions {
    defaultSchema?: string;
    maxLimit?: number;
}
export declare function createSmartQuery(serviceName: string, options?: SmartQueryOptions): SmartQuery;
