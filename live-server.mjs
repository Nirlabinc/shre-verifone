#!/usr/bin/env node
/**
 * Verifone Commander Live Server
 *
 * HTTP server (port 5464) + WebSocket push.
 * Site management API + real-time sync from Commander LAN devices.
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';
import pg from 'pg';

import { createLogger } from 'shre-sdk/logger';
import { createCortexClient } from 'shre-sdk/cortex';
import { createEventBus, createLifecycleEmitter } from 'shre-sdk/events';
import { createRAGClient } from 'shre-sdk/rag';
import { createExecutionTracker } from 'shre-sdk/execution';
import { createHeartbeatMonitor } from 'shre-sdk/heartbeat';
// shre-sdk/trace — request tracing + observability endpoints
import { createTraceMiddleware, createTrace, getRecentTraces, getRecentFailures, getTraceStats } from 'shre-sdk/trace';
import { getInfra, serviceUrl, infraUrl } from 'shre-sdk/discovery';

import { testConnection } from './src/commander/client.mjs';
import { getActiveSessions, getCircuitState } from './src/commander/session.mjs';
import { startSync, stopSync, triggerSync, getSyncStatus } from './src/live/auto-sync.mjs';
import { buildPayload, fetchTodayData, fetchPeriodData } from './src/live/data-refresh.mjs';
import { checkAllPasswords, getPasswordHealth, recordManualPasswordUpdate } from './src/commander/password-rotation.mjs';

const log = createLogger('shre-verifone');

// ─── Port ────────────────────────────────────────────────────────
let PORT = 5464;
try {
  const ports = JSON.parse(readFileSync(join(import.meta.dirname, '../ports.json'), 'utf8'));
  PORT = ports.services?.['shre-verifone']?.port || PORT;
} catch { /* use default */ }
PORT = parseInt(process.env.PORT || PORT, 10);

// ─── Event Bus + Lifecycle ────────────────────────────────────────
let bus, lifecycle;
try {
  bus = createEventBus('shre-verifone');
  lifecycle = createLifecycleEmitter(bus, 'shre-verifone', { port: PORT });
} catch (e) {
  log.warn('EventBus init failed (non-fatal)', { error: e.message });
}

// ─── Heartbeat Monitor ──────────────────────────────────────────
const heartbeat = createHeartbeatMonitor('shre-verifone', {
  intervalMs: 30_000,
  publishFn: bus ? (event, severity, data) => bus.publish(event, severity, data) : undefined,
});
heartbeat.registerDependency('cortexdb', `${infraUrl('cortexservice-api')}/health/live`);
heartbeat.registerDependency('cortexdb-pg', 'http://127.0.0.1:5433');
heartbeat.registerDependency('redis', 'redis://127.0.0.1:6379');

// ─── RAG Client ──────────────────────────────────────────────────
let rag;
try {
  rag = createRAGClient('shre-verifone');
} catch (e) {
  log.warn('RAG client init failed (non-fatal)', { error: e.message });
}

// ─── Execution Tracker ──────────────────────────────────────────
const tracker = createExecutionTracker('shre-verifone');

// ─── CortexDB Pool ──────────────────────────────────────────────
let pool;
function initPool() {
  try {
    let pgHost = '127.0.0.1';
    let pgPort = 5433;
    try {
      const infra = getInfra('postgres');
      pgPort = infra.port;
      pgHost = process.env.SHRE_NODE_HOST || pgHost;
    } catch { /* discovery unavailable — use defaults */ }
    if (!process.env.POSTGRES_PASSWORD) throw new Error("POSTGRES_PASSWORD env var is required");
    let creds = { host: pgHost, port: pgPort, user: process.env.POSTGRES_USER || 'rapidnir', password: process.env.POSTGRES_PASSWORD, database: 'cortexdb' };
    const vaultPath = join(process.env.HOME || '', '.shre/vault/cortexdb.json');
    if (existsSync(vaultPath)) {
      creds = { ...creds, ...JSON.parse(readFileSync(vaultPath, 'utf8')) };
    }
    pool = new pg.Pool({ ...creds, max: 10, idleTimeoutMillis: 30000 });
    pool.on('error', (err) => log.error('Pool error', { error: err.message }));
    log.info('CortexDB pool initialized');
  } catch (err) {
    log.error('CortexDB pool init failed', { error: err.message });
  }
}

