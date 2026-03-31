/**
 * Sync Engine (Edge Relay) — SQLite-backed
 *
 * Adapted from shre-verifone/src/live/auto-sync.mjs.
 * Same cycle logic: priority reports every cycle, secondary every 4th.
 * Uses better-sqlite3 instead of pg Pool.
 */

import { fetchReport, fetchAvailablePeriods, fetchTransactionLog } from '../commander/client.mjs';
import { getSession, refreshSession } from '../commander/session.mjs';
import { getDb } from '../config.mjs';
import { updateLedger } from './sync-ledger.mjs';
import { storeReport, storeTransactionLog, getKnownPeriodFiles } from './report-store.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('sync-engine');

const DEFAULT_INTERVAL_MS = 300_000;
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

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
 */
export function startSync(siteId, config, options = {}) {
  if (syncTimers.has(siteId)) stopSync(siteId);

  const intervalMs = config.sync_interval_ms || DEFAULT_INTERVAL_MS;
  const state = { timer: null, cycleCount: 0, running: false };

  const run = async () => {
    if (state.running) {
      log.warn(`Sync already running for ${siteId}, skipping`);
      return;
    }
    state.running = true;
    state.cycleCount++;

    const timeout = setTimeout(() => {
      log.error(`Sync timeout for ${siteId}`);
      state.running = false;
    }, SYNC_TIMEOUT_MS);

    try {
      await runSyncCycle(siteId, config, state.cycleCount);
      options.onComplete?.(siteId);
    } catch (err) {
      log.error(`Sync failed for ${siteId}`, { error: err.message });
      updateLedger(siteId, 'sync_cycle', 'failed', err.message);
    } finally {
      clearTimeout(timeout);
      state.running = false;
    }
  };

  run();
  state.timer = setInterval(run, intervalMs);
  syncTimers.set(siteId, state);

  log.info(`Auto-sync started for ${siteId} (interval: ${intervalMs}ms)`);
}

/**
 * Stop auto-sync for a site.
 */
export function stopSync(siteId) {
  const state = syncTimers.get(siteId);
  if (state?.timer) clearInterval(state.timer);
  syncTimers.delete(siteId);
  log.info(`Sync stopped for ${siteId}`);
}

/**
 * Trigger a one-off manual sync.
 */
export async function triggerSync(siteId, config) {
  const state = syncTimers.get(siteId);
  const cycleCount = state ? state.cycleCount + 1 : 1;
  await runSyncCycle(siteId, config, cycleCount);
}

/**
 * Get sync status for all sites.
 */
export function getSyncStatus() {
  const result = {};
  for (const [siteId, state] of syncTimers) {
    result[siteId] = { running: state.running, cycleCount: state.cycleCount };
  }
  return result;
}

/**
 * Stop all syncs (shutdown).
 */
export function stopAllSyncs() {
  for (const siteId of syncTimers.keys()) stopSync(siteId);
}

// ── Core sync cycle ──────────────────────────────────────────────────

async function runSyncCycle(siteId, config, cycleCount) {
  const startedAt = Date.now();
  log.info(`Sync cycle #${cycleCount} starting for ${siteId}`);

  // 1. Get session cookie
  let cookie;
  try {
    cookie = await getSession(siteId, config);
  } catch {
    cookie = await refreshSession(siteId, config);
  }

  const today = new Date().toISOString().slice(0, 10);

  // 2. Priority reports (every cycle)
  for (const reptname of PRIMARY_REPORTS) {
    try {
      const rows = await fetchReport(config.ip, cookie, reptname, 2);
      if (rows.length) {
        storeReport(siteId, reptname, today, 2, rows);
        updateLedger(siteId, reptname, 'done');
        log.debug(`${reptname} (day): ${rows.length} rows`);
      }

      const shiftRows = await fetchReport(config.ip, cookie, reptname, 1);
      if (shiftRows.length) {
        storeReport(siteId, reptname, today, 1, shiftRows);
        log.debug(`${reptname} (shift): ${shiftRows.length} rows`);
      }
    } catch (err) {
      log.warn(`Report ${reptname} failed for ${siteId}`, { error: err.message });
      updateLedger(siteId, reptname, 'failed', err.message);

      if (err.message.includes('401') || err.message.includes('cookie')) {
        try {
          cookie = await refreshSession(siteId, config);
        } catch {
          /* continue */
        }
      }
    }
  }

  // 3. Secondary reports every 4th cycle
  if (cycleCount % 4 === 0) {
    for (const reptname of SECONDARY_REPORTS) {
      try {
        const rows = await fetchReport(config.ip, cookie, reptname, 2);
        if (rows.length) {
          storeReport(siteId, reptname, today, 2, rows);
          log.debug(`${reptname}: ${rows.length} rows`);
        }
      } catch (err) {
        log.warn(`Secondary ${reptname} failed`, { error: err.message });
      }
    }
  }

  // 4. Transaction logs
  try {
    const periods = await fetchAvailablePeriods(config.ip, cookie);
    const knownFiles = getKnownPeriodFiles(siteId);

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
          storeTransactionLog(siteId, period.filename, period.date, txns);
          log.debug(`Transaction log ${period.filename}: ${txns.length} rows`);
        }
      } catch (err) {
        log.warn(`Transaction log ${period.filename} failed`, { error: err.message });
      }
    }
  } catch (err) {
    log.warn(`Period list fetch failed for ${siteId}`, { error: err.message });
  }

  const elapsed = Date.now() - startedAt;
  log.info(`Sync cycle #${cycleCount} completed for ${siteId} in ${elapsed}ms`);
  updateLedger(siteId, 'sync_cycle', 'done');
}
