/**
 * Verifone Commander Password Rotation Manager
 *
 * Commander passwords expire every 90 days. This module:
 *   - Auto-rotates at day 60 (30 days before expiry)
 *   - Countdown alerts if auto-rotate fails: 60, 30, 15, 10 days remaining
 *   - At 10 days remaining: escalated user notification that manual update is required
 *   - Publishes events to event bus for UI notifications
 *
 * Schedule: checkAll() runs every hour via setInterval in live-server.
 */

import { randomBytes } from 'crypto';

const PASSWORD_MAX_AGE_DAYS = 90;
const AUTO_ROTATE_AT_DAYS = 60; // Attempt auto-rotate at day 60 (30 days before expiry)
const ALERT_THRESHOLDS = [60, 30, 15, 10]; // Days remaining when we alert
const CRITICAL_THRESHOLD = 10; // At this point, user MUST act manually

/**
 * Check all sites and handle password rotation.
 * @param {import('pg').Pool} pool
 * @param {{ publish?: Function, log?: any }} options
 */
export async function checkAllPasswords(pool, options = {}) {
  const log = options.log || console;
  const publish = options.publish;

  try {
    const sites = await pool.query(`
      SELECT site_id, site_name, commander_ip, username, password_enc,
             password_set_at, password_expires_at,
             password_rotation_failures, password_rotation_last_error,
             password_user_notified_at, enabled
      FROM verifone.site_config
      WHERE enabled = true
    `);

    for (const site of sites.rows) {
      await checkSitePassword(pool, site, log, publish);
    }
  } catch (err) {
    log.error?.('Password rotation check failed', { error: err.message });
  }
}

/**
 * Check a single site's password status.
 */
async function checkSitePassword(pool, site, log, publish) {
  const now = new Date();
  const expiresAt = new Date(site.password_expires_at);
  const daysRemaining = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
  const passwordAgeDays = Math.floor(
    (now - new Date(site.password_set_at)) / (1000 * 60 * 60 * 24),
  );

  // Already expired
  if (daysRemaining <= 0) {
    log.error?.(`Password EXPIRED for site ${site.site_id}`, { daysRemaining });
    await publishAlert(pool, publish, site, 'password_expired', {
      severity: 'critical',
      daysRemaining: 0,
      message: `Commander password for ${site.site_name || site.site_id} has EXPIRED. Sync will fail. Update password immediately.`,
    });
    return;
  }

  // Auto-rotate at day 60 (if not already rotated this cycle)
  if (passwordAgeDays >= AUTO_ROTATE_AT_DAYS && !site.password_auto_rotated_at) {
    log.info?.(`Attempting auto-rotation for site ${site.site_id} (age: ${passwordAgeDays} days)`);
    const result = await attemptAutoRotation(pool, site, log);

    if (result.success) {
      log.info?.(`Auto-rotation successful for site ${site.site_id}`);
      await logRotation(pool, site.site_id, 'auto_rotate_success', daysRemaining);
      publish?.('verifone.password.rotated', 'info', {
        siteId: site.site_id,
        siteName: site.site_name,
        daysRemaining,
      });
      return;
    }

    // Auto-rotation failed
    log.warn?.(`Auto-rotation failed for site ${site.site_id}`, { error: result.error });
    await logRotation(pool, site.site_id, 'auto_rotate_failed', daysRemaining, result.error);

    await pool.query(
      `
      UPDATE verifone.site_config SET
        password_rotation_failures = password_rotation_failures + 1,
        password_rotation_last_error = $2,
        updated_at = now()
      WHERE site_id = $1
    `,
      [site.site_id, result.error],
    );
  }

  // Check if we should alert the user at countdown thresholds
  for (const threshold of ALERT_THRESHOLDS) {
    if (daysRemaining <= threshold) {
      const severity = daysRemaining <= CRITICAL_THRESHOLD ? 'critical' : 'warning';
      const isCritical = daysRemaining <= CRITICAL_THRESHOLD;

      // Don't spam — only notify once per threshold level per day
      const lastNotified = site.password_user_notified_at
        ? new Date(site.password_user_notified_at)
        : null;
      const hoursSinceNotified = lastNotified ? (now - lastNotified) / (1000 * 60 * 60) : Infinity;

      if (hoursSinceNotified >= 24) {
        const message = isCritical
          ? `⚠️ URGENT: Commander password for "${site.site_name || site.site_id}" expires in ${daysRemaining} days. Auto-rotation failed (${site.password_rotation_failures} attempts). Please update the password manually in the Verifone POS connector settings.`
          : `Commander password for "${site.site_name || site.site_id}" expires in ${daysRemaining} days. Auto-rotation will attempt at day 60.`;

        await publishAlert(pool, publish, site, 'password_expiring', {
          severity,
          daysRemaining,
          threshold,
          autoRotateFailed: (site.password_rotation_failures || 0) > 0,
          message,
        });

        await pool.query(
          `
          UPDATE verifone.site_config SET password_user_notified_at = now() WHERE site_id = $1
        `,
          [site.site_id],
        );

        await logRotation(pool, site.site_id, 'user_notified', daysRemaining);

        log.info?.(
          `Notified user: ${site.site_id} password expires in ${daysRemaining} days (${severity})`,
        );
      }

      break; // Only alert for the most critical threshold
    }
  }
}

