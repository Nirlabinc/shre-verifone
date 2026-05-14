import { createLogger } from './logger.js';
const OP_MAP = {
    $gt: '>',
    $gte: '>=',
    $lt: '<',
    $lte: '<=',
    $ne: '!=',
    $like: 'LIKE',
};
const AGG_RE = /^(SUM|AVG|COUNT|MIN|MAX|COALESCE)\s*\(/i;
export function createSmartQuery(serviceName, options = {}) {
    const log = createLogger(serviceName);
    const tables = new Map();
    const maxLimit = options.maxLimit ?? 10_000;
    function qualifiedName(t) {
        const s = t.schema ?? options.defaultSchema;
        return s ? `${s}.${t.name}` : t.name;
    }
    function findTable(name) {
        if (tables.has(name))
            return tables.get(name);
        for (const t of tables.values())
            if (qualifiedName(t) === name)
                return t;
        return undefined;
    }
    function aliasIndex() {
        const idx = new Map();
        for (const t of tables.values()) {
            for (const col of t.columns) {
                idx.set(`${t.name}.${col.name}`, { table: t.name, column: col.name });
                if (col.label)
                    idx.set(col.label.toLowerCase(), { table: t.name, column: col.name });
                idx.set(col.name, { table: t.name, column: col.name });
            }
        }
        return idx;
    }
    function fkGraph() {
        const g = new Map();
        for (const t of tables.values()) {
            if (!t.foreignKeys)
                continue;
            for (const fk of t.foreignKeys) {
                if (!g.has(t.name))
                    g.set(t.name, new Map());
                g.get(t.name).set(fk.references.table, {
                    fromCol: fk.column,
                    toCol: fk.references.column,
                });
                if (!g.has(fk.references.table))
                    g.set(fk.references.table, new Map());
                g.get(fk.references.table).set(t.name, {
                    fromCol: fk.references.column,
                    toCol: fk.column,
                });
            }
        }
        return g;
    }
    function buildLabels(selectExprs) {
        const labels = {};
        const idx = aliasIndex();
        for (const expr of selectExprs) {
            if (AGG_RE.test(expr.trim())) {
                const inner = expr.replace(/^[A-Z]+\s*\(\s*/i, '').replace(/\s*\)$/, '');
                const resolved = idx.get(inner) ?? idx.get(inner.toLowerCase());
                if (resolved) {
                    const col = findTable(resolved.table)?.columns.find((c) => c.name === resolved.column);
                    const fn = expr.match(/^([A-Z]+)\s*\(/i)?.[1]?.toUpperCase() ?? '';
                    labels[expr] = `${fn} ${col?.label ?? resolved.column}`;
                }
                else {
                    labels[expr] = expr;
                }
            }
            else {
                const resolved = idx.get(expr) ?? idx.get(expr.toLowerCase());
                if (resolved) {
                    const col = findTable(resolved.table)?.columns.find((c) => c.name === resolved.column);
                    labels[expr] = col?.label ?? resolved.column;
                }
                else {
                    labels[expr] = expr;
                }
            }
        }
        return labels;
    }
    function buildWhere(where, params) {
        const clauses = [];
        for (const [key, value] of Object.entries(where)) {
            if (value === null || value === undefined) {
                clauses.push(`${key} IS NULL`);
                continue;
            }
            if (typeof value === 'object' && !Array.isArray(value)) {
                const ops = value;
                if (ops.$isNull !== undefined) {
                    clauses.push(ops.$isNull ? `${key} IS NULL` : `${key} IS NOT NULL`);
                    continue;
                }
                if (ops.$in) {
                    const ph = ops.$in.map((_, i) => `$${params.length + i + 1}`).join(', ');
                    params.push(...ops.$in);
                    clauses.push(`${key} IN (${ph})`);
                    continue;
                }
                for (const [op, val] of Object.entries(ops)) {
                    const sqlOp = OP_MAP[op];
                    if (sqlOp) {
                        params.push(val);
                        clauses.push(`${key} ${sqlOp} $${params.length}`);
                    }
                }
            }
            else {
                params.push(value);
                clauses.push(`${key} = $${params.length}`);
            }
        }
        return clauses.length > 0 ? clauses.join(' AND ') : '1=1';
    }
    function registerTable(schema) {
        tables.set(schema.name, schema);
        log.debug('Table registered', { table: schema.name, columns: schema.columns.length });
    }
    function registerTables(schemas) {
        for (const s of schemas)
            registerTable(s);
    }
    function resolveColumn(alias) {
        const idx = aliasIndex();
        return idx.get(alias) ?? idx.get(alias.toLowerCase()) ?? null;
    }
    function inferJoins(targetTables) {
        if (targetTables.length < 2)
            return null;
        const graph = fkGraph();
        const from = targetTables[0];
        const joins = [];
        for (let i = 1; i < targetTables.length; i++) {
            const target = targetTables[i];
            const path = bfs(graph, from, target);
            if (!path) {
                log.warn('No JOIN path found', { from, to: target });
                return null;
            }
            for (let j = 0; j < path.length - 1; j++) {
                const a = path[j], b = path[j + 1];
                if (joins.some((jn) => jn.table === b))
                    continue;
                const edge = graph.get(a)?.get(b);
                if (!edge)
                    continue;
                const tA = findTable(a), tB = findTable(b);
                const qA = tA ? qualifiedName(tA) : a;
                const qB = tB ? qualifiedName(tB) : b;
                joins.push({ table: qB, on: `${qA}.${edge.fromCol} = ${qB}.${edge.toCol}` });
            }
        }
        const ft = findTable(from);
        return { from: ft ? qualifiedName(ft) : from, joins };
    }
    function buildQuery(intent) {
        const params = [];
        const parts = [`SELECT ${intent.select.join(', ')}`];
        const fromQ = findTable(intent.from) ? qualifiedName(findTable(intent.from)) : intent.from;
        if (intent.joins?.length) {
            const inferred = inferJoins([intent.from, ...intent.joins]);
            if (inferred) {
                parts.push(`FROM ${inferred.from}`);
                for (const j of inferred.joins)
                    parts.push(`JOIN ${j.table} ON ${j.on}`);
            }
            else {
                parts.push(`FROM ${fromQ}`);
                log.warn('JOIN inference failed, using bare FROM', {
                    tables: [intent.from, ...intent.joins],
                });
            }
        }
        else {
            parts.push(`FROM ${fromQ}`);
        }
        if (intent.where && Object.keys(intent.where).length > 0)
            parts.push(`WHERE ${buildWhere(intent.where, params)}`);
        if (intent.groupBy?.length)
            parts.push(`GROUP BY ${intent.groupBy.join(', ')}`);
        if (intent.orderBy?.length)
            parts.push(`ORDER BY ${intent.orderBy.map((o) => `${o.column} ${o.dir.toUpperCase()}`).join(', ')}`);
        if (intent.limit !== undefined)
            parts.push(`LIMIT ${Math.min(Math.max(1, intent.limit), maxLimit)}`);
        const sql = parts.join('\n');
        const labels = buildLabels(intent.select);
        log.debug('Query built', { sql, paramCount: params.length });
        return { sql, params, labels };
    }
    function getSchema() {
        return Array.from(tables.values());
    }
    function detectChanges(liveColumns) {
        const diffs = [];
        for (const [name, liveCols] of Object.entries(liveColumns)) {
            const reg = tables.get(name);
            if (!reg) {
                diffs.push({ table: name, added: liveCols, removed: [], changed: [] });
                continue;
            }
            const regNames = new Set(reg.columns.map((c) => c.name));
            const liveSet = new Set(liveCols);
            const added = liveCols.filter((c) => !regNames.has(c));
            const removed = reg.columns.filter((c) => !liveSet.has(c.name)).map((c) => c.name);
            if (added.length || removed.length) {
                diffs.push({ table: name, added, removed, changed: [] });
                log.warn('Schema drift detected', { table: name, added, removed });
            }
        }
        for (const name of tables.keys()) {
            if (!(name in liveColumns)) {
                diffs.push({
                    table: name,
                    added: [],
                    removed: tables.get(name).columns.map((c) => c.name),
                    changed: [],
                });
                log.warn('Table missing from live schema', { table: name });
            }
        }
        return diffs;
    }
    return {
        registerTable,
        registerTables,
        buildQuery,
        resolveColumn,
        inferJoins,
        getSchema,
        detectChanges,
    };
}
function bfs(graph, start, end) {
    if (start === end)
        return [start];
    const visited = new Set([start]);
    const queue = [{ node: start, path: [start] }];
    while (queue.length > 0) {
        const { node, path } = queue.shift();
        const neighbors = graph.get(node);
        if (!neighbors)
            continue;
        for (const neighbor of neighbors.keys()) {
            if (visited.has(neighbor))
                continue;
            const np = [...path, neighbor];
            if (neighbor === end)
                return np;
            visited.add(neighbor);
            queue.push({ node: neighbor, path: np });
        }
    }
    return null;
}
