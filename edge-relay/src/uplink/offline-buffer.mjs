/**
 * Offline Buffer — WAL file buffer for offline periods
 *
 * When cloud is unreachable, payloads go to uplink_queue in SQLite.
 * Replay with exponential backoff on reconnection.
 */

import { getDb } from '../config.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('offline-buffer');

const MAX_ATTEMPTS = 10;
const WAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 1_800_000]; // 30s, 1m, 5m, 15m, 30m

/**
 * Enqueue a payload for later delivery.
 */
export function enqueuePayload(payloadType, payload) {
  const db = getDb();
  db.prepare(`
    INSERT INTO uplink_queue (payload_type, payload) VALUES (?, ?)
  `).run(payloadType, JSON.stringify(payload));
  log.debug('Payload buffered', { type: payloadType });
}

/**
 * Dequeue and send buffered payloads (FIFO).
 * @param {(path: string, body: any) => Promise<any>} sendFn - Cloud POST function
 */
export async function dequeueAndSend(sendFn) {
  const db = getDb();

  // Clean expired entries
  const cutoff = new Date(Date.now() - WAL_RETENTION_MS).toISOString();
  db.prepare('DELETE FROM uplink_queue WHERE created_at < ? AND sent_at IS NULL').run(cutoff);

  // Get pending payloads
  const pending = db.prepare(`
    SELECT id, payload_type, payload, attempts, created_at
    FROM uplink_queue WHERE sent_at IS NULL AND attempts < ?
    ORDER BY created_at ASC LIMIT 20
  `).all(MAX_ATTEMPTS);

  if (!pending.length) return;

  const PATH_MAP = {
    heartbeat: '/v1/uplink/heartbeat',
    metrics: '/v1/uplink/metrics',
    training: '/v1/uplink/training',
    transactions: '/v1/uplink/transactions',
    activity: '/v1/uplink/activity',
  };

  for (const item of pending) {
    const path = PATH_MAP[item.payload_type];
    if (!path) {
      db.prepare('UPDATE uplink_queue SET sent_at = datetime(\'now\') WHERE id = ?').run(item.id);
      continue;
    }

    // Check backoff
    const backoffIdx = Math.min(item.attempts, BACKOFF_MS.length - 1);
    const backoffMs = BACKOFF_MS[backoffIdx];
    const nextAttemptAt = new Date(item.created_at).getTime() + (backoffMs * item.attempts);
    if (Date.now() < nextAttemptAt && item.attempts > 0) continue;

    try {
      await sendFn(path, JSON.parse(item.payload));
      db.prepare('UPDATE uplink_queue SET sent_at = datetime(\'now\') WHERE id = ?').run(item.id);
      log.debug('Buffered payload sent', { type: item.payload_type, id: item.id });
    } catch (err) {
      db.prepare('UPDATE uplink_queue SET attempts = attempts + 1 WHERE id = ?').run(item.id);
      log.debug('Replay failed', { type: item.payload_type, attempts: item.attempts + 1, error: err.message });
      break; // Stop replaying on first failure (cloud likely down)
    }
  }
}

/**
 * Get queue stats for health check.
 */
export function getQueueStats() {
  const db = getDb();
  const pending = db.prepare('SELECT COUNT(*) as c FROM uplink_queue WHERE sent_at IS NULL').get().c;
  const oldest = db.prepare('SELECT MIN(created_at) as ts FROM uplink_queue WHERE sent_at IS NULL').get()?.ts;
  const totalSent = db.prepare('SELECT COUNT(*) as c FROM uplink_queue WHERE sent_at IS NOT NULL').get().c;
  return { pending, oldest, totalSent };
}