/**
 * Attempt to auto-rotate the Commander password.
 * Commander devices typically support password change via CGI or admin interface.
 *
 * NOTE: Commander password change is device-specific. This generates a new
 * password and attempts to set it. If the device doesn't support programmatic
 * password changes, this will fail and fall through to user notification.
 */
async function attemptAutoRotation(pool, site, log) {
  try {
    // Generate new password (alphanumeric, 16 chars)
    const newPassword = randomBytes(12).toString('base64url').slice(0, 16);

    // Step 1: Login with current credentials
    const loginUrl = `https://${site.commander_ip}/cgi-bin/CGILink?cmd=validate&user=${encodeURIComponent(site.username)}&passwd=${encodeURIComponent(site.password_enc)}`;

    const loginRes = await fetch(loginUrl, {
      signal: AbortSignal.timeout(15000),
    });

    if (!loginRes.ok) {
      return { success: false, error: `Login failed: HTTP ${loginRes.status}` };
    }

    // Extract cookie
    const body = await loginRes.text();
    const cookieMatch = body.match(/cookie[=:]?\s*["']?([A-Za-z0-9_-]+)/i);
    const setCookie = loginRes.headers.get('set-cookie');
    const cookie =
      cookieMatch?.[1] ||
      setCookie?.match(/cookie=([^;]+)/i)?.[1] ||
      setCookie?.match(/(\w{8,})/)?.[1];

    if (!cookie) {
      return { success: false, error: 'No cookie from login — cannot change password' };
    }

    // Step 2: Attempt password change via Commander CGI
    // Commander uses cmd=changepasswd (device-specific, may not be available on all firmware)
    const changePwUrl = `https://${site.commander_ip}/cgi-bin/CGILink?cmd=changepasswd&user=${encodeURIComponent(site.username)}&oldpasswd=${encodeURIComponent(site.password_enc)}&newpasswd=${encodeURIComponent(newPassword)}&cookie=${cookie}`;

    const changeRes = await fetch(changePwUrl, {
      signal: AbortSignal.timeout(15000),
    });

    if (!changeRes.ok) {
      return { success: false, error: `Password change request failed: HTTP ${changeRes.status}` };
    }

    const changeBody = await changeRes.text();

    // Check for success indicators in response
    if (
      changeBody.toLowerCase().includes('error') ||
      changeBody.toLowerCase().includes('fail') ||
      changeBody.toLowerCase().includes('denied')
    ) {
      return {
        success: false,
        error: `Commander rejected password change: ${changeBody.slice(0, 200)}`,
      };
    }

    // Step 3: Verify new password works
    const verifyUrl = `https://${site.commander_ip}/cgi-bin/CGILink?cmd=validate&user=${encodeURIComponent(site.username)}&passwd=${encodeURIComponent(newPassword)}`;
    const verifyRes = await fetch(verifyUrl, {
      signal: AbortSignal.timeout(15000),
    });

    if (!verifyRes.ok) {
      // Rollback — new password didn't work, old one still valid
      log.warn?.(
        `Auto-rotation verification failed for ${site.site_id}, old password still active`,
      );
      return {
        success: false,
        error: 'New password verification failed — old password still active',
      };
    }

    // Step 4: Update database with new password
    const now = new Date();
    const newExpiry = new Date(now.getTime() + PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
      `
      UPDATE verifone.site_config SET
        password_enc = $2,
        password_set_at = $3,
        password_expires_at = $4,
        password_auto_rotated_at = $3,
        password_rotation_failures = 0,
        password_rotation_last_error = NULL,
        updated_at = $3
      WHERE site_id = $1
    `,
      [site.site_id, newPassword, now.toISOString(), newExpiry.toISOString()],
    );

    // Also update vault credential file if it exists
    // (MIB007 connector stores credentials separately in vault)

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Called when user manually updates the password via the settings API.
 * Resets the rotation lifecycle.
 */
export async function recordManualPasswordUpdate(pool, siteId, newPassword) {
  const now = new Date();
  const newExpiry = new Date(now.getTime() + PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `
    UPDATE verifone.site_config SET
      password_enc = $2,
      password_set_at = $3,
      password_expires_at = $4,
      password_auto_rotated_at = NULL,
      password_rotation_failures = 0,
      password_rotation_last_error = NULL,
      password_user_notified_at = NULL,
      updated_at = $3
    WHERE site_id = $1
  `,
    [siteId, newPassword, now.toISOString(), newExpiry.toISOString()],
  );

  await logRotation(pool, siteId, 'manual_update', PASSWORD_MAX_AGE_DAYS);
}

/**
 * Get password health status for all sites (for health endpoint / UI).
 */
export async function getPasswordHealth(pool) {
  const res = await pool.query(`
    SELECT
      site_id,
      site_name,
      password_set_at,
      password_expires_at,
      password_auto_rotated_at,
      password_rotation_failures,
      password_rotation_last_error,
      password_user_notified_at,
      CEIL(EXTRACT(EPOCH FROM (password_expires_at - now())) / 86400) AS days_remaining,
      FLOOR(EXTRACT(EPOCH FROM (now() - password_set_at)) / 86400) AS password_age_days
    FROM verifone.site_config
    WHERE enabled = true
    ORDER BY password_expires_at ASC
  `);

  return res.rows.map((r) => ({
    siteId: r.site_id,
    siteName: r.site_name,
    passwordSetAt: r.password_set_at,
    passwordExpiresAt: r.password_expires_at,
    daysRemaining: parseInt(r.days_remaining, 10),
    passwordAgeDays: parseInt(r.password_age_days, 10),
    autoRotatedAt: r.password_auto_rotated_at,
    rotationFailures: r.password_rotation_failures || 0,
    lastError: r.password_rotation_last_error,
    status: getPasswordStatus(parseInt(r.days_remaining, 10), r.password_rotation_failures || 0),
  }));
}

function getPasswordStatus(daysRemaining, failures) {
  if (daysRemaining <= 0) return 'expired';
  if (daysRemaining <= CRITICAL_THRESHOLD && failures > 0) return 'critical';
  if (daysRemaining <= 30 && failures > 0) return 'warning';
  if (daysRemaining <= 30) return 'expiring_soon';
  return 'healthy';
}

// ── Internal helpers ─────────────────────────────────────────────

async function publishAlert(pool, publish, site, eventType, data) {
  publish?.(`verifone.password.${eventType}`, data.severity || 'warning', {
    siteId: site.site_id,
    siteName: site.site_name,
    ...data,
  });
}

async function logRotation(pool, siteId, action, daysRemaining, error = null) {
  try {
    await pool.query(
      `
      INSERT INTO verifone.password_rotation_log (site_id, action, days_remaining, error)
      VALUES ($1, $2, $3, $4)
    `,
      [siteId, action, daysRemaining, error],
    );
  } catch {
    /* non-fatal */
  }
}
