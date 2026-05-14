import { createLogger } from './logger.js';
export function createConsistencyChecker(service, opts = {}) {
    const log = opts.logger ?? createLogger(`${service}:consistency`);
    const cortexUrl = opts.cortexUrl ?? 'http://127.0.0.1:5400';
    const sampleSize = opts.sampleSize ?? 50;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    async function check(dataType = 'training') {
        const start = Date.now();
        const report = {
            checkedAt: new Date().toISOString(),
            sampled: 0,
            matched: 0,
            missing: 0,
            missingIds: [],
            driftRate: 0,
            durationMs: 0,
        };
        try {
            const queryRes = await fetch(`${cortexUrl}/v1/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sql: `SELECT id, LEFT(COALESCE(
            CASE WHEN messages IS NOT NULL THEN messages::text ELSE '' END, ''
          ), 200) as snippet
          FROM ${dataType}_records
          ORDER BY RANDOM() LIMIT $1`,
                    params: [sampleSize],
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!queryRes.ok) {
                log.warn('CortexDB query failed during consistency check', { status: queryRes.status });
                report.durationMs = Date.now() - start;
                return report;
            }
            const queryData = (await queryRes.json());
            const rows = queryData.rows ?? [];
            report.sampled = rows.length;
            if (rows.length === 0) {
                report.durationMs = Date.now() - start;
                return report;
            }
            const idsToCheck = rows.map((r) => r.id);
            const searchRes = await fetch(`${cortexUrl}/v1/points/lookup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection: dataType,
                    ids: idsToCheck,
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!searchRes.ok) {
                log.debug('Bulk lookup unavailable, falling back to individual checks');
                for (const row of rows) {
                    try {
                        const sRes = await fetch(`${cortexUrl}/v1/search`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                collection: dataType,
                                query: row.snippet || row.id,
                                limit: 1,
                                filter: { id: row.id },
                            }),
                            signal: AbortSignal.timeout(5000),
                        });
                        if (sRes.ok) {
                            const sData = (await sRes.json());
                            if (sData.results && sData.results.length > 0) {
                                report.matched++;
                            }
                            else {
                                report.missingIds.push(row.id);
                            }
                        }
                        else {
                            report.missingIds.push(row.id);
                        }
                    }
                    catch {
                        report.missingIds.push(row.id);
                    }
                }
            }
            else {
                const lookupData = (await searchRes.json());
                const foundSet = new Set(lookupData.found ?? []);
                for (const id of idsToCheck) {
                    if (foundSet.has(id)) {
                        report.matched++;
                    }
                    else {
                        report.missingIds.push(id);
                    }
                }
            }
            report.missing = report.missingIds.length;
            report.driftRate = report.sampled > 0 ? report.missing / report.sampled : 0;
            report.durationMs = Date.now() - start;
            if (report.missing > 0 && opts.publishFn) {
                await opts
                    .publishFn('consistency.drift', 'warning', {
                    service,
                    dataType,
                    sampled: report.sampled,
                    missing: report.missing,
                    driftRate: report.driftRate,
                    missingIds: report.missingIds.slice(0, 10),
                    checkedAt: report.checkedAt,
                })
                    .catch(() => { });
            }
            log.info('Consistency check complete', {
                sampled: report.sampled,
                matched: report.matched,
                missing: report.missing,
                driftRate: `${(report.driftRate * 100).toFixed(1)}%`,
                durationMs: report.durationMs,
            });
        }
        catch (err) {
            log.error('Consistency check failed', { error: err.message });
            report.durationMs = Date.now() - start;
        }
        return report;
    }
    async function reindexMissing(ids) {
        let reindexed = 0;
        let failed = 0;
        for (const id of ids) {
            try {
                const queryRes = await fetch(`${cortexUrl}/v1/query`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sql: `SELECT * FROM training_records WHERE id = $1 LIMIT 1`,
                        params: [id],
                    }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!queryRes.ok) {
                    failed++;
                    continue;
                }
                const data = (await queryRes.json());
                const row = data.rows?.[0];
                if (!row) {
                    failed++;
                    continue;
                }
                const writeRes = await fetch(`${cortexUrl}/v1/write`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        data_type: 'training',
                        ...row,
                        _reindex: true,
                    }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (writeRes.ok) {
                    reindexed++;
                }
                else {
                    failed++;
                }
            }
            catch {
                failed++;
            }
        }
        log.info('Reindex complete', { reindexed, failed, total: ids.length });
        return { reindexed, failed };
    }
    return { check, reindexMissing };
}
