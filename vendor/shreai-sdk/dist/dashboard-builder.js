import { createLogger } from './logger.js';
function numericValues(data, key) {
    return data.map((r) => Number(r[key])).filter((n) => !isNaN(n));
}
function inferKeys(data) {
    if (!data.length)
        return null;
    const first = data[0];
    const keys = Object.keys(first);
    const firstNumericKey = keys.find((k) => typeof first[k] === 'number');
    const firstStringKey = keys.find((k) => typeof first[k] === 'string');
    return {
        xKey: firstStringKey ?? keys[0] ?? 'x',
        yKey: firstNumericKey ?? keys[1] ?? keys[0] ?? 'y',
    };
}
function inferChartType(data, xKey, yKey) {
    const uniqueX = new Set(data.map((r) => r[xKey]));
    const isTimeSeries = data.some((r) => {
        const v = String(r[xKey]);
        return /^\d{4}-\d{2}/.test(v) || /^\d{1,2}\/\d{1,2}/.test(v);
    });
    if (isTimeSeries)
        return 'line';
    const total = numericValues(data, yKey).reduce((a, b) => a + b, 0);
    if (uniqueX.size <= 6 && total > 0)
        return 'pie';
    if (uniqueX.size <= 20)
        return 'bar';
    return 'area';
}
function sum(nums) {
    return nums.reduce((a, b) => a + b, 0);
}
function avg(nums) {
    return nums.length ? sum(nums) / nums.length : 0;
}
function trendDirection(nums) {
    if (nums.length < 2)
        return 'flat';
    const first = nums.slice(0, Math.ceil(nums.length / 2));
    const second = nums.slice(Math.ceil(nums.length / 2));
    const avgFirst = avg(first);
    const avgSecond = avg(second);
    const diff = avgSecond - avgFirst;
    if (Math.abs(diff) < avgFirst * 0.02)
        return 'flat';
    return diff > 0 ? 'up' : 'down';
}
function toContentBlock(w) {
    const d = w.data;
    switch (w.type) {
        case 'metric':
            return {
                type: 'metric',
                title: w.title,
                value: d.value,
                unit: d.unit,
                change: d.delta,
                changeLabel: d.trend ? `${d.trend}` : undefined,
            };
        case 'chart':
            return {
                type: 'chart',
                chartType: d.chartType,
                title: w.title,
                labels: d.labels,
                datasets: d.datasets,
                options: w.options,
            };
        case 'table':
            return {
                type: 'table',
                title: w.title,
                headers: d.headers,
                rows: d.rows,
                sortable: w.options?.sortable ?? true,
            };
        case 'data-grid':
            return {
                type: 'data-grid',
                title: w.title,
                columns: d.columns,
                rows: d.rows,
            };
        case 'todo':
            return { type: 'todo', title: w.title, items: d.items };
        case 'link-card':
            return { type: 'link-card', title: w.title, ...d };
        default:
            return { type: w.type, title: w.title, ...d };
    }
}
function widgetFence(block) {
    return '```mib-widget\n' + JSON.stringify(block, null, 2) + '\n```';
}
const TEMPLATES = {
    'sales-overview': (b, data) => {
        const rows = (data.sales ?? data.rows ?? []);
        const widgets = [
            ...b.extractMetrics(rows, data.valueKey ?? 'amount'),
            b.autoChart('Sales Trend', rows),
            b.table('Sales Data', rows),
        ];
        return { title: 'Sales Overview', columns: 4, widgets };
    },
    'ops-dashboard': (b, data) => {
        const services = (data.services ?? []);
        const tasks = (data.tasks ?? []);
        const widgets = [
            b.metric('Services', services.length, { trend: 'flat' }),
            b.metric('Active Tasks', tasks.filter((t) => t.status === 'active').length),
            b.table('Service Status', services, { columns: ['name', 'status', 'uptime'] }),
        ];
        if (tasks.length)
            widgets.push(b.table('Recent Tasks', tasks.slice(0, 10)));
        return { title: 'Operations Dashboard', columns: 4, widgets };
    },
    'financial-summary': (b, data) => {
        const rows = (data.transactions ?? data.rows ?? []);
        const valKey = data.valueKey ?? 'amount';
        const widgets = [
            ...b.extractMetrics(rows, valKey),
            b.chart('Revenue by Category', rows, { type: 'pie', xKey: 'category', yKey: valKey }),
            b.autoChart('Financial Trend', rows),
        ];
        return { title: 'Financial Summary', columns: 4, widgets };
    },
    'agent-performance': (b, data) => {
        const agents = (data.agents ?? []);
        const widgets = [
            b.metric('Total Agents', agents.length),
            b.chart('Quality Scores', agents, { type: 'bar', xKey: 'name', yKey: 'quality_score' }),
            b.dataGrid('Agent Details', agents, { sortable: true, pageSize: 10 }),
        ];
        return { title: 'Agent Performance', columns: 4, widgets };
    },
    'service-health': (b, data) => {
        const services = (data.services ?? []);
        const healthy = services.filter((s) => s.status === 'healthy' || s.status === 'up');
        const widgets = [
            b.metric('Healthy', `${healthy.length}/${services.length}`, {
                trend: healthy.length === services.length ? 'up' : 'down',
            }),
            b.chart('Status Distribution', [
                { status: 'Healthy', count: healthy.length },
                { status: 'Unhealthy', count: services.length - healthy.length },
            ], { type: 'pie', xKey: 'status', yKey: 'count' }),
            b.table('Services', services, { columns: ['name', 'port', 'status', 'latency'] }),
        ];
        return { title: 'Service Health', columns: 4, widgets };
    },
};
export function createDashboardBuilder(serviceName, _options) {
    const log = createLogger(serviceName ?? 'dashboard-builder');
    const builder = {
        fromTemplate(name, data) {
            const tmpl = TEMPLATES[name];
            if (!tmpl) {
                log.warn('Unknown template, falling back to custom', { name });
                return { title: name, columns: 4, widgets: [] };
            }
            log.debug('Building from template', { name });
            return tmpl(builder, data);
        },
        metric(title, value, opts) {
            return {
                type: 'metric',
                title,
                width: 1,
                data: { value, unit: opts?.unit, delta: opts?.delta, trend: opts?.trend },
                options: opts,
            };
        },
        chart(title, data, opts) {
            const xKey = opts?.xKey ?? inferKeys(data)?.xKey ?? 'label';
            const yKey = opts?.yKey ?? inferKeys(data)?.yKey ?? 'value';
            const chartType = opts?.type ?? 'bar';
            const labels = data.map((r) => String(r[xKey] ?? ''));
            const values = numericValues(data, yKey);
            return {
                type: 'chart',
                title,
                width: 2,
                data: {
                    chartType,
                    labels,
                    datasets: [{ label: yKey, data: values }],
                },
            };
        },
        table(title, rows, opts) {
            const columns = opts?.columns ?? (rows.length ? Object.keys(rows[0]) : []);
            const headers = columns;
            const tableRows = rows.map((r) => columns.map((c) => String(r[c] ?? '')));
            return {
                type: 'table',
                title,
                width: 4,
                data: { headers, rows: tableRows },
                options: { sortable: true },
            };
        },
        dataGrid(title, rows, opts) {
            const keys = rows.length ? Object.keys(rows[0]) : [];
            const columns = keys.map((k) => ({ key: k, label: k, align: 'left' }));
            return {
                type: 'data-grid',
                title,
                width: 4,
                data: { columns, rows, pageSize: opts?.pageSize ?? 20 },
                options: { sortable: opts?.sortable ?? true, pageSize: opts?.pageSize ?? 20 },
            };
        },
        autoChart(title, data) {
            const inferred = inferKeys(data);
            if (!inferred) {
                log.warn('autoChart: empty data', { title });
                return builder.chart(title, data);
            }
            const { xKey, yKey } = inferred;
            const chartType = inferChartType(data, xKey, yKey);
            log.debug('autoChart inferred', { title, chartType, xKey, yKey });
            return builder.chart(title, data, { type: chartType, xKey, yKey });
        },
        extractMetrics(data, valueKey) {
            const values = numericValues(data, valueKey);
            if (!values.length)
                return [];
            const total = sum(values);
            const average = avg(values);
            const min = Math.min(...values);
            const max = Math.max(...values);
            const trend = trendDirection(values);
            const last = values[values.length - 1] ?? 0;
            const prev = values[values.length - 2] ?? 0;
            const delta = values.length >= 2 ? ((last - prev) / (prev || 1)) * 100 : 0;
            return [
                builder.metric('Total', total, { delta: Math.round(delta * 10) / 10, trend }),
                builder.metric('Average', Math.round(average * 100) / 100, { trend }),
                builder.metric('Min', min),
                builder.metric('Max', max),
            ];
        },
        render(config) {
            const parts = [];
            if (config.title)
                parts.push(`## ${config.title}`);
            if (config.description)
                parts.push(config.description);
            parts.push('');
            parts.push(builder.renderWidgets(config.widgets));
            if (config.refreshIntervalMs) {
                parts.push(`\n_Auto-refreshes every ${Math.round(config.refreshIntervalMs / 1000)}s_`);
            }
            return parts.join('\n');
        },
        renderWidgets(widgets) {
            if (!widgets.length)
                return '';
            const cols = 4;
            const lines = [];
            let colUsed = 0;
            for (const w of widgets) {
                const width = w.width ?? 1;
                if (colUsed + width > cols)
                    colUsed = 0;
                const block = toContentBlock(w);
                lines.push(widgetFence(block));
                lines.push('');
                colUsed += width;
                if (colUsed >= cols)
                    colUsed = 0;
            }
            return lines.join('\n').trim();
        },
    };
    return builder;
}
export function createDashboardStream(options) {
    const { intervalMs = 10_000, fetchData, template } = options;
    const log = options.logger ?? createLogger('dashboard-stream');
    const builder = createDashboardBuilder('dashboard-stream');
    let running = false;
    let latest = null;
    const stream = {
        async *start() {
            running = true;
            log.info('Dashboard stream started', { template, intervalMs });
            while (running) {
                try {
                    const data = await fetchData();
                    const config = builder.fromTemplate(template, data);
                    const markdown = builder.render(config);
                    latest = markdown;
                    yield markdown;
                }
                catch (err) {
                    log.error('Dashboard stream fetch error', { error: err.message });
                }
                if (!running)
                    break;
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, intervalMs);
                    const check = setInterval(() => {
                        if (!running) {
                            clearTimeout(timer);
                            clearInterval(check);
                            resolve();
                        }
                    }, 500);
                    setTimeout(() => clearInterval(check), intervalMs + 10);
                });
            }
            log.info('Dashboard stream stopped', { template });
        },
        stop() {
            running = false;
        },
        getLatest() {
            return latest;
        },
        toSSE(data) {
            const payload = JSON.stringify({
                markdown: data,
                timestamp: new Date().toISOString(),
            });
            return `event: dashboard\ndata: ${payload}\n\n`;
        },
    };
    return stream;
}
export function createDashboardSSEHandler(options) {
    const log = options.logger ?? createLogger('dashboard-sse');
    const activeStreams = new Set();
    function handler(_req, res) {
        res.writeHead?.(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        if (!res.writeHead) {
            res.setHeader?.('Content-Type', 'text/event-stream');
            res.setHeader?.('Cache-Control', 'no-cache');
            res.setHeader?.('Connection', 'keep-alive');
            res.status?.(200);
        }
        const stream = createDashboardStream(options);
        activeStreams.add(stream);
        log.info('SSE client connected', { activeCount: activeStreams.size });
        const generator = stream.start();
        (async () => {
            try {
                for await (const markdown of generator) {
                    if (!activeStreams.has(stream))
                        break;
                    const sse = stream.toSSE(markdown);
                    res.write(sse);
                    res.flush?.();
                }
            }
            catch (err) {
                log.error('SSE stream error', { error: err.message });
            }
        })();
        const cleanup = () => {
            stream.stop();
            activeStreams.delete(stream);
            log.info('SSE client disconnected', { activeCount: activeStreams.size });
        };
        if (typeof res.on === 'function') {
            res.on('close', cleanup);
        }
    }
    function stopAll() {
        log.info('Stopping all SSE streams', { activeCount: activeStreams.size });
        activeStreams.forEach((s) => s.stop());
        activeStreams.clear();
    }
    return { handler, stopAll };
}
