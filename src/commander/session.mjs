/**
 * Verifone Commander Session Manager
 *
 * Manages cookie-based sessions for Commander devices.
 * Commander cookies have ~30min TTL — auto-refresh at 25min.
 * Circuit breaker: 3 failures → open, exponential backoff to 30min.
 */

import { commanderRequest } from './client.mjs';

/** @type {Map<string, { cookie: string, ip: string, user: string, pass: string, refreshedAt: number }>} */
const sessions = new Map();

/** @type {Map<string, { failures: number, openUntil: number, backoffMs: number }>} */
const circuits = new Map();

const COOKIE_TTL_MS = 25 * 60 * 1000; // Refresh at 25min (cookies expire ~30min)
const CIRCUIT_THRESHOLD = 3; // Failures before opening
const CIRCUIT_MIN_BACKOFF = 30_000; // 30s initial backoff
const CIRCUIT_MAX_BACKOFF = 30 * 60 * 1000; // 30min max backoff

/**
 * Get or create a session for a site.
 * @param {string} siteId
 * @param {{ ip: string, user: string, pass: string }} config
 * @returns {Promise<string>} cookie
 */
export async function getSession(siteId, config) {
  // Check circuit breaker
  const circuit = circuits.get(siteId);
  if (circuit && Date.now() < circuit.openUntil) {
    throw new Error(
      `Circuit open for ${siteId} — retry after ${new Date(circuit.openUntil).toISOString()}`,
    );
  }

  // Check existing session
  const existing = sessions.get(siteId);
  if (existing && Date.now() - existing.refreshedAt < COOKIE_TTL_MS) {
    return existing.cookie;
  }

  // Login to get fresh cookie
  try {
    const cookie = await login(config.ip, config.user, config.pass);
    sessions.set(siteId, {
      cookie,
      ip: config.ip,
      user: config.user,
      pass: config.pass,
      refreshedAt: Date.now(),
    });

    // Reset circuit on success
    circuits.delete(siteId);

    return cookie;
  } catch (err) {
    recordFailure(siteId);
    throw err;
  }
}

/**
 * Force refresh a session (e.g., on 401).
 * @param {string} siteId
 * @param {{ ip: string, user: string, pass: string }} config
 * @returns {Promise<string>} cookie
 */
export async function refreshSession(siteId, config) {
  sessions.delete(siteId);
  return getSession(siteId, config);
}

/**
 * Login to Commander device.
 * @param {string} ip
 * @param {string} user
 * @param {string} pass
 * @returns {Promise<string>} cookie value
 */
async function login(ip, user, pass) {
  const url = `https://${ip}/cgi-bin/CGILink?cmd=validate&user=${encodeURIComponent(user)}&passwd=${encodeURIComponent(pass)}`;
  const response = await commanderRequest(url, { method: 'GET' });

  if (!response.ok) {
    throw new Error(`Commander login failed: HTTP ${response.status}`);
  }

  // Extract cookie from response headers or body
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/cookie=([^;]+)/i) || setCookie.match(/([A-Za-z0-9]+)/);
    if (match) return match[1];
  }

  // Some Commander versions return cookie in body
  const body = await response.text();
  const cookieMatch = body.match(/cookie[=:]?\s*["']?([A-Za-z0-9_-]+)/i);
  if (cookieMatch) return cookieMatch[1];

  throw new Error('No cookie returned from Commander login');
}

/**
 * Invalidate session (e.g., on shutdown).
 * @param {string} siteId
 */
export function invalidateSession(siteId) {
  sessions.delete(siteId);
}

/**
 * Get circuit breaker state for a site.
 * @param {string} siteId
 * @returns {{ isOpen: boolean, failures: number, openUntil: number | null }}
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
 * Get all active sessions (for health check).
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

// ── Circuit breaker internals ────────────────────────────────────

function recordFailure(siteId) {
  const circuit = circuits.get(siteId) || {
    failures: 0,
    openUntil: 0,
    backoffMs: CIRCUIT_MIN_BACKOFF,
  };
  circuit.failures++;

  if (circuit.failures >= CIRCUIT_THRESHOLD) {
    circuit.openUntil = Date.now() + circuit.backoffMs;
    circuit.backoffMs = Math.min(circuit.backoffMs * 2, CIRCUIT_MAX_BACKOFF);
  }

  circuits.set(siteId, circuit);
}