// ─── Schema init ─────────────────────────────────────────────────
async function ensureSchema() {
  if (!pool) return;
  try {
    const schemaPath = join(import.meta.dirname, 'db/schema.sql');
    if (existsSync(schemaPath)) {
      const sql = readFileSync(schemaPath, 'utf8');
      await pool.query(sql);
      log.info('Schema ensured');
    }
  } catch (err) {
    log.error('Schema init failed', { error: err.message });
  }
}

// ─── Site management ─────────────────────────────────────────────
async function getSites() {
  if (!pool) return [];
  const res = await pool.query('SELECT * FROM verifone.site_config ORDER BY created_at');
  return res.rows;
}

async function getSite(siteId) {
  if (!pool) return null;
  const res = await pool.query('SELECT * FROM verifone.site_config WHERE site_id = $1', [siteId]);
  return res.rows[0] || null;
}

async function createSite(body) {
  const siteId = body.siteId || `vfn-${randomUUID().slice(0, 8)}`;
  await pool.query(`
    INSERT INTO verifone.site_config (site_id, site_name, commander_ip, username, password_enc, sync_interval_ms, has_fuel, has_carwash)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    siteId,
    body.siteName || `Commander ${body.commanderIp}`,
    body.commanderIp,
    body.username,
    body.password, // TODO: encrypt at rest
    body.syncIntervalMs || 300000,
    body.hasFuel !== false,
    body.hasCarwash || false,
  ]);

  const site = await getSite(siteId);

  // Start sync for new site
  if (site?.enabled) {
    startSync(pool, siteId, {
      ip: site.commander_ip,
      user: site.username,
      pass: site.password_enc,
      sync_interval_ms: site.sync_interval_ms,
    }, {
      log,
      onComplete: (id) => broadcastUpdate(id),
    });
  }

  bus?.publish('verifone.sync.site_added', 'info', { siteId });
  return site;
}

async function updateSite(siteId, body) {
  const sets = [];
  const vals = [siteId];
  let idx = 2;

  for (const [key, col] of [
    ['syncIntervalMs', 'sync_interval_ms'],
    ['enabled', 'enabled'],
    ['hasFuel', 'has_fuel'],
    ['hasCarwash', 'has_carwash'],
    ['siteName', 'site_name'],
  ]) {
    if (body[key] !== undefined) {
      sets.push(`${col} = $${idx}`);
      vals.push(body[key]);
      idx++;
    }
  }

  if (!sets.length) return await getSite(siteId);

  sets.push('updated_at = now()');
  await pool.query(`UPDATE verifone.site_config SET ${sets.join(', ')} WHERE site_id = $1`, vals);

  const site = await getSite(siteId);

  // Restart sync with new settings
  stopSync(siteId);
  if (site?.enabled) {
    startSync(pool, siteId, {
      ip: site.commander_ip,
      user: site.username,
      pass: site.password_enc,
      sync_interval_ms: site.sync_interval_ms,
    }, { log, onComplete: (id) => broadcastUpdate(id) });
  }

  return site;
}

// ─── Helpers ─────────────────────────────────────────────────────
function sendJSON(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}
function sendError(res, status, message, headers = {}) {
  sendJSON(res, status, { error: message }, headers);
}
const MAX_BODY_SIZE = 512 * 1024;
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_SIZE) throw new Error('Request body too large');
  }
  return body;
}

// ─── CORS ────────────────────────────────────────────────────────
let chatOrigin, mibOrigin;
try { chatOrigin = serviceUrl('shre-chat'); } catch { chatOrigin = 'https://127.0.0.1:5510'; }
try { mibOrigin = serviceUrl('mib007'); } catch { mibOrigin = 'https://127.0.0.1:5520'; }
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`, `https://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`, `https://127.0.0.1:${PORT}`,
  chatOrigin, mibOrigin,
  'https://chat.nirtek.net',
  'https://mib007.nirtek.net',
]);
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
}

