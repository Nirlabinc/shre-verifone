/**
 * SecretService Activity Logger
 *
 * Full req/res logging to SQLite. Redacts passwords in URLs.
 */

import { getDb } from '../config.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('secretservice');

/**
 * Log an activity (outbound LAN, outbound cloud, inbound admin).
 */
export function logActivity(entry) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO activity_log (direction, target, method, path, status, duration_ms,
                                 request_size, response_size, error, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.direction,
      redactUrl(entry.target),
      entry.method || null,
      redactUrl(entry.path),
      entry.status || null,
      entry.durationMs || null,
      entry.requestSize || null,
      entry.responseSize || null,
      entry.error || null,
      entry.sessionId || null,
    );
  } catch (err) {
    log.warn('Activity log write failed', { error: err.message });
  }
}

/**
 * Get recent activity log entries.
 * @param {{ limit?: number, direction?: string, since?: string }} options
 */
export function getActivityLog(options = {}) {
  const db = getDb();
  const { limit = 100, direction, since } = options;

  let sql = 'SELECT * FROM activity_log WHERE 1=1';
  const params = [];

  if (direction) {
    sql += ' AND direction = ?';
    params.push(direction);
  }
  if (since) {
    sql += ' AND ts > ?';
    params.push(since);
  }

  sql += ' ORDER BY ts DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get activity summary (counts by direction).
 * @param {string} since - ISO datetime
 */
export function getActivitySummary(since) {
  const db = getDb();
  return db.prepare(`
    SELECT direction, COUNT(*) as count,
           AVG(duration_ms) as avg_duration_ms,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as error_count
    FROM activity_log WHERE ts > ?
    GROUP BY direction
  `).all(since || new Date(Date.now() - 3600000).toISOString());
}

/**
 * Wrap fetch to auto-log Commander requests.
 */
export function createTrackedFetch(direction) {
  return async function trackedFetch(url, options = {}) {
    const start = Date.now();
    let status = null;
    let responseSize = null;
    let error = null;

    try {
      const res = await fetch(url, options);
      status = res.status;
      const body = await res.clone().text();
      responseSize = body.length;
      return res;
    } catch (err) {
      error = err.message;
      throw err;
    } finally {
      logActivity({
        direction,
        target: new URL(url).hostname,
        method: options.method || 'GET',
        path: redactUrl(new URL(url).pathname + new URL(url).search),
        status,
        durationMs: Date.now() - start,
        requestSize: options.body?.length || 0,
        responseSize,
        error,
      });
    }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function redactUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url
    .replace(/passwd=[^&]*/gi, 'passwd=[REDACTED]')
    .replace(/password=[^&]*/gi, 'password=[REDACTED]')
    .replace(/newpasswd=[^&]*/gi, 'newpasswd=[REDACTED]')
    .replace(/oldpasswd=[^&]*/gi, 'oldpasswd=[REDACTED]')
    .replace(/api[_-]?key=[^&]*/gi, 'api_key=[REDACTED]');
}
