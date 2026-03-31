/**
 * Update Checker — poll cloud for new relay versions
 */

import { getConfig, setConfig } from '../config.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('updater');

/**
 * Check if an update is available.
 * @returns {{ available: boolean, version?: string, url?: string, sha256?: string }}
 */
export function checkForUpdate() {
  const updateJson = getConfig('update_available');
  if (!updateJson) return { available: false };

  try {
    const update = JSON.parse(updateJson);
    const currentVersion = process.env.RELAY_VERSION || '1.0.0';

    if (update.version && update.version !== currentVersion) {
      return {
        available: true,
        version: update.version,
        url: update.downloadUrl,
        sha256: update.sha256,
        releaseNotes: update.releaseNotes,
      };
    }
  } catch {
    /* ignore parse errors */
  }

  return { available: false };
}

/**
 * Clear pending update info.
 */
export function clearUpdateInfo() {
  setConfig('update_available', '');
}

/**
 * Compare semantic versions.
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}
