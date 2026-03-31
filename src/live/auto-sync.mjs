/**
 * Verifone Commander Auto-Sync Engine
 *
 * Interval-based sync from Commander devices to CortexDB.
 * Follows the same resumable-ledger pattern as shre-rapidrms/src/live/auto-sync.mjs.
 *
 * On each cycle:
 *   1. Check/refresh session cookie
 *   2. Fetch vreportpdlist → diff against ledger → fetch new periods
 *   3. Fetch priority reports (summary, department, plu, network)
 *   4. Every 4th cycle: fetch secondary reports (hourly, tax, category, deal, carWash, networkTotals)
 *   5. Store JSONB → update ledger
 *
 * Usage:
 *   import { startSync, stopSync, triggerSync } from './auto-sync.mjs';
 *   startSync(pool, siteId, siteConfig, { onComplete });
 */

import { createLogger } from 'shre-sdk/logger';
import { fetchReport, fetchAvailablePeriods, fetchTransactionLog } from '../commander/client.mjs';
import { getSession, refreshSession } from '../commander/session.mjs';

const log = createLogger('shre-verifone');

const DEFAULT_INTERVAL_MS = 300_000; // 5 min
const SYNC_TIMEOUT_MS = 10 * 60 * 1000; // 10 min hard limit

const PRIMARY_REPORTS = ['summary', 'department', 'plu', 'network'];
const SECONDARY_REPORTS = [
  'hourly',
  'tax',
  'category',
  'deal',
  'carWash',
  'cashAcc',
  'networkTotals',
];

/** @type {Map<string, { timer: NodeJS.Timeout, cycleCount: number, running: boolean }>} */
const syncTimers = new Map();

/**
 * Start auto-sync for a site.
 * @param {import('pg').Pool} pool - CortexDB pool
 * @param {string} siteId
 * @param {{ ip: string, user: string, pass: string, sync_interval_ms?: number }} config
 * @param {{ onComplete?: (siteId: string) => void, log?: any }} options
 */
export function startSync(pool, siteId, config, options = {}) {
  if (syncTimers.has(siteId)) {
    stopSync(siteId);
  }

  const intervalMs = config.sync_interval_ms || DEFAULT_INTERVAL_MS;
  const log = options.log || console;

  const state = { timer: null, cycleCount: 0, running: false };

  const run = async () => {
    if (state.running) {
      log.warn?.(`Sync already running for ${siteId}, skipping`);
      return;
    }
    state.running = true;
    state.cycleCount++;

    const timeout = setTimeout(() => {
      log.error?.(`Sync timeout for ${siteId} after ${SYNC_TIMEOUT_MS}ms`);
      state.running = false;
    }, SYNC_TIMEOUT_MS);

    try {
      await runSyncCycle(pool, siteId, config, state.cycleCount, log);
      options.onComplete?.(siteId);
    } catch (err) {
      log.error?.(`Sync failed for ${siteId}`, { error: err.message });
      await updateLedger(pool, siteId, 'sync_cycle', 'failed', err.message);
    } finally {
      clearTimeout(timeout);
      state.running = false;
    }
  };

  // Run immediately, then on interval
  run();
  state.timer = setInterval(run, intervalMs);
  syncTimers.set(siteId, state);

  log.info?.(`Auto-sync started for ${siteId} (interval: ${intervalMs}ms)`);
}

/**
 * Stop auto-sync for a site.
 */
export function stopSync(siteId) {
  const state = syncTimers.get(siteId);
  if (state?.timer) clearInterval(state.timer);
  syncTimers.delete(siteId);
}

/**
 * Trigger a one-off manual sync.
 */
export async function triggerSync(pool, siteId, config, log) {
  const state = syncTimers.get(siteId);
  const cycleCount = state ? state.cycleCount + 1 : 1;
  await runSyncCycle(pool, siteId, config, cycleCount, log);
}

/**
 * Get sync status for all sites.
 */
export function getSyncStatus() {
  const result = {};
  for (const [siteId, state] of syncTimers) {
    result[siteId] = {
      running: state.running,
      cycleCount: state.cycleCount,
    };
  }
  return result;
}

// ── Core sync cycle ──────────────────────────────────────────────────