// ─── WebSocket ───────────────────────────────────────────────────
const wsClients = new Set();

function broadcastUpdate(siteId) {
  if (!wsClients.size || !pool) return;
  getSite(siteId).then(async (site) => {
    if (!site) return;
    try {
      const payload = await buildPayload(pool, siteId, site);
      const msg = JSON.stringify({ type: 'update', siteId, ...payload });
      for (const ws of wsClients) {
        if (ws.readyState === 1) ws.send(msg);
      }
    } catch (err) {
      log.warn('Broadcast failed', { error: err.message });
    }
  });
}

// ─── HTTP Server ─────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const cors = corsHeaders(req);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // ── Per-request tracing ──
  const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || undefined;
  const trace = createTrace('shre-verifone', correlationId);
  trace.setRequest?.({ method: req.method, path });
  req._trace = trace;

  try {
    // ── Health endpoints ──
    if (path === '/health' && req.method === 'GET') {
      return sendJSON(res, 200, {
        status: 'ok',
        service: 'shre-verifone',
        port: PORT,
        uptime: process.uptime(),
        sessions: getActiveSessions(),
        sync: getSyncStatus(),
        pool: pool ? { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount } : null,
      }, cors);
    }

    if (path === '/readyz' && req.method === 'GET') {
      const ready = !!pool;
      return sendJSON(res, ready ? 200 : 503, { ready }, cors);
    }

    // ── Observability: /v1/traces ──
    if (path === '/v1/traces' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 50);
      return sendJSON(res, 200, getRecentTraces(limit), cors);
    }
    if (path === '/v1/traces/failures' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 50);
      return sendJSON(res, 200, getRecentFailures(limit), cors);
    }
    if (path === '/v1/traces/stats' && req.method === 'GET') {
      return sendJSON(res, 200, getTraceStats(), cors);
    }

    // ── Site management API ──
    if (path === '/api/sites' && req.method === 'GET') {
      const sites = await getSites();
      return sendJSON(res, 200, { sites }, cors);
    }

    if (path === '/api/sites' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.commanderIp || !body.username || !body.password) {
        return sendError(res, 400, 'commanderIp, username, and password are required', cors);
      }
      const site = await createSite(body);
      return sendJSON(res, 201, { site }, cors);
    }

    const siteMatch = path.match(/^\/api\/sites\/([^/]+)$/);
    if (siteMatch && req.method === 'GET') {
      const site = await getSite(siteMatch[1]);
      if (!site) return sendError(res, 404, 'Site not found', cors);
      return sendJSON(res, 200, { site }, cors);
    }

    if (siteMatch && req.method === 'PATCH') {
      const body = JSON.parse(await readBody(req));
      const site = await updateSite(siteMatch[1], body);
      if (!site) return sendError(res, 404, 'Site not found', cors);
      return sendJSON(res, 200, { site }, cors);
    }

    // ── Test connectivity ──
    const testMatch = path.match(/^\/api\/sites\/([^/]+)\/test$/);
    if (testMatch && req.method === 'POST') {
      const site = await getSite(testMatch[1]);
      if (!site) return sendError(res, 404, 'Site not found', cors);
      const result = await testConnection(site.commander_ip, site.username, site.password_enc);
      return sendJSON(res, result.reachable ? 200 : 502, result, cors);
    }

    // ── Trigger manual sync ──
    const syncMatch = path.match(/^\/api\/sites\/([^/]+)\/sync$/);
    if (syncMatch && req.method === 'POST') {
      const site = await getSite(syncMatch[1]);
      if (!site) return sendError(res, 404, 'Site not found', cors);
      triggerSync(pool, syncMatch[1], {
        ip: site.commander_ip,
        user: site.username,
        pass: site.password_enc,
      }, log).then(() => broadcastUpdate(syncMatch[1]));
      return sendJSON(res, 202, { status: 'sync_triggered', siteId: syncMatch[1] }, cors);
    }

    // ── Live data endpoints ──
    const todayMatch = path.match(/^\/api\/sites\/([^/]+)\/today$/);
    if (todayMatch && req.method === 'GET') {
      const data = await fetchTodayData(pool, todayMatch[1]);
      return sendJSON(res, 200, data, cors);
    }

    const periodMatch = path.match(/^\/api\/sites\/([^/]+)\/periods\/(\w+)$/);
    if (periodMatch && req.method === 'GET') {
      const data = await fetchPeriodData(pool, periodMatch[1], periodMatch[2]);
      return sendJSON(res, 200, data || {}, cors);
    }

    // ── Sync status ──
    if (path === '/api/sync/status' && req.method === 'GET') {
      return sendJSON(res, 200, getSyncStatus(), cors);
    }

    // ── Sync ledger ──
    const ledgerMatch = path.match(/^\/api\/sites\/([^/]+)\/ledger$/);
    if (ledgerMatch && req.method === 'GET') {
      const res2 = await pool.query(
        'SELECT * FROM verifone.sync_ledger WHERE site_id = $1 ORDER BY updated_at DESC',
        [ledgerMatch[1]],
      );
      return sendJSON(res, 200, { ledger: res2.rows }, cors);
    }

    // ── Password health (all sites) ──
    if (path === '/api/password-health' && req.method === 'GET') {
      const health = await getPasswordHealth(pool);
      return sendJSON(res, 200, { sites: health }, cors);
    }

    // ── Password update (manual, resets lifecycle) ──
    const pwdMatch = path.match(/^\/api\/sites\/([^/]+)\/password$/);
    if (pwdMatch && req.method === 'PATCH') {
      const body = JSON.parse(await readBody(req));
      if (!body.password) {
        return sendError(res, 400, 'password is required', cors);
      }
      const site = await getSite(pwdMatch[1]);
      if (!site) return sendError(res, 404, 'Site not found', cors);

      await recordManualPasswordUpdate(pool, pwdMatch[1], body.password);

      // Restart sync with new credentials
      stopSync(pwdMatch[1]);
      startSync(pool, pwdMatch[1], {
        ip: site.commander_ip,
        user: site.username,
        pass: body.password,
        sync_interval_ms: site.sync_interval_ms,
      }, { log, onComplete: (id) => broadcastUpdate(id) });

      bus?.publish('verifone.password.manual_update', 'info', { siteId: pwdMatch[1] });
      return sendJSON(res, 200, { updated: true, expiresIn: '90 days' }, cors);
    }

    // ── Password rotation log ──
    const pwdLogMatch = path.match(/^\/api\/sites\/([^/]+)\/password-log$/);
    if (pwdLogMatch && req.method === 'GET') {
      const logRes = await pool.query(
        'SELECT * FROM verifone.password_rotation_log WHERE site_id = $1 ORDER BY created_at DESC LIMIT 50',
        [pwdLogMatch[1]],
      );
      return sendJSON(res, 200, { log: logRes.rows }, cors);
    }

    // ── Connectivity verification (deep check) ──
    const verifyMatch = path.match(/^\/api\/sites\/([^/]+)\/verify$/);
    if (verifyMatch && req.method === 'POST') {
      const site = await getSite(verifyMatch[1]);
      if (!site) return sendError(res, 404, 'Site not found', cors);

      const connectivity = await testConnection(site.commander_ip, site.username, site.password_enc);
      const passwordHealth = await getPasswordHealth(pool);
      const siteHealth = passwordHealth.find(h => h.siteId === verifyMatch[1]);
      const syncStatus = getSyncStatus();
      const circuitState = getCircuitState(verifyMatch[1]);
      const session = getActiveSessions()[verifyMatch[1]];

      // Check if we can actually fetch a report
      let reportTest = { success: false, error: null };
      if (connectivity.reachable && connectivity.cookie) {
        try {
          const { fetchReport } = await import('./src/commander/client.mjs');
          const rows = await fetchReport(site.commander_ip, connectivity.cookie, 'summary', 2);
          reportTest = { success: rows.length > 0, error: null };
        } catch (err) {
          reportTest = { success: false, error: err.message };
        }
      }

      return sendJSON(res, 200, {
        siteId: verifyMatch[1],
        siteName: site.site_name,
        checks: {
          network: { pass: connectivity.reachable, detail: connectivity.reachable ? 'Commander reachable' : connectivity.error },
          auth: { pass: !!connectivity.cookie, detail: connectivity.cookie ? 'Cookie obtained' : 'Authentication failed' },
          report: { pass: reportTest.success, detail: reportTest.success ? 'Summary report fetched' : (reportTest.error || 'No data returned') },
          circuit: { pass: !circuitState.isOpen, detail: circuitState.isOpen ? `Circuit open (${circuitState.failures} failures)` : 'Circuit closed (healthy)' },
          sync: { pass: !!syncStatus[verifyMatch[1]], detail: syncStatus[verifyMatch[1]]?.running ? 'Sync running' : 'Sync idle' },
          password: {
            pass: siteHealth?.status === 'healthy' || siteHealth?.status === 'expiring_soon',
            detail: siteHealth ? `${siteHealth.daysRemaining} days until expiry (${siteHealth.status})` : 'Unknown',
          },
        },
        overall: connectivity.reachable && !!connectivity.cookie && reportTest.success,
      }, cors);
    }

    sendError(res, 404, 'Not found', cors);
  } catch (err) {
    log.error('Request error', { path, error: err.message });
    sendError(res, 500, err.message, cors);
  }
});

