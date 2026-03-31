/**
 * Edge Relay Heartbeat
 *
 * Local service health + cloud heartbeat reporting.
 * Adapted from shre-sdk/heartbeat pattern for standalone operation.
 */

import { getDb } from './config.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('heartbeat');
const startedAt = Date.now();

/** @type {{ timer: NodeJS.Timeout | null, lastBeat: number, status: string }} */
const state = { timer: null, lastBeat: 0, status: 'starting' };

/**
 * Get local health snapshot.
 */
export function getHealthSnapshot() {
  const db = getDb();

  const siteCount = db.prepare('SELECT COUNT(*) as c FROM site_config WHERE enabled = 1').get().c;
  const queueSize = db
    .prepare('SELECT COUNT(*) as c FROM uplink_queue WHERE sent_at IS NULL')
    .get().c;
  const lastActivity = db.prepare('SELECT MAX(ts) as ts FROM activity_log').get()?.ts;

  return {
    status: state.status,
    uptimeMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    lastHeartbeat: state.lastBeat ? new Date(state.lastBeat).toISOString() : null,
    sites: siteCount,
    uplinkQueue: queueSize,
    lastActivity,
  };
}

/**
 * Build heartbeat payload for cloud uplink.
 */
export function buildHeartbeatPayload() {
  const health = getHealthSnapshot();

  let diskFree = null;
  try {
    // Cross-platform disk check handled by disk-monitor
    diskFree = global.__diskFreeMB || null;
  } catch {
    /* ignore */
  }

  return {
    version: process.env.RELAY_VERSION || '1.0.0',
    uptime: health.uptimeMs,
    status: health.status,
    sites: health.sites,
    uplinkQueue: health.uplinkQueue,
    diskFreeMB: diskFree,
    lastSync: health.lastActivity,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  };
}

/**
 * Start local heartbeat interval.
 * @param {number} intervalMs
 */
export function startHeartbeat(intervalMs = 60_000) {
  state.status = 'healthy';
  state.timer = setInterval(() => {
    state.lastBeat = Date.now();
    log.debug('heartbeat', getHealthSnapshot());
  }, intervalMs);
  log.info('Heartbeat started');
}

export function stopHeartbeat() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.status = 'stopped';
}

export function setStatus(status) {
  state.status = status;
}
