/**
 * Verifone Edge Relay — Main Entry Point
 *
 * Service lifecycle:
 * 1. Initialize SQLite database + vault
 * 2. Start admin server (setup wizard or status dashboard)
 * 3. If configured: start sync, uplink, downlink, monitoring
 * 4. Graceful shutdown on SIGINT/SIGTERM
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  getDb,
  closeDb,
  getRelayId,
  getConfig,
  ensureDataDir,
  getDataDir,
  DEFAULTS,
} from './config.mjs';
import { initLogger, createLogger, closeLogger } from './logger.mjs';
import { initVault, closeVault } from './vault/local-vault.mjs';
import { getVaultInterface } from './vault/credential-store.mjs';
import { startSync, stopAllSyncs } from './sync/sync-engine.mjs';
import { startUplink, stopUplink } from './uplink/uplink-client.mjs';
import { startDownlink, stopDownlink } from './uplink/downlink-poller.mjs';
import { startHeartbeat, stopHeartbeat, setStatus } from './heartbeat.mjs';
import { startAnomalyDetector, stopAnomalyDetector } from './secretservice/anomaly-detector.mjs';
import { startRetention, stopRetention } from './cleanup/retention-manager.mjs';
import { startDiskMonitor, stopDiskMonitor, checkDisk } from './cleanup/disk-monitor.mjs';
import { checkAllPasswords } from './commander/password-rotation.mjs';
import { startAdminServer, stopAdminServer } from './admin/admin-server.mjs';
import { setupHealthWatchdog } from './updater/rollback.mjs';
import { auditLog } from './secretservice/audit-chain.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // 1. Initialize data directory and logging
  const dataDir = ensureDataDir();
  initLogger(dataDir, { level: process.env.LOG_LEVEL || 'info' });
  const log = createLogger('main');

  log.info('Verifone Edge Relay starting', {
    version: process.env.RELAY_VERSION || '1.0.0',
    dataDir,
    platform: process.platform,
    nodeVersion: process.version,
  });

  // Post-update health watchdog
  setupHealthWatchdog();

  // 2. Initialize database
  getDb();
  log.info('Database initialized');

  // 3. Start admin server (always — serves setup wizard if not configured)
  const uiDir = join(__dirname, '..', 'admin-ui');
  const adminPort = parseInt(process.env.RELAY_ADMIN_PORT || '') || DEFAULTS.ADMIN_PORT;
  startAdminServer(uiDir, { port: adminPort });

  // 4. Check if relay is configured
  const relayId = getRelayId();
  if (!relayId) {
    log.info(
      'Relay not configured — waiting for setup at http://localhost:' + adminPort + '/setup.html',
    );
    auditLog('relay.start', 'system', 'Waiting for setup');

    // Poll for setup completion
    const setupPoller = setInterval(() => {
      if (getRelayId()) {
        clearInterval(setupPoller);
        startServices(log);
      }
    }, 5000);
    return;
  }

  // 5. Initialize vault
  const machineId = getConfig('machine_id');
  if (machineId) {
    initVault(machineId);
    log.info('Vault initialized');
  }

  // 6. Start all services
  await startServices(log);
}

async function startServices(log) {
  const dataTier = parseInt(getConfig('data_tier') || '2');

  // Start heartbeat
  startHeartbeat();

  // Start sync for all enabled sites
  const db = getDb();
  const vault = getVaultInterface();
  const sites = db.prepare('SELECT * FROM site_config WHERE enabled = 1').all();

  for (const site of sites) {
    const password = vault.getCredential(site.site_id);
    if (!password) {
      log.warn(`No password for site ${site.site_id} — skipping sync`);
      continue;
    }
    startSync(site.site_id, {
      ip: site.commander_ip,
      user: site.username,
      pass: password,
      sync_interval_ms: site.sync_interval_ms,
    });
  }

  // Start cloud communication
  startUplink(dataTier);
  startDownlink();

  // Start security monitoring
  startAnomalyDetector(DEFAULTS.ANOMALY_CHECK_MS);

  // Start cleanup
  startRetention(DEFAULTS.CLEANUP_INTERVAL_MS);
  startDiskMonitor(DEFAULTS.DISK_CHECK_MS);

  // Password rotation check (on boot + hourly)
  checkAllPasswords(vault).catch(() => {});
  setInterval(() => checkAllPasswords(vault).catch(() => {}), DEFAULTS.PASSWORD_CHECK_MS);

  // Monitor disk — stop sync if critical
  setInterval(() => {
    const disk = checkDisk();
    if (disk.status === 'critical') {
      log.error('Disk critical — stopping all syncs');
      stopAllSyncs();
      setStatus('degraded');
    }
  }, DEFAULTS.DISK_CHECK_MS);

  setStatus('healthy');
  auditLog('relay.start', 'system', {
    sites: sites.length,
    dataTier,
    version: process.env.RELAY_VERSION || '1.0.0',
  });

  log.info(`Edge relay running — ${sites.length} site(s), tier ${dataTier}`);
}

// ── Graceful shutdown ────────────────────────────────────────────────

function shutdown(signal) {
  const log = createLogger('main');
  log.info(`Shutting down (${signal})`);

  auditLog('relay.stop', 'system', signal);

  stopAllSyncs();
  stopUplink();
  stopDownlink();
  stopHeartbeat();
  stopAnomalyDetector();
  stopRetention();
  stopDiskMonitor();
  stopAdminServer();
  closeVault();
  closeDb();
  closeLogger();

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle self-signed certs on Commander LAN devices
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
