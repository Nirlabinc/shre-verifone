/**
 * Verifone Commander CGI API Client
 *
 * Low-level HTTP client for Commander devices. All requests go through
 * a rate-limited queue (500ms between requests) because Commander is a
 * single-threaded embedded device.
 *
 * Base URL: https://{IP}/cgi-bin/CGILink?cmd=
 * Auth: cmd=validate → session cookie
 * Reports: cmd=vrubyrept&reptname={type}&period={1=Shift|2=Day}&cookie={c}
 * Transactions: cmd=vperiodrept&period={p}&filename={f}&cookie={c}
 * Period list: cmd=vreportpdlist&cookie={c}
 */

import { parseHtmlTable, parsePeriodList, parseSummaryReport } from './xml-parser.mjs';

const REQUEST_DELAY_MS = 500; // 500ms between requests (device rate limit)
const REQUEST_TIMEOUT_MS = 15_000; // 15s per request
let lastRequestAt = 0;

/**
 * Rate-limited fetch wrapper for Commander devices.
 * Enforces 500ms minimum gap between requests.
 */
export async function commanderRequest(url, options = {}) {
  // Enforce rate limit
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) {
    await sleep(REQUEST_DELAY_MS - elapsed);
  }
  lastRequestAt = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      // Commander uses self-signed certs on LAN
      ...(typeof process !== 'undefined' ? {} : {}),
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build Commander CGI URL.
 * @param {string} ip - Commander IP address
 * @param {Record<string, string>} params - CGI parameters
 * @returns {string}
 */
function buildUrl(ip, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://${ip}/cgi-bin/CGILink?${qs}`;
}

/**
 * Login to Commander and return session cookie.
 * @param {string} ip
 * @param {string} user
 * @param {string} pass
 * @returns {Promise<string>} cookie
 */
export async function login(ip, user, pass) {
  const url = buildUrl(ip, { cmd: 'validate', user, passwd: pass });
  const res = await commanderRequest(url);
  if (!res.ok) throw new Error(`Commander login failed: HTTP ${res.status}`);

  // Extract cookie from set-cookie header or response body
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/cookie=([^;]+)/i) || setCookie.match(/(\w{8,})/);
    if (match) return match[1];
  }

  const body = await res.text();
  const match = body.match(/cookie[=:]?\s*["']?([A-Za-z0-9_-]+)/i);
  if (match) return match[1];

  throw new Error('No cookie in Commander login response');
}

/**
 * Fetch a Ruby report from Commander.
 * @param {string} ip
 * @param {string} cookie
 * @param {string} reptname - Report type (summary, department, plu, tax, hourly, network, etc.)
 * @param {1|2} period - 1=Shift, 2=Day
 * @returns {Promise<object[]>} Parsed report rows
 */
export async function fetchReport(ip, cookie, reptname, period = 2) {
  const url = buildUrl(ip, { cmd: 'vrubyrept', reptname, period: String(period), cookie });
  const res = await commanderRequest(url);
  if (!res.ok) throw new Error(`Commander report ${reptname} failed: HTTP ${res.status}`);

  const html = await res.text();

  // Summary reports get special parsing
  if (reptname === 'summary') {
    const summary = parseSummaryReport(html);
    return summary ? [summary] : [];
  }

  return parseHtmlTable(html);
}

/**
 * Fetch available period/shift files.
 * @param {string} ip
 * @param {string} cookie
 * @returns {Promise<Array<{ filename: string, date: string, type: string }>>}
 */
export async function fetchAvailablePeriods(ip, cookie) {
  const url = buildUrl(ip, { cmd: 'vreportpdlist', cookie });
  const res = await commanderRequest(url);
  if (!res.ok) throw new Error(`Commander period list failed: HTTP ${res.status}`);

  const html = await res.text();
  return parsePeriodList(html);
}

/**
 * Fetch transaction log for a specific period file.
 * @param {string} ip
 * @param {string} cookie
 * @param {string} period
 * @param {string} filename
 * @returns {Promise<object[]>} Parsed transaction rows
 */
export async function fetchTransactionLog(ip, cookie, period, filename) {
  const url = buildUrl(ip, { cmd: 'vperiodrept', period, filename, cookie });
  const res = await commanderRequest(url);
  if (!res.ok) throw new Error(`Commander transaction log failed: HTTP ${res.status}`);

  const html = await res.text();
  return parseHtmlTable(html);
}

/**
 * Test connectivity to a Commander device.
 * @param {string} ip
 * @param {string} user
 * @param {string} pass
 * @returns {Promise<{ reachable: boolean, cookie?: string, error?: string }>}
 */
export async function testConnection(ip, user, pass) {
  try {
    const cookie = await login(ip, user, pass);
    return { reachable: true, cookie };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
