/**
 * Sync Ledger — SQLite-backed sync status tracking
 */

import { getDb } from '../config.mjs';

/**
 * Update sync ledger entry.
 */
export function updateLedger(siteId, endpoint, status, error = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO sync_ledger (site_id, endpoint, status, error, started_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT (site_id, endpoint) DO UPDATE SET
      status = excluded.status,
      error = excluded.error,
      completed_at = CASE WHEN excluded.status IN ('done', 'failed') THEN datetime('now') ELSE sync_ledger.completed_at END,
      updated_at = datetime('now')
  `).run(siteId, endpoint, status, error);
}

/**
 * Get ledger entries for a site.
 */
export function getLedger(siteId) {
  const db = getDb();
  return db.prepare('SELECT * FROM sync_ledger WHERE site_id = ? ORDER BY updated_at DESC').all(siteId);
}

/**
 * Get all ledger entries.
 */
export function getAllLedger() {
  const db = getDb();
  return db.prepare('SELECT * FROM sync_ledger ORDER BY updated_at DESC').all();
}
