/**
 * Admin Server — local HTTP server for setup wizard + status dashboard
 *
 * Binds to 0.0.0.0:18464. Serves admin UI and REST API.
 * Only accepts connections from localhost (127.0.0.1/::1).
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { DEFAULTS, getConfig } from '../config.mjs';
import { setupRoutes } from './routes/setup.mjs';
import { statusRoutes } from './routes/status.mjs';
import { logsRoutes } from './routes/logs.mjs';
import { settingsRoutes } from './routes/settings.mjs';
import { logActivity } from '../secretservice/activity-logger.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('admin-server');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let _server = null;

/**
 * Start admin HTTP server.
 */
export function startAdminServer(uiDir, options = {}) {
  const port = options.port || DEFAULTS.ADMIN_PORT;

  // Build route table
  const routes = new Map();
  setupRoutes(routes);
  statusRoutes(routes);
  logsRoutes(routes);
  settingsRoutes(routes);

  _server = createServer(async (req, res) => {
    const start = Date.now();
    const remoteIp = req.socket.remoteAddress?.replace('::ffff:', '') || '';

    // Security: only allow localhost
    const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!isLocal) {
      logActivity({
        direction: 'inbound-admin',
        target: remoteIp,
        method: req.method,
        path: req.url,
        status: 403,
        durationMs: Date.now() - start,
      });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden — admin UI is localhost-only' }));
      return;
    }

    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const method = req.method.toUpperCase();
      const path = url.pathname;

      // API routes
      const routeKey = `${method} ${path}`;
      const handler = routes.get(routeKey) || matchParamRoute(routes, method, path);

      if (handler) {
        // Parse body for POST/PATCH
        let body = null;
        if (['POST', 'PATCH', 'PUT'].includes(method)) {
          body = await readBody(req);
        }

        const result = await handler.fn({ url, body, params: handler.params || {} });
        const statusCode = result.status || 200;
        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(result.body ?? result));
        logActivity({
          direction: 'inbound-admin', target: remoteIp,
          method, path, status: statusCode, durationMs: Date.now() - start,
        });
        return;
      }

      // Static files (admin UI)
      let filePath = path === '/' ? '/index.html' : path;
      const fullPath = join(uiDir, filePath);

      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf8');
        const ext = extname(fullPath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'text/plain',
          'Cache-Control': 'no-cache',
        });
        res.end(content);
        return;
      }

      // Redirect root to setup or status
      if (path === '/' || path === '/index.html') {
        const isSetup = getConfig('relay_id');
        const target = isSetup ? '/status.html' : '/setup.html';
        res.writeHead(302, { Location: target });
        res.end();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
      log.error('Admin request failed', { error: err.message, url: req.url });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  _server.listen(port, '0.0.0.0', () => {
    log.info(`Admin server listening on http://localhost:${port}`);
  });

  return _server;
}

export function stopAdminServer() {
  if (_server) _server.close();
  _server = null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve(null); }
    });
    req.on('error', reject);
  });
}

/**
 * Match routes with path parameters (e.g., /api/sites/:siteId/password).
 */
function matchParamRoute(routes, method, path) {
  for (const [key, fn] of routes) {
    if (!key.includes(':')) continue;
    const [rMethod, rPath] = key.split(' ');
    if (rMethod !== method) continue;

    const rParts = rPath.split('/');
    const pParts = path.split('/');
    if (rParts.length !== pParts.length) continue;

    const params = {};
    let match = true;
    for (let i = 0; i < rParts.length; i++) {
      if (rParts[i].startsWith(':')) {
        params[rParts[i].slice(1)] = pParts[i];
      } else if (rParts[i] !== pParts[i]) {
        match = false;
        break;
      }
    }

    if (match) return { fn, params };
  }
  return null;
}
