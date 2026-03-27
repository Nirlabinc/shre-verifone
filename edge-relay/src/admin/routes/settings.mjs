/**
 * Settings API Routes — update config, manage sites
 */

import { getDb, getAllConfig, setConfig, getConfig } from '../../config.mjs';
import { auditLog } from '../../secretservice/audit-chain.mjs';

const WRITABLE_KEYS = new Set([
  'data_tier', 'sync_interval_ms',
  'retention_logs_days', 'retention_activity_days',
  'retention_reports_days', 'retention_transactions_days',
  'retention_wal_days', 'retention_audit_days',
]);

export function settingsRoutes(routes) {
  // Get all config
  routes.set('GET /api/settings', {
    fn: async () => {
      const config = getAllConfig();
      // Redact sensitive keys
      delete config.api_key;
      delete config.audit_hmac_secret;
      delete config.machine_id;
      return { body: config };
    },
  });

  // Update config
  routes.set('PATCH /api/settings', {
    fn: async ({ body }) => {
      if (!body || typeof body !== 'object') {
        return { status: 400, body: { error: 'Invalid body' } };
      }

      const updated = [];
      for (const [key, value] of Object.entries(body)) {
        if (!WRITABLE_KEYS.has(key)) continue;
        setConfig(key, String(value));
        updated.push(key);
      }

      auditLog('settings.update', 'admin', { keys: updated });
      return { body: { success: true, updated } };
    },
  });

  // Update site config
  routes.set('PATCH /api/sites/:siteId', {
    fn: async ({ params, body }) => {
      if (!body) return { status: 400, body: { error: 'Invalid body' } };

      const db = getDb();
      const site = db.prepare('SELECT * FROM site_config WHERE site_id = ?').get(params.siteId);
      if (!site) return { status: 404, body: { error: 'Site not found' } };

      const allowedFields = ['site_name', 'commander_ip', 'username', 'enabled', 'sync_interval_ms'];
      const updates = [];
      const values = [];

      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updates.push(`${field} = ?`);
          values.push(body[field]);
        }
      }

      if (!updates.length) return { status: 400, body: { error: 'No valid fields to update' } };

      updates.push('updated_at = datetime(\'now\')');
      values.push(params.siteId);

      db.prepare(`UPDATE site_config SET ${updates.join(', ')} WHERE site_id = ?`).run(...values);

      auditLog('site.update', 'admin', { siteId: params.siteId, fields: Object.keys(body) });

      // Restart sync if interval or enabled changed
      if (body.enabled !== undefined || body.sync_interval_ms !== undefined) {
        const updatedSite = db.prepare('SELECT * FROM site_config WHERE site_id = ?').get(params.siteId);
        const { stopSync, startSync } = await import('../../sync/sync-engine.mjs');
        const { getCredential } = await import('../../vault/credential-store.mjs');

        stopSync(params.siteId);
        if (updatedSite.enabled) {
          const pass = getCredential(params.siteId);
          startSync(params.siteId, {
            ip: updatedSite.commander_ip,
            user: updatedSite.username,
            pass,
            sync_interval_ms: updatedSite.sync_interval_ms,
          });
        }
      }

      return { body: { success: true } };
    },
  });

  // Add new site
  routes.set('POST /api/sites', {
    fn: async ({ body }) => {
      if (!body?.commanderIp || !body?.username || !body?.password) {
        return { status: 400, body: { error: 'commanderIp, username, and password required' } };
      }

      const db = getDb();
      const siteId = body.siteId || `site-${Date.now()}`;
      const now = new Date().toISOString();
      const passwordExpiry = new Date(Date.now() + 90 * 86400000).toISOString();

      db.prepare(`
        INSERT INTO site_config (site_id, site_name, commander_ip, username, enabled,
                                  sync_interval_ms, password_set_at, password_expires_at)
        VALUES (?, ?, ?, ?, 1, 300000, ?, ?)
      `).run(siteId, body.siteName || siteId, body.commanderIp, body.username, now, passwordExpiry);

      const { setCredential } = await import('../../vault/credential-store.mjs');
      setCredential(siteId, body.password);

      auditLog('site.add', 'admin', { siteId });
      return { status: 201, body: { success: true, siteId } };
    },
  });
}
