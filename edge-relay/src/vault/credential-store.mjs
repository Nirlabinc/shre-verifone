/**
 * Credential Store — Commander passwords encrypted at rest
 *
 * Thin wrapper around local-vault for Commander credential management.
 */

import { getSecret, setSecret, deleteSecret, listSecrets } from './local-vault.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('credential-store');
const PREFIX = 'commander-pwd:';

/**
 * Store Commander password for a site.
 */
export function setCredential(siteId, password) {
  setSecret(`${PREFIX}${siteId}`, password);
  log.info('Credential stored', { siteId });
}

/**
 * Retrieve Commander password for a site.
 */
export function getCredential(siteId) {
  return getSecret(`${PREFIX}${siteId}`);
}

/**
 * Delete Commander password for a site.
 */
export function deleteCredential(siteId) {
  deleteSecret(`${PREFIX}${siteId}`);
  log.info('Credential deleted', { siteId });
}

/**
 * List all stored credential site IDs.
 */
export function listCredentials() {
  return listSecrets()
    .filter(s => s.name.startsWith(PREFIX))
    .map(s => ({
      siteId: s.name.slice(PREFIX.length),
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }));
}

/**
 * Get vault interface for password-rotation module.
 */
export function getVaultInterface() {
  return { getCredential, setCredential, deleteCredential };
}
