/**
 * Commander Session Manager (Edge Relay)
 *
 * Cookie-based sessions with circuit breaker.
 * Ported from shre-verifone/src/commander/session.mjs.
 */

import { login } from './client.mjs';

/** @type {Map<string, { cookie: string, ip: string, user: string, pass: string, refreshedAt: number }>} */
const sessions = new Map();

/** @type {Map<string, { failures: number, openUntil: number, backoffMs: number }>} */
const circuits = new Map();

const COOKIE_TTL_MS = 25 * 60 * 1000;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_MIN_BACKOFF = 30_000;
const CIRCUIT_MAX_BACKOFF = 30 * 60 * 1000;

/**
 * Get or create a session for a site.
 */
export async function getSession(siteId, config) {
  const circuit = circuits.get(siteId);
  if (circuit && Date.now() < circuit.openUntil) {
    throw new Error(`Circuit open for ${siteId} — retry after ${new Date(circuit.openUntil).toISOString()}`);
  }

  const existing = sessions.get(siteId);
  if (existing && (Date.now() - existing.refreshedAt) < COOKIE_TTL_MS) {
    return existing.cookie;
  }

  try {
    const cookie = await login(config.ip, config.user, config.pass);
    sessions.set(siteId, {
      cookie,
      ip: config.ip,
      user: config.user,
      pass: config.pass,
      refreshedAt: Date.now(),
    });
    circuits.delete(siteId);
    return cookie;
  } catch (err) {
    recordFailure(siteId);
    throw err;
  }
}

/**
 * Force refresh a session (e.g., on 401).
 */
export async function refreshSession(siteId, config) {
  sessions.delete(siteId);
  return getSession(siteId, config);
}

/**
 * Invalidate session.
 */
export function invalidateSession(siteId) {
  sessions.delete(siteId);
}

/**
 * Get circuit breaker state.
 */
export function getCircuitState(siteId) {
  const circuit = circuits.get(siteId);
  if (!circuit) return { isOpen: false, failures: 0, openUntil: null };
  return {
    isOpen: Date.now() < circuit.openUntil,
    failures: circuit.failures,
    openUntil: circuit.openUntil,
  };
}

/**
 * Get all active sessions (for health).
 */
export function getActiveSessions() {
  const result = {};
  for (const [siteId, session] of sessions) {
    result[siteId] = {
      ip: session.ip,
      refreshedAt: new Date(session.refreshedAt).toISOString(),
      ageMs: Date.now() - session.refreshedAt,
      circuit: getCircuitState(siteId),
    };
  }
  return result;
}

function recordFailure(siteId) {
  const circuit = circuits.get(siteId) || { failures: 0, openUntil: 0, backoffMs: CIRCUIT_MIN_BACKOFF };
  circuit.failures++;
  if (circuit.failures >= CIRCUIT_THRESHOLD) {
    circuit.openUntil = Date.now() + circuit.backoffMs;
    circuit.backoffMs = Math.min(circuit.backoffMs * 2, CIRCUIT_MAX_BACKOFF);
  }
  circuits.set(siteId, circuit);
}
