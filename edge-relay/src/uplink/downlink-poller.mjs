/**
 * Downlink Poller — GET commands, agent DNA, updates from cloud
 */

import { getCloudUrl, getRelayId, getApiKey, getDb, setConfig, DEFAULTS } from '../config.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('downlink');
const REQUEST_TIMEOUT_MS = 15_000;
const timers = [];

/**
 * Fetch from cloud endpoint.
 */
async function cloudGet(path) {
  const cloudUrl = getCloudUrl();
  const apiKey = getApiKey();
  const relayId = getRelayId();

  if (!apiKey || !relayId) return null;

  const url = `${cloudUrl}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'X-Relay-Id': relayId,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Cloud ${path} failed: HTTP ${res.status}`);
  }
  return await res.json();
}

/**
 * Poll for pending commands (config changes, manual sync, password update).
 */
async function pollCommands() {
  try {
    const data = await cloudGet('/v1/downlink/commands');
    if (!data?.commands?.length) return;

    for (const cmd of data.commands) {
      log.info('Received command', { type: cmd.type, id: cmd.id });
      await handleCommand(cmd);
    }
  } catch (err) {
    log.debug('Command poll failed', { error: err.message });
  }
}

/**
 * Poll for agent DNA updates (soul, memory, skills).
 */
async function pollAgentDna() {
  try {
    const data = await cloudGet('/v1/downlink/agent-dna');
    if (!data?.dna) return;

    // Store latest DNA in config for local reference
    setConfig('agent_dna_version', data.version || new Date().toISOString());
    setConfig('agent_dna', JSON.stringify(data.dna));
    log.info('Agent DNA updated', { version: data.version });
  } catch (err) {
    log.debug('DNA poll failed', { error: err.message });
  }
}

/**
 * Poll for relay software updates.
 */
async function pollUpdates() {
  try {
    const data = await cloudGet('/v1/downlink/updates');
    if (!data?.version) return;

    const currentVersion = process.env.RELAY_VERSION || '1.0.0';
    if (data.version === currentVersion) return;

    log.info('Update available', { current: currentVersion, available: data.version });
    setConfig('update_available', JSON.stringify(data));
  } catch (err) {
    log.debug('Update poll failed', { error: err.message });
  }
}

/**
 * Handle a command from cloud.
 */
async function handleCommand(cmd) {
  const db = getDb();

  switch (cmd.type) {
    case 'config_update':
      if (cmd.key && cmd.value !== undefined) {
        setConfig(cmd.key, cmd.value);
        log.info(`Config updated: ${cmd.key}`);
      }
      break;

    case 'manual_sync': {
      // Import dynamically to avoid circular deps
      const { triggerSync } = await import('../sync/sync-engine.mjs');
      const site = db.prepare('SELECT * FROM site_config WHERE site_id = ?').get(cmd.siteId);
      if (site) {
        const { getCredential } = await import('../vault/credential-store.mjs');
        const pass = getCredential(site.site_id);
        await triggerSync(site.site_id, { ip: site.commander_ip, user: site.username, pass });
      }
      break;
    }

    case 'password_update':
      if (cmd.siteId && cmd.password) {
        const { recordManualPasswordUpdate } = await import('../commander/password-rotation.mjs');
        const { setCredential } = await import('../vault/credential-store.mjs');
        recordManualPasswordUpdate(db, cmd.siteId, cmd.password, { setCredential });
        log.info(`Password updated via cloud command for ${cmd.siteId}`);
      }
      break;

    default:
      log.warn('Unknown command type', { type: cmd.type });
  }
}

/**
 * Start all downlink polling intervals.
 */
export function startDownlink() {
  timers.push(setInterval(pollCommands, DEFAULTS.DOWNLINK_COMMANDS_MS));
  timers.push(setInterval(pollAgentDna, DEFAULTS.DOWNLINK_DNA_MS));
  timers.push(setInterval(pollUpdates, DEFAULTS.DOWNLINK_UPDATES_MS));

  // Initial poll
  pollCommands();
  pollAgentDna();

  log.info('Downlink polling started');
}

export function stopDownlink() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}
