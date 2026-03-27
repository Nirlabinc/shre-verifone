/**
 * Audit Chain — HMAC-chained tamper-proof audit log
 *
 * Pattern from shre-secrets/src/audit.ts.
 * Each entry includes HMAC of previous entry for chain verification.
 */

import { createHmac, randomBytes } from 'crypto';
import { getDb, getConfig, setConfig } from '../config.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('audit-chain');

/**
 * Get or create the HMAC secret (stored in relay_config).
 */
function getHmacSecret() {
  let secret = getConfig('audit_hmac_secret');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    setConfig('audit_hmac_secret', secret);
  }
  return secret;
}

/**
 * Compute HMAC for an audit entry.
 */
function computeHmac(eventType, actor, detail, prevHmac) {
  const secret = getHmacSecret();
  const data = `${eventType}|${actor || ''}|${detail || ''}|${prevHmac || ''}`;
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Append an audit event to the chain.
 */
export function auditLog(eventType, actor, detail) {
  const db = getDb();

  // Get previous entry's HMAC
  const prev = db.prepare('SELECT hmac FROM audit_chain ORDER BY id DESC LIMIT 1').get();
  const prevHmac = prev?.hmac || null;

  const hmac = computeHmac(eventType, actor, typeof detail === 'object' ? JSON.stringify(detail) : detail, prevHmac);
  const detailStr = typeof detail === 'object' ? JSON.stringify(detail) : (detail || null);

  db.prepare(`
    INSERT INTO audit_chain (event_type, actor, detail, prev_hmac, hmac)
    VALUES (?, ?, ?, ?, ?)
  `).run(eventType, actor || null, detailStr, prevHmac, hmac);
}

/**
 * Verify the entire audit chain integrity.
 * @returns {{ valid: boolean, entries: number, brokenAt?: number }}
 */
export function verifyChain() {
  const db = getDb();
  const entries = db.prepare('SELECT * FROM audit_chain ORDER BY id ASC').all();

  if (!entries.length) return { valid: true, entries: 0 };

  let prevHmac = null;
  for (const entry of entries) {
    const expected = computeHmac(entry.event_type, entry.actor, entry.detail, prevHmac);

    if (entry.hmac !== expected) {
      log.error('Audit chain broken', { id: entry.id, expected, actual: entry.hmac });
      return { valid: false, entries: entries.length, brokenAt: entry.id };
    }

    if (entry.prev_hmac !== prevHmac) {
      log.error('Audit chain prev_hmac mismatch', { id: entry.id });
      return { valid: false, entries: entries.length, brokenAt: entry.id };
    }

    prevHmac = entry.hmac;
  }

  return { valid: true, entries: entries.length };
}

/**
 * Get recent audit entries.
 */
export function getAuditLog(limit = 100) {
  const db = getDb();
  return db.prepare('SELECT * FROM audit_chain ORDER BY ts DESC LIMIT ?').all(limit);
}

/**
 * Get audit chain stats.
 */
export function getAuditStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM audit_chain').get().c;
  const oldest = db.prepare('SELECT MIN(ts) as ts FROM audit_chain').get()?.ts;
  const newest = db.prepare('SELECT MAX(ts) as ts FROM audit_chain').get()?.ts;
  return { total, oldest, newest };
}
