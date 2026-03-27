/**
 * Setup Wizard API Routes
 *
 * Step 1: Login — validate Shre AI credentials
 * Step 2: Commander — test connectivity
 * Step 3: Data sharing preferences
 * Step 4: Complete — save config, start sync, register with cloud
 */

import { getDb, setConfig, getConfig, getRelayId } from '../../config.mjs';
import { authenticateRelay, registerRelay } from '../../uplink/uplink-client.mjs';
import { testConnection } from '../../commander/client.mjs';
import { initVault } from '../../vault/local-vault.mjs';
import { setCredential } from '../../vault/credential-store.mjs';
import { auditLog } from '../../secretservice/audit-chain.mjs';
import { createLogger } from '../../logger.mjs';
import { randomBytes } from 'crypto';

const log = createLogger('setup');

export function setupRoutes(routes) {
  // Check if setup is complete
  routes.set('GET /api/setup/status', {
    fn: async () => {
      const relayId = getRelayId();
      return { body: { complete: !!relayId, relayId } };
    },
  });

  // Step 1: Authenticate with Shre AI cloud
  routes.set('POST /api/setup/login', {
    fn: async ({ body }) => {
      if (!body?.email || !body?.password) {
        return { status: 400, body: { error: 'Email and password required' } };
      }

      try {
        const result = await authenticateRelay(body.email, body.password);
        auditLog('setup.login', body.email, 'Cloud authentication successful');
        return { body: { success: true, ...result } };
      } catch (err) {
        auditLog('setup.login_failed', body.email, err.message);
        return { status: 401, body: { error: err.message } };
      }
    },
  });

  // Step 2: Test Commander connectivity
  routes.set('POST /api/setup/test-commander', {
    fn: async ({ body }) => {
      if (!body?.ip || !body?.username || !body?.password) {
        return { status: 400, body: { error: 'IP, username, and password required' } };
      }

      try {
        const result = await testConnection(body.ip, body.username, body.password);
        auditLog('setup.test_commander', 'admin', `Test ${body.ip}: ${result.reachable ? 'success' : 'failed'}`);
        return { body: result };
      } catch (err) {
        return { body: { reachable: false, error: err.message } };
      }
    },
  });

  // Step 4: Complete setup
  routes.set('POST /api/setup/complete', {
    fn: async ({ body }) => {
      if (!body?.email || !body?.password || !body?.commander) {
        return { status: 400, body: { error: 'Missing required setup data' } };
      }

      const db = getDb();
      const cmd = body.commander;
      const dataTier = body.dataTier || 2;

      try {
        // Initialize vault with machine-derived passphrase
        const machineId = randomBytes(16).toString('hex');
        initVault(machineId);
        setConfig('machine_id', machineId);

        // Register with cloud
        const registration = await registerRelay(body.email, body.password, machineId);
        setConfig('relay_id', registration.relayId);
        setConfig('api_key', registration.apiKey);
        setConfig('cloud_url', registration.cloudUrl || getConfig('cloud_url'));
        setConfig('data_tier', String(dataTier));

        // Save site config
        const siteId = cmd.siteId || `site-${Date.now()}`;
        const now = new Date().toISOString();
        const passwordExpiry = new Date(Date.now() + 90 * 86400000).toISOString();

        db.prepare(`
          INSERT INTO site_config (site_id, site_name, commander_ip, username, enabled,
                                    sync_interval_ms, password_set_at, password_expires_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        `).run(
          siteId, cmd.siteName || siteId, cmd.ip, cmd.username,
          cmd.syncInterval || 300000, now, passwordExpiry,
        );

        // Store Commander password in vault
        setCredential(siteId, cmd.password);

        auditLog('setup.complete', body.email, {
          relayId: registration.relayId, siteId, dataTier,
        });

        log.info('Setup complete', { relayId: registration.relayId, siteId });

        return {
          body: {
            success: true,
            relayId: registration.relayId,
            siteId,
            message: 'Edge relay configured. Sync will start automatically.',
          },
        };
      } catch (err) {
        log.error('Setup failed', { error: err.message });
        auditLog('setup.failed', body.email, err.message);
        return { status: 500, body: { error: err.message } };
      }
    },
  });
}
