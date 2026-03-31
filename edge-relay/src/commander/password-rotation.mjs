/**
 * Commander Password Rotation Manager (Edge Relay)
 *
 * Adapted from shre-verifone/src/commander/password-rotation.mjs for SQLite.
 * 90-day lifecycle: auto-rotate at day 60, countdown alerts, critical escalation.
 */

import { randomBytes } from 'crypto';
import { getDb } from '../config.mjs';
import { commanderRequest } from './client.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('password-rotation');

const PASSWORD_MAX_AGE_DAYS = 90;
const AUTO_ROTATE_AT_DAYS = 60;
const ALERT_THRESHOLDS = [60, 30, 15, 10];
const CRITICAL_THRESHOLD = 10;

/**
 * Check all sites and handle password rotation.
 * @param {{ getCredential: (siteId: string) => string | null }} vault
 * @param {{ publish?: Function }} options
 */
export async function checkAllPasswords(vault, options = {}) {
  const db = getDb();
  const publish = options.publish;

  try {
    const sites = db
      .prepare(
        `
      SELECT site_id, site_name, commander_ip, username,
             password_set_at, password_expires_at,
             password_rotation_failures, password_auto_rotated_at,
             password_user_notified_at, enabled
      FROM site_config WHERE enabled = 1
    `,
      )
      .all();

    for (const site of sites) {
      const password = vault.getCredential(site.site_id);
      await checkSitePassword(db, { ...site, password }, vault, publish);
    }
  } catch (err) {
    log.error('Password rotation check failed', { error: err.message });
  }
}

async function checkSitePassword(db, site, vault, publish) {
  const now = new Date();
  const expiresAt = new Date(site.password_expires_at);
  const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
  const passwordAgeDays = Math.floor(
    (now - new Date(site.password_set_at)) / (1000 * 60 * 60 * 24),
  );

  if (daysRemaining <= 0) {
    log.error(`Password EXPIRED for site ${site.site_id}`, { daysRemaining });
    publish?.('verifone.password.expired', 'critical', {
      siteId: site.site_id,
      siteName: site.site_name,
      daysRemaining: 0,
    });
    return;
  }

  // Auto-rotate at day 60
  if (passwordAgeDays >= AUTO_ROTATE_AT_DAYS && !site.password_auto_rotated_at) {
    log.info(`Attempting auto-rotation for ${site.site_id} (age: ${passwordAgeDays}d)`);
    const result = await attemptAutoRotation(db, site, vault);

    if (result.success) {
      log.info(`Auto-rotation successful for ${site.site_id}`);
      logRotation(db, site.site_id, 'auto_rotate_success', daysRemaining);
      publish?.('verifone.password.rotated', 'info', {
        siteId: site.site_id,
        siteName: site.site_name,
        daysRemaining,
      });
      return;
    }

    log.warn(`Auto-rotation failed for ${site.site_id}`, { error: result.error });
    logRotation(db, site.site_id, 'auto_rotate_failed', daysRemaining, result.error);

    db.prepare(
      `
      UPDATE site_config SET
        password_rotation_failures = password_rotation_failures + 1,
        updated_at = datetime('now')
      WHERE site_id = ?
    `,
    ).run(site.site_id);
  }

  // Countdown alerts
  for (const threshold of ALERT_THRESHOLDS) {
    if (daysRemaining <= threshold) {
      const severity = daysRemaining <= CRITICAL_THRESHOLD ? 'critical' : 'warning';
      const lastNotified = site.password_user_notified_at
        ? new Date(site.password_user_notified_at)
        : null;
      const hoursSinceNotified = lastNotified ? (now - lastNotified) / (1000 * 60 * 60) : Infinity;

      if (hoursSinceNotified >= 24) {
        publish?.('verifone.password.expiring', severity, {
          siteId: site.site_id,
          siteName: site.site_name,
          daysRemaining,
          threshold,
          autoRotateFailed: (site.password_rotation_failures || 0) > 0,
        });

        db.prepare(
          `UPDATE site_config SET password_user_notified_at = datetime('now') WHERE site_id = ?`,
        ).run(site.site_id);

        logRotation(db, site.site_id, 'user_notified', daysRemaining);
        log.info(`Notified: ${site.site_id} password expires in ${daysRemaining}d (${severity})`);
      }
      break;
    }
  }
}

