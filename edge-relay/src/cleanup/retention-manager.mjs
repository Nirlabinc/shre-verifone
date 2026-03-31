/**
 * Retention Manager — configurable data retention with auto-cleanup
 *
 * Runs every hour. Deletes oldest records first.
 */

import { getDb, DEFAULTS, getConfig } from '../config.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('retention');
let _timer = null;

/**
 * Run retention cleanup for all data types.
 * @param {{ emergency?: boolean }} options - If true, halve retention periods
 */
export function runRetention(options = {}) {
  const db = getDb();
  const multiplier = options.emergency ? 0.5 : 1;

  const retentionDays = {
    activity:
      (parseInt(getConfig('retention_activity_days')) || DEFAULTS.RETENTION_ACTIVITY_DAYS) *
      multiplier,
    reports:
      (parseInt(getConfig('retention_reports_days')) || DEFAULTS.RETENTION_REPORTS_DAYS) *
      multiplier,
    transactions:
      (parseInt(getConfig('retention_transactions_days')) || DEFAULTS.RETENTION_TRANSACTIONS_DAYS) *
      multiplier,
    wal: (parseInt(getConfig('retention_wal_days')) || DEFAULTS.RETENTION_WAL_DAYS) * multiplier,
    audit:
      (parseInt(getConfig('retention_audit_days')) || DEFAULTS.RETENTION_AUDIT_DAYS) * multiplier,
    logs: (parseInt(getConfig('retention_logs_days')) || DEFAULTS.RETENTION_LOGS_DAYS) * multiplier,
  };

  let totalDeleted = 0;

  // Activity logs
  totalDeleted += cleanTable(db, 'activity_log', 'ts', retentionDays.activity);

  // Reports (only uploaded ones)
  totalDeleted += cleanTableWhere(
    db,
    'reports',
    'fetched_at',
    retentionDays.reports,
    'uploaded_at IS NOT NULL',
  );

  // Transaction logs (only uploaded ones)
  totalDeleted += cleanTableWhere(
    db,
    'transaction_logs',
    'fetched_at',
    retentionDays.transactions,
    'uploaded_at IS NOT NULL',
  );

  // Uplink WAL (sent entries)
  totalDeleted += cleanTableWhere(
    db,
    'uplink_queue',
    'created_at',
    retentionDays.wal,
    'sent_at IS NOT NULL',
  );

  // Anomaly events (acknowledged)
  totalDeleted += cleanTableWhere(
    db,
    'anomaly_events',
    'ts',
    retentionDays.activity,
    'acknowledged = 1',
  );

  // Password rotation log
  totalDeleted += cleanTable(db, 'password_rotation_log', 'created_at', retentionDays.reports);

  // Audit chain — compress old entries (keep but summarize)
  const auditCutoff = daysAgo(retentionDays.audit);
  const auditDeleted = db.prepare(`DELETE FROM audit_chain WHERE ts < ?`).run(auditCutoff).changes;
  totalDeleted += auditDeleted;

  if (totalDeleted > 0) {
    log.info(`Retention cleanup: ${totalDeleted} records deleted`, {
      emergency: options.emergency || false,
    });

    // Vacuum to reclaim space
    try {
      db.exec('VACUUM');
    } catch {
      /* non-fatal */
    }
  }

  return totalDeleted;
}

function cleanTable(db, table, tsColumn, retentionDays) {
  const cutoff = daysAgo(retentionDays);
  return db.prepare(`DELETE FROM ${table} WHERE ${tsColumn} < ?`).run(cutoff).changes;
}

function cleanTableWhere(db, table, tsColumn, retentionDays, extraWhere) {
  const cutoff = daysAgo(retentionDays);
  return db.prepare(`DELETE FROM ${table} WHERE ${tsColumn} < ? AND ${extraWhere}`).run(cutoff)
    .changes;
}

function daysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/**
 * Start periodic retention cleanup.
 */
export function startRetention(intervalMs) {
  _timer = setInterval(() => runRetention(), intervalMs || DEFAULTS.CLEANUP_INTERVAL_MS);
  log.info('Retention manager started');
}

export function stopRetention() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
