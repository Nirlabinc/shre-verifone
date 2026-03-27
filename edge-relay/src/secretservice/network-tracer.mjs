/**
 * Network Tracer — HTTP timing, session lifecycle, latency trends
 */

import { createLogger } from '../logger.mjs';

const log = createLogger('network-tracer');

/** Rolling window of last 100 request latencies */
const latencyWindow = [];
const MAX_WINDOW = 100;

/** Session lifecycle events */
const sessionEvents = [];
const MAX_EVENTS = 500;

/**
 * Record a request latency.
 */
export function recordLatency(target, durationMs) {
  latencyWindow.push({ target, durationMs, ts: Date.now() });
  if (latencyWindow.length > MAX_WINDOW) latencyWindow.shift();
}

/**
 * Get moving average latency.
 */
export function getAverageLatency(target) {
  const filtered = target
    ? latencyWindow.filter(l => l.target === target)
    : latencyWindow;

  if (!filtered.length) return 0;
  return filtered.reduce((sum, l) => sum + l.durationMs, 0) / filtered.length;
}

/**
 * Get latency stats.
 */
export function getLatencyStats() {
  if (!latencyWindow.length) return { avg: 0, min: 0, max: 0, p95: 0, count: 0 };

  const sorted = [...latencyWindow].sort((a, b) => a.durationMs - b.durationMs);
  const p95Idx = Math.floor(sorted.length * 0.95);

  return {
    avg: sorted.reduce((s, l) => s + l.durationMs, 0) / sorted.length,
    min: sorted[0].durationMs,
    max: sorted[sorted.length - 1].durationMs,
    p95: sorted[p95Idx]?.durationMs || 0,
    count: sorted.length,
  };
}

/**
 * Record a session lifecycle event.
 */
export function recordSessionEvent(siteId, event, detail) {
  sessionEvents.push({
    siteId, event, detail,
    ts: new Date().toISOString(),
  });
  if (sessionEvents.length > MAX_EVENTS) sessionEvents.shift();

  log.debug('Session event', { siteId, event, detail });
}

/**
 * Get recent session events.
 */
export function getSessionEvents(limit = 50) {
  return sessionEvents.slice(-limit);
}

/**
 * Check if a duration is anomalous (>3x average).
 */
export function isDurationAnomaly(durationMs, target) {
  const avg = getAverageLatency(target);
  if (avg === 0 || latencyWindow.length < 10) return false;
  return durationMs > avg * 3;
}
