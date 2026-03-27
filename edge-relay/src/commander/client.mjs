/**
 * Verifone Commander CGI API Client (Edge Relay)
 *
 * Ported from shre-verifone/src/commander/client.mjs for standalone operation.
 * Rate-limited to 500ms between requests (Commander is single-threaded).
 *
 * Base URL: https://{IP}/cgi-bin/CGILink?cmd=
 * Auth: cmd=validate → session cookie
 * Reports: cmd=vrubyrept&reptname={type}&period={1=Shift|2=Day}&cookie={c}
 * Transactions: cmd=vperiodrept&period={p}&filename={f}&cookie={c}
 * Period list: cmd=vreportpdlist&cookie={c}
 */

import { parseHtmlTable, parsePeriodList, parseSummaryReport } from './xml-parser.mjs';

const REQUEST_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
let lastRequestAt = 0;

/**
 * Rate-limited fetch wrapper for Commander devices.
 */
export async function commanderRequest(url, options = {}) {
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
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(ip, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://${ip}/cgi-bin/CGILink?${qs}`;
}

/**
 * Login to Commander and return session cookie.
 */
export async function login(ip, user, pass) {
  const url = buildUrl(ip, { cmd: 'validate', user, passwd: pass });
  const res = await commanderRequest(url);
  if (!res.ok) throw new Error(`Commander login failed: HTTP ${res.status}`);

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
 */
export async function fetchReport(ip, cookie, reptname, period = 2) {
  const url = buildUrl(ip, { cmd: 'vrubyrept', reptname, period: String(period), cookie });
  const res = await commanderRequest(url);
  if (!res.ok) throw new Error(`Commander report ${reptname} failed: HTTP ${res.status}`);

  const html = await res.text();
  if (reptname === 'summary') {
    const summary = parseSummaryReport(html);
    return summary ? [summary] : [];
  }
  return parseHtmlTable(html);
}

/**
 * Fetch available period/shift files.
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
 */
export async function testConnection(ip, user, pass) {
  try {
    const cookie = await login(ip, user, pass);
    return { reachable: true, cookie };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
