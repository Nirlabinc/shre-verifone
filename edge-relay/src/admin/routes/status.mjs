/**
 * Status API Routes — health, sync, password, disk
 */

import { getDb } from '../../config.mjs';
import { getHealthSnapshot } from '../../heartbeat.mjs';
import { getSyncStatus } from '../../sync/sync-engine.mjs';
import { getReportStats } from '../../sync/report-store.mjs';
import { getPasswordHealth } from '../../commander/password-rotation.mjs';
import { getQueueStats } from '../../uplink/offline-buffer.mjs';
import { getDiskFreeMB, checkDisk } from '../../cleanup/disk-monitor.mjs';
import { getActiveSessions } from '../../commander/session.mjs';
import { verifyChain, getAuditStats } from '../../secretservice/audit-chain.mjs';
import { getAllLedger } from '../../sync/sync-ledger.mjs';
import { checkForUpdate } from '../../updater/update-checker.mjs';

export function statusRoutes(routes) {
  // Full status dashboard data
  routes.set('GET /api/status', {
    fn: async () => {
      const db = getDb();
      const sites = db
        .prepare(
          'SELECT site_id, site_name, commander_ip, enabled, sync_interval_ms, created_at FROM site_config',
        )
        .all();

      return {
        body: {
          health: getHealthSnapshot(),
          sync: getSyncStatus(),
          reports: getReportStats(),
          passwordHealth: getPasswordHealth(db),
          uplink: getQueueStats(),
          disk: checkDisk(),
          sessions: getActiveSessions(),
          audit: getAuditStats(),
          sites,
          ledger: getAllLedger(),
          update: checkForUpdate(),
        },
      };
    },
  });

  // Health endpoint (lightweight)
  routes.set('GET /health', {
    fn: async () => ({ body: getHealthSnapshot() }),
  });

  routes.set('GET /readyz', {
    fn: async () => {
      const health = getHealthSnapshot();
      const ready = health.status !== 'stopped';
      return { status: ready ? 200 : 503, body: { ready } };
    },
  });

  // List sites
  routes.set('GET /api/sites', {
    fn: async () => {
      const db = getDb();
      const sites = db.prepare('SELECT * FROM site_config ORDER BY created_at DESC').all();
      return { body: { sites } };
    },
  });

  // Get single site
  routes.set('GET /api/sites/:siteId', {
    fn: async ({ params }) => {
      const db = getDb();
      const site = db.prepare('SELECT * FROM site_config WHERE site_id = ?').get(params.siteId);
      if (!site) return { status: 404, body: { error: 'Site not found' } };
      return { body: site };
    },
  });

  // Sync status
  routes.set('GET /api/sync/status', {
    fn: async () => ({
      body: { syncs: getSyncStatus(), ledger: getAllLedger() },
    }),
  });

  // Site ledger
  routes.set('GET /api/sites/:siteId/ledger', {
    fn: async ({ params }) => {
      const { getLedger } = await import('../../sync/sync-ledger.mjs');
      return { body: { ledger: getLedger(params.siteId) } };
    },
  });

  // Password health
  routes.set('GET /api/password-health', {
    fn: async () => {
      const db = getDb();
      return { body: { passwords: getPasswordHealth(db) } };
    },
  });

  // Audit chain status
  routes.set('GET /api/audit/verify', {
    fn: async () => ({ body: verifyChain() }),
  });

  // Trigger manual sync
  routes.set('POST /api/sites/:siteId/sync', {
    fn: async ({ params }) => {
      const db = getDb();
      const site = db.prepare('SELECT * FROM site_config WHERE site_id = ?').get(params.siteId);
      if (!site) return { status: 404, body: { error: 'Site not found' } };

      const { getCredential } = await import('../../vault/credential-store.mjs');
      const { triggerSync } = await import('../../sync/sync-engine.mjs');
      const pass = getCredential(site.site_id);

      triggerSync(site.site_id, { ip: site.commander_ip, user: site.username, pass }).catch(
        () => {},
      );
      return { body: { message: 'Sync triggered' } };
    },
  });

  // Test Commander connection
  routes.set('POST /api/sites/:siteId/test', {
    fn: async ({ params }) => {
      const db = getDb();
      const site = db.prepare('SELECT * FROM site_config WHERE site_id = ?').get(params.siteId);
      if (!site) return { status: 404, body: { error: 'Site not found' } };

      const { getCredential } = await import('../../vault/credential-store.mjs');
      const { testConnection } = await import('../../commander/client.mjs');
      const pass = getCredential(site.site_id);
      const result = await testConnection(site.commander_ip, site.username, pass);
      return { body: result };
    },
  });

  // Manual password update
  routes.set('PATCH /api/sites/:siteId/password', {
    fn: async ({ params, body }) => {
      if (!body?.password) return { status: 400, body: { error: 'Password required' } };

      const db = getDb();
      const { recordManualPasswordUpdate } = await import('../../commander/password-rotation.mjs');
      const { getVaultInterface } = await import('../../vault/credential-store.mjs');

      recordManualPasswordUpdate(db, params.siteId, body.password, getVaultInterface());
      return { body: { success: true, message: 'Password updated' } };
    },
  });
}
