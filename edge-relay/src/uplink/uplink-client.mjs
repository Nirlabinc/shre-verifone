/**
 * Uplink Client — HTTPS POST to Shre AI cloud
 *
 * Handles all relay → cloud communication with retry and offline buffering.
 */

import { getCloudUrl, getRelayId, getApiKey, getDb, DEFAULTS } from '../config.mjs';
import { enqueuePayload, dequeueAndSend } from './offline-buffer.mjs';
import { getUnuploadedReports, getUnuploadedTransactions, markReportsUploaded, markTransactionsUploaded } from '../sync/report-store.mjs';
import { buildHeartbeatPayload } from '../heartbeat.mjs';
import { classifyReports } from './data-tiering.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('uplink');
const REQUEST_TIMEOUT_MS = 30_000;

const timers = [];

/**
 * Send data to cloud endpoint.
 */
async function cloudPost(path, body) {
  const cloudUrl = getCloudUrl();
  const apiKey = getApiKey();
  const relayId = getRelayId();

  if (!apiKey || !relayId) {
    log.warn('Not registered — buffering payload');
    return null;
  }

  const url = `${cloudUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Relay-Id': relayId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Cloud ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }

    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Register this relay with the cloud. Returns relayId + apiKey.
 */
export async function registerRelay(email, password, machineId) {
  const cloudUrl = getCloudUrl();
  const res = await fetch(`${cloudUrl}/v1/edge/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password, machineId,
      os: process.platform,
      arch: process.arch,
      version: process.env.RELAY_VERSION || '1.0.0',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Registration failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  return await res.json();
}

/**
 * Authenticate relay credentials (setup step 1).
 */
export async function authenticateRelay(email, password) {
  const cloudUrl = getCloudUrl();
  const res = await fetch(`${cloudUrl}/v1/edge/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Auth failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  return await res.json();
}

/**
 * Send heartbeat to cloud.
 */
async function uplinkHeartbeat() {
  try {
    const payload = buildHeartbeatPayload();
    await cloudPost('/v1/uplink/heartbeat', payload);
    log.debug('Heartbeat sent');
  } catch (err) {
    log.warn('Heartbeat failed', { error: err.message });
    enqueuePayload('heartbeat', buildHeartbeatPayload());
  }
}

/**
 * Send metrics (Tier 1 data) to cloud.
 */
async function uplinkMetrics() {
  try {
    const reports = getUnuploadedReports(100);
    const { tier1 } = classifyReports(reports);
    if (!tier1.length) return;

    await cloudPost('/v1/uplink/metrics', { reports: tier1.map(r => ({
      siteId: r.site_id, reportType: r.report_type,
      reportDate: r.report_date, periodType: r.period_type,
      data: JSON.parse(r.raw_data), fetchedAt: r.fetched_at,
    }))});

    markReportsUploaded(tier1.map(r => r.id));
    log.info(`Metrics uploaded: ${tier1.length} reports`);
  } catch (err) {
    log.warn('Metrics upload failed', { error: err.message });
  }
}

/**
 * Send training data (Tier 2) to cloud.
 */
async function uplinkTraining() {
  try {
    const reports = getUnuploadedReports(100);
    const { tier2 } = classifyReports(reports);
    if (!tier2.length) return;

    await cloudPost('/v1/uplink/training', { reports: tier2.map(r => ({
      siteId: r.site_id, reportType: r.report_type,
      reportDate: r.report_date, periodType: r.period_type,
      data: JSON.parse(r.raw_data), fetchedAt: r.fetched_at,
    }))});

    markReportsUploaded(tier2.map(r => r.id));
    log.info(`Training data uploaded: ${tier2.length} reports`);
  } catch (err) {
    log.warn('Training upload failed', { error: err.message });
  }
}

/**
 * Send transaction data (Tier 3, opt-in) to cloud.
 */
async function uplinkTransactions() {
  try {
    const txns = getUnuploadedTransactions(50);
    if (!txns.length) return;

    await cloudPost('/v1/uplink/transactions', { transactions: txns.map(t => ({
      siteId: t.site_id, periodFile: t.period_file,
      reportDate: t.report_date, data: JSON.parse(t.raw_data), fetchedAt: t.fetched_at,
    }))});

    markTransactionsUploaded(txns.map(t => t.id));
    log.info(`Transactions uploaded: ${txns.length}`);
  } catch (err) {
    log.warn('Transaction upload failed', { error: err.message });
  }
}

/**
 * Send SecretService activity digest to cloud.
 */
async function uplinkActivity() {
  try {
    const db = getDb();
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const anomalies = db.prepare(`
      SELECT * FROM anomaly_events WHERE ts > ? AND acknowledged = 0
    `).all(oneHourAgo);

    const activityCount = db.prepare(`
      SELECT direction, COUNT(*) as count FROM activity_log WHERE ts > ? GROUP BY direction
    `).all(oneHourAgo);

    if (!anomalies.length && !activityCount.length) return;

    await cloudPost('/v1/uplink/activity', { anomalies, activitySummary: activityCount });
    log.debug('Activity digest sent');

    // Acknowledge uploaded anomalies
    if (anomalies.length) {
      const ids = anomalies.map(a => a.id);
      const stmt = db.prepare('UPDATE anomaly_events SET acknowledged = 1 WHERE id = ?');
      const tx = db.transaction((ids) => { for (const id of ids) stmt.run(id); });
      tx(ids);
    }
  } catch (err) {
    log.warn('Activity upload failed', { error: err.message });
  }
}

/**
 * Start all uplink intervals.
 * @param {number} dataTier - 1, 2, or 3
 */
export function startUplink(dataTier = 2) {
  timers.push(setInterval(uplinkHeartbeat, DEFAULTS.UPLINK_HEARTBEAT_MS));
  timers.push(setInterval(uplinkMetrics, DEFAULTS.UPLINK_METRICS_MS));
  timers.push(setInterval(uplinkActivity, DEFAULTS.UPLINK_ACTIVITY_MS));

  if (dataTier >= 2) {
    timers.push(setInterval(uplinkTraining, DEFAULTS.UPLINK_TRAINING_MS));
  }
  if (dataTier >= 3) {
    timers.push(setInterval(uplinkTransactions, DEFAULTS.UPLINK_TRANSACTIONS_MS));
  }

  // Replay any buffered payloads
  setInterval(() => dequeueAndSend(cloudPost), 60_000);

  // Initial heartbeat
  uplinkHeartbeat();

  log.info(`Uplink started (tier ${dataTier})`);
}

export function stopUplink() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

export { cloudPost };