async function attemptAutoRotation(db, site, vault) {
  try {
    const newPassword = randomBytes(12).toString('base64url').slice(0, 16);

    // Login with current creds
    const loginUrl = `https://${site.commander_ip}/cgi-bin/CGILink?cmd=validate&user=${encodeURIComponent(site.username)}&passwd=${encodeURIComponent(site.password)}`;
    const loginRes = await commanderRequest(loginUrl);
    if (!loginRes.ok) return { success: false, error: `Login failed: HTTP ${loginRes.status}` };

    const body = await loginRes.text();
    const cookieMatch = body.match(/cookie[=:]?\s*["']?([A-Za-z0-9_-]+)/i);
    const setCookie = loginRes.headers.get('set-cookie');
    const cookie =
      cookieMatch?.[1] ||
      setCookie?.match(/cookie=([^;]+)/i)?.[1] ||
      setCookie?.match(/(\w{8,})/)?.[1];

    if (!cookie) return { success: false, error: 'No cookie from login' };

    // Change password
    const changePwUrl = `https://${site.commander_ip}/cgi-bin/CGILink?cmd=changepasswd&user=${encodeURIComponent(site.username)}&oldpasswd=${encodeURIComponent(site.password)}&newpasswd=${encodeURIComponent(newPassword)}&cookie=${cookie}`;
    const changeRes = await commanderRequest(changePwUrl);
    if (!changeRes.ok)
      return { success: false, error: `Password change failed: HTTP ${changeRes.status}` };

    const changeBody = await changeRes.text();
    if (
      changeBody.toLowerCase().includes('error') ||
      changeBody.toLowerCase().includes('fail') ||
      changeBody.toLowerCase().includes('denied')
    ) {
      return { success: false, error: `Rejected: ${changeBody.slice(0, 200)}` };
    }

    // Verify new password
    const verifyUrl = `https://${site.commander_ip}/cgi-bin/CGILink?cmd=validate&user=${encodeURIComponent(site.username)}&passwd=${encodeURIComponent(newPassword)}`;
    const verifyRes = await commanderRequest(verifyUrl);
    if (!verifyRes.ok) return { success: false, error: 'New password verification failed' };

    // Update DB + vault
    const now = new Date().toISOString();
    const newExpiry = new Date(Date.now() + PASSWORD_MAX_AGE_DAYS * 86400000).toISOString();

    db.prepare(
      `
      UPDATE site_config SET
        password_set_at = ?, password_expires_at = ?,
        password_auto_rotated_at = ?,
        password_rotation_failures = 0,
        updated_at = ?
      WHERE site_id = ?
    `,
    ).run(now, newExpiry, now, now, site.site_id);

    vault.setCredential(site.site_id, newPassword);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Record manual password update.
 */
export function recordManualPasswordUpdate(db, siteId, newPassword, vault) {
  const now = new Date().toISOString();
  const newExpiry = new Date(Date.now() + PASSWORD_MAX_AGE_DAYS * 86400000).toISOString();

  db.prepare(
    `
    UPDATE site_config SET
      password_set_at = ?, password_expires_at = ?,
      password_auto_rotated_at = NULL,
      password_rotation_failures = 0,
      password_user_notified_at = NULL,
      updated_at = ?
    WHERE site_id = ?
  `,
  ).run(now, newExpiry, now, siteId);

  vault.setCredential(siteId, newPassword);
  logRotation(db, siteId, 'manual_update', PASSWORD_MAX_AGE_DAYS);
}

/**
 * Get password health for all sites.
 */
export function getPasswordHealth(db) {
  const sites = db
    .prepare(
      `
    SELECT site_id, site_name, password_set_at, password_expires_at,
           password_auto_rotated_at, password_rotation_failures
    FROM site_config WHERE enabled = 1
    ORDER BY password_expires_at ASC
  `,
    )
    .all();

  const now = Date.now();
  return sites.map((s) => {
    const daysRemaining = Math.ceil((new Date(s.password_expires_at) - now) / 86400000);
    const passwordAgeDays = Math.floor((now - new Date(s.password_set_at)) / 86400000);
    return {
      siteId: s.site_id,
      siteName: s.site_name,
      passwordSetAt: s.password_set_at,
      passwordExpiresAt: s.password_expires_at,
      daysRemaining,
      passwordAgeDays,
      autoRotatedAt: s.password_auto_rotated_at,
      rotationFailures: s.password_rotation_failures || 0,
      status: getPasswordStatus(daysRemaining, s.password_rotation_failures || 0),
    };
  });
}

function getPasswordStatus(daysRemaining, failures) {
  if (daysRemaining <= 0) return 'expired';
  if (daysRemaining <= CRITICAL_THRESHOLD && failures > 0) return 'critical';
  if (daysRemaining <= 30 && failures > 0) return 'warning';
  if (daysRemaining <= 30) return 'expiring_soon';
  return 'healthy';
}

function logRotation(db, siteId, action, daysRemaining, error = null) {
  try {
    db.prepare(
      `
      INSERT INTO password_rotation_log (site_id, action, days_remaining, error)
      VALUES (?, ?, ?, ?)
    `,
    ).run(siteId, action, daysRemaining, error);
  } catch {
    /* non-fatal */
  }
}
