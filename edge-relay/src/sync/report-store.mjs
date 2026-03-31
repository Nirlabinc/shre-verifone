/**
 * Report Store — SQLite-backed report and transaction storage
 */

import { getDb } from '../config.mjs';

/**
 * Store a Commander report (upsert).
 */
export function storeReport(siteId, reportType, reportDate, periodType, rows) {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO reports (site_id, report_type, report_date, period_type, raw_data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site_id, report_type, report_date, period_type) DO UPDATE SET
      raw_data = excluded.raw_data,
      fetched_at = datetime('now'),
      uploaded_at = NULL
  `,
  ).run(siteId, reportType, reportDate, periodType, JSON.stringify(rows));
}

/**
 * Store transaction log (upsert).
 */
export function storeTransactionLog(siteId, periodFile, reportDate, rows) {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO transaction_logs (site_id, period_file, report_date, raw_data)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(site_id, period_file) DO UPDATE SET
      raw_data = excluded.raw_data,
      fetched_at = datetime('now'),
      uploaded_at = NULL
  `,
  ).run(siteId, periodFile, reportDate || null, JSON.stringify(rows));
}

/**
 * Get known period files for a site (for diff against available periods).
 */
export function getKnownPeriodFiles(siteId) {
  const db = getDb();
  const rows = db.prepare('SELECT period_file FROM transaction_logs WHERE site_id = ?').all(siteId);
  return new Set(rows.map((r) => r.period_file));
}

/**
 * Get reports not yet uploaded (for uplink).
 * @param {number} limit
 */
export function getUnuploadedReports(limit = 100) {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT id, site_id, report_type, report_date, period_type, raw_data, fetched_at
    FROM reports WHERE uploaded_at IS NULL
    ORDER BY fetched_at ASC LIMIT ?
  `,
    )
    .all(limit);
}

/**
 * Get transaction logs not yet uploaded.
 */
export function getUnuploadedTransactions(limit = 50) {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT id, site_id, period_file, report_date, raw_data, fetched_at
    FROM transaction_logs WHERE uploaded_at IS NULL
    ORDER BY fetched_at ASC LIMIT ?
  `,
    )
    .all(limit);
}

/**
 * Mark reports as uploaded.
 * @param {number[]} ids
 */
export function markReportsUploaded(ids) {
  if (!ids.length) return;
  const db = getDb();
  const stmt = db.prepare("UPDATE reports SET uploaded_at = datetime('now') WHERE id = ?");
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(id);
  });
  tx(ids);
}

/**
 * Mark transaction logs as uploaded.
 * @param {number[]} ids
 */
export function markTransactionsUploaded(ids) {
  if (!ids.length) return;
  const db = getDb();
  const stmt = db.prepare("UPDATE transaction_logs SET uploaded_at = datetime('now') WHERE id = ?");
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(id);
  });
  tx(ids);
}

/**
 * Get report counts by upload status (for health check).
 */
export function getReportStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM reports').get().c;
  const pending = db.prepare('SELECT COUNT(*) as c FROM reports WHERE uploaded_at IS NULL').get().c;
  const txTotal = db.prepare('SELECT COUNT(*) as c FROM transaction_logs').get().c;
  const txPending = db
    .prepare('SELECT COUNT(*) as c FROM transaction_logs WHERE uploaded_at IS NULL')
    .get().c;
  return { reports: { total, pending }, transactions: { total: txTotal, pending: txPending } };
}
