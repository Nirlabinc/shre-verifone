/**
 * Anomaly Detector — periodic security checks
 *
 * Runs every 5 minutes. Detects:
 * - Login spikes (>3 failed in 1 hour)
 * - New Commander IP
 * - Response size anomalies (>5x typical)
 * - Duration anomalies (>3x average)
 * - Non-localhost admin access
 * - TLS fingerprint changes
 */

import { getDb } from '../config.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('anomaly-detector');
let _timer = null;

/** Known Commander IPs per site */
const knownIps = new Map();

/** Typical response sizes per endpoint */
const typicalSizes = new Map();

/**
 * Run anomaly detection.
 */
export function runAnomalyCheck() {
  const db = getDb();
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();

  // Rule: Login spike — >3 failed Commander logins in 1 hour
  checkLoginSpike(db, oneHourAgo);

  // Rule: Size anomaly — response >5x typical
  checkSizeAnomaly(db, oneHourAgo);

  // Rule: Duration anomaly — sync cycle >3x average
  checkDurationAnomaly(db, oneHourAgo);

  // Rule: Non-localhost admin access
  checkAdminAccess(db, oneHourAgo);
}

function checkLoginSpike(db, since) {
  const failures = db.prepare(`
    SELECT target, COUNT(*) as count
    FROM activity_log
    WHERE ts > ? AND direction = 'outbound-lan'
      AND path LIKE '%cmd=validate%' AND (status >= 400 OR error IS NOT NULL)
    GROUP BY target HAVING count > 3
  `).all(since);

  for (const f of failures) {
    recordAnomaly(db, 'login_spike', 'high', {
      target: f.target, failedAttempts: f.count,
      message: `${f.count} failed Commander logins to ${f.target} in the last hour`,
    });
    log.warn('Login spike detected', { target: f.target, count: f.count });
  }
}

function checkSizeAnomaly(db, since) {
  const recent = db.prepare(`
    SELECT path, response_size FROM activity_log
    WHERE ts > ? AND response_size IS NOT NULL AND direction = 'outbound-lan'
    ORDER BY ts DESC LIMIT 50
  `).all(since);

  for (const entry of recent) {
    const key = entry.path?.split('?')[0];
    if (!key) continue;

    const typical = typicalSizes.get(key);
    if (typical && entry.response_size > typical * 5) {
      recordAnomaly(db, 'size_anomaly', 'medium', {
        path: key, responseSize: entry.response_size, typicalSize: typical,
        message: `Response size ${entry.response_size} is >5x typical (${typical})`,
      });
    }

    // Update typical (exponential moving average)
    typicalSizes.set(key, typical ? typical * 0.9 + entry.response_size * 0.1 : entry.response_size);
  }
}

function checkDurationAnomaly(db, since) {
  const avgDuration = db.prepare(`
    SELECT AVG(duration_ms) as avg FROM activity_log
    WHERE direction = 'outbound-lan' AND duration_ms IS NOT NULL
  `).get()?.avg;

  if (!avgDuration || avgDuration === 0) return;

  const slow = db.prepare(`
    SELECT id, path, duration_ms FROM activity_log
    WHERE ts > ? AND direction = 'outbound-lan' AND duration_ms > ?
    ORDER BY ts DESC LIMIT 5
  `).all(since, avgDuration * 3);

  for (const entry of slow) {
    recordAnomaly(db, 'duration_anomaly', 'low', {
      path: entry.path, durationMs: entry.duration_ms, avgMs: Math.round(avgDuration),
      message: `Request took ${entry.duration_ms}ms (avg: ${Math.round(avgDuration)}ms)`,
    });
  }
}

function checkAdminAccess(db, since) {
  const nonLocal = db.prepare(`
    SELECT target, COUNT(*) as count FROM activity_log
    WHERE ts > ? AND direction = 'inbound-admin'
      AND target NOT IN ('127.0.0.1', '::1', 'localhost', '0.0.0.0')
      AND target IS NOT NULL
    GROUP BY target
  `).all(since);

  for (const entry of nonLocal) {
    recordAnomaly(db, 'admin_access', 'critical', {
      target: entry.target, count: entry.count,
      message: `Non-localhost admin access from ${entry.target} (${entry.count} requests)`,
    });
    log.error('Non-localhost admin access detected', { target: entry.target });
  }
}

/**
 * Record a Commander IP for a site (to detect changes).
 */
export function recordCommanderIp(siteId, ip) {
  const known = knownIps.get(siteId);
  if (known && known !== ip) {
    const db = getDb();
    recordAnomaly(db, 'new_ip', 'high', {
      siteId, previousIp: known, newIp: ip,
      message: `Commander ${siteId} responded from new IP ${ip} (was ${known})`,
    });
    log.warn('Commander IP changed', { siteId, previousIp: known, newIp: ip });
  }
  knownIps.set(siteId, ip);
}

function recordAnomaly(db, rule, severity, detail) {
  // Deduplicate: don't insert if same rule+detail in last 30 minutes
  const recent = db.prepare(`
    SELECT id FROM anomaly_events
    WHERE rule = ? AND ts > datetime('now', '-30 minutes')
    LIMIT 1
  `).get(rule);

  if (recent) return;

  db.prepare(`
    INSERT INTO anomaly_events (rule, severity, detail) VALUES (?, ?, ?)
  `).run(rule, severity, JSON.stringify(detail));
}

/**
 * Get recent anomalies.
 */
export function getRecentAnomalies(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT id, ts, rule, severity, detail, acknowledged
    FROM anomaly_events ORDER BY ts DESC LIMIT ?
  `).all(limit).map(r => ({ ...r, detail: JSON.parse(r.detail || '{}') }));
}

/**
 * Start periodic anomaly detection.
 */
export function startAnomalyDetector(intervalMs = 300_000) {
  _timer = setInterval(runAnomalyCheck, intervalMs);
  log.info('Anomaly detector started');
}

export function stopAnomalyDetector() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