// ─── WebSocket server ────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  log.info('WebSocket client connected', { total: wsClients.size });
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// ─── Startup ─────────────────────────────────────────────────────
async function boot() {
  initPool();
  await ensureSchema();

  // Load existing sites and start sync for enabled ones
  try {
    const sites = await getSites();
    for (const site of sites) {
      if (!site.enabled) continue;
      startSync(pool, site.site_id, {
        ip: site.commander_ip,
        user: site.username,
        pass: site.password_enc,
        sync_interval_ms: site.sync_interval_ms,
      }, {
        log,
        onComplete: (id) => broadcastUpdate(id),
      });
    }
    log.info(`Loaded ${sites.length} sites (${sites.filter(s => s.enabled).length} enabled)`);
  } catch (err) {
    log.warn('Failed to load sites on boot', { error: err.message });
  }

  // Password rotation check: run on boot + every hour
  checkAllPasswords(pool, {
    log,
    publish: (type, severity, data) => bus?.publish(type, severity, data),
  }).catch(err => log.warn('Initial password check failed', { error: err.message }));

  setInterval(() => {
    checkAllPasswords(pool, {
      log,
      publish: (type, severity, data) => {
        bus?.publish(type, severity, data);
        // Also push to WebSocket clients for real-time UI alerts
        const msg = JSON.stringify({ type: 'password_alert', ...data });
        for (const ws of wsClients) {
          if (ws.readyState === 1) ws.send(msg);
        }
      },
    }).catch(err => log.warn('Password rotation check failed', { error: err.message }));
  }, 60 * 60 * 1000); // Every hour

  server.listen(PORT, '0.0.0.0', () => {
    log.info(`shre-verifone listening on 0.0.0.0:${PORT}`);
    lifecycle?.started();
    heartbeat.start();
  });
}

boot().catch((err) => {
  log.error('Boot failed', { error: err.message });
  process.exit(1);
});

// ─── Graceful shutdown ───────────────────────────────────────────
process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down');
  lifecycle?.stopping();
  heartbeat.stop();
  for (const [siteId] of syncTimers || []) stopSync(siteId);
  wss.close();
  server.close();
  pool?.end();
  process.exit(0);
});