async function runSyncCycle(pool, siteId, config, cycleCount, log) {
  const startedAt = Date.now();
  log.info?.(`Sync cycle #${cycleCount} starting for ${siteId}`);

  // 1. Get session cookie
  let cookie;
  try {
    cookie = await getSession(siteId, config);
  } catch (err) {
    // Try refresh on auth failure
    cookie = await refreshSession(siteId, config);
  }

  const today = new Date().toISOString().slice(0, 10);

  // 2. Fetch priority reports (every cycle)
  for (const reptname of PRIMARY_REPORTS) {
    try {
      // Fetch day report (period=2)
      const rows = await fetchReport(config.ip, cookie, reptname, 2);
      if (rows.length) {
        await storeReportData(pool, siteId, reptname, today, 2, rows);
        await updateLedger(pool, siteId, reptname, 'done');
        log.debug?.(`${reptname} (day): ${rows.length} rows`);
      }

      // Fetch shift report (period=1)
      const shiftRows = await fetchReport(config.ip, cookie, reptname, 1);
      if (shiftRows.length) {
        await storeReportData(pool, siteId, reptname, today, 1, shiftRows);
        log.debug?.(`${reptname} (shift): ${shiftRows.length} rows`);
      }
    } catch (err) {
      log.warn?.(`Report ${reptname} failed for ${siteId}`, { error: err.message });
      await updateLedger(pool, siteId, reptname, 'failed', err.message);

      // Refresh cookie on auth failure
      if (err.message.includes('401') || err.message.includes('cookie')) {
        try {
          cookie = await refreshSession(siteId, config);
        } catch {
          /* continue with stale */
        }
      }
    }
  }

  // 3. Secondary reports every 4th cycle (~20 min at 5-min interval)
  if (cycleCount % 4 === 0) {
    for (const reptname of SECONDARY_REPORTS) {
      try {
        const rows = await fetchReport(config.ip, cookie, reptname, 2);
        if (rows.length) {
          await storeReportData(pool, siteId, reptname, today, 2, rows);
          log.debug?.(`${reptname}: ${rows.length} rows`);
        }
      } catch (err) {
        log.warn?.(`Secondary report ${reptname} failed`, { error: err.message });
      }
    }
  }

  // 4. Fetch period list and any new transaction logs
  try {
    const periods = await fetchAvailablePeriods(config.ip, cookie);
    const knownFiles = await getKnownPeriodFiles(pool, siteId);

    const newPeriods = periods.filter((p) => !knownFiles.has(p.filename));
    for (const period of newPeriods) {
      try {
        const txns = await fetchTransactionLog(
          config.ip,
          cookie,
          period.type === 'shift' ? '1' : '2',
          period.filename,
        );
        if (txns.length) {
          await storeTransactionLog(pool, siteId, period.filename, period.date, txns);
          log.debug?.(`Transaction log ${period.filename}: ${txns.length} rows`);
        }
      } catch (err) {
        log.warn?.(`Transaction log ${period.filename} failed`, { error: err.message });
      }
    }
  } catch (err) {
    log.warn?.(`Period list fetch failed for ${siteId}`, { error: err.message });
  }

  const elapsed = Date.now() - startedAt;
  log.info?.(`Sync cycle #${cycleCount} completed for ${siteId} in ${elapsed}ms`);
}

// ── DB helpers ───────────────────────────────────────────────────────

const REPORT_TABLE_MAP = {
  summary: { day: 'verifone.data_day_summary', shift: 'verifone.data_shift_summary' },
  department: 'verifone.data_department',
  plu: 'verifone.data_plu',
  hourly: 'verifone.data_hourly',
  tax: 'verifone.data_tax',
  network: 'verifone.data_network',
  networkTotals: 'verifone.data_network_totals',
  category: 'verifone.data_category',
  deal: 'verifone.data_deal',
  carWash: 'verifone.data_carwash',
  cashAcc: 'verifone.data_network', // cash accounting goes to network table
};

async function storeReportData(pool, siteId, reptname, reportDate, periodType, rows) {
  const tableConfig = REPORT_TABLE_MAP[reptname];
  if (!tableConfig) return;

  if (reptname === 'summary') {
    const table = periodType === 1 ? tableConfig.shift : tableConfig.day;
    if (periodType === 1) {
      // Shift summary
      const shiftId = `${reportDate}-shift-${Date.now()}`;
      await pool.query(
        `
        INSERT INTO ${table} (site_id, shift_id, report_date, raw_data)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (site_id, shift_id) DO UPDATE SET raw_data = EXCLUDED.raw_data, fetched_at = now()
      `,
        [siteId, shiftId, reportDate, JSON.stringify(rows)],
      );
    } else {
      // Day summary
      await pool.query(
        `
        INSERT INTO ${table} (site_id, report_date, raw_data)
        VALUES ($1, $2, $3)
        ON CONFLICT (site_id, report_date) DO UPDATE SET raw_data = EXCLUDED.raw_data, fetched_at = now()
      `,
        [siteId, reportDate, JSON.stringify(rows)],
      );
    }
  } else {
    const table = typeof tableConfig === 'string' ? tableConfig : tableConfig.day;
    await pool.query(
      `
      INSERT INTO ${table} (site_id, report_date, period_type, raw_data)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (site_id, report_date, period_type) DO UPDATE SET raw_data = EXCLUDED.raw_data, fetched_at = now()
    `,
      [siteId, reportDate, periodType, JSON.stringify(rows)],
    );
  }
}

async function storeTransactionLog(pool, siteId, periodFile, reportDate, rows) {
  await pool.query(
    `
    INSERT INTO verifone.data_transaction_log (site_id, period_file, report_date, raw_data)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (site_id, period_file) DO UPDATE SET raw_data = EXCLUDED.raw_data, fetched_at = now()
  `,
    [siteId, periodFile, reportDate || null, JSON.stringify(rows)],
  );
}

async function getKnownPeriodFiles(pool, siteId) {
  const res = await pool.query(
    `SELECT period_file FROM verifone.data_transaction_log WHERE site_id = $1`,
    [siteId],
  );
  return new Set(res.rows.map((r) => r.period_file));
}

async function updateLedger(pool, siteId, endpoint, status, error = null) {
  await pool.query(
    `
    INSERT INTO verifone.sync_ledger (site_id, endpoint, status, error, started_at, updated_at)
    VALUES ($1, $2, $3, $4, now(), now())
    ON CONFLICT (site_id, endpoint) DO UPDATE SET
      status = EXCLUDED.status,
      error = EXCLUDED.error,
      completed_at = CASE WHEN EXCLUDED.status IN ('done','failed') THEN now() ELSE verifone.sync_ledger.completed_at END,
      updated_at = now()
  `,
    [siteId, endpoint, status, error],
  );
}
