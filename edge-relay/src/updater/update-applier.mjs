/**
 * Update Applier — download, verify SHA256, replace, restart
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, createWriteStream, readFileSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { getDataDir } from '../config.mjs';
import { checkForUpdate, clearUpdateInfo } from './update-checker.mjs';
import { backupCurrentBinary, rollback } from './rollback.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('update-applier');

/**
 * Download and apply update.
 * @returns {{ success: boolean, version?: string, error?: string }}
 */
export async function applyUpdate() {
  const update = checkForUpdate();
  if (!update.available) return { success: false, error: 'No update available' };

  const { version, url, sha256 } = update;
  if (!url) return { success: false, error: 'No download URL' };

  const dataDir = getDataDir();
  const tempDir = join(dataDir, 'tmp');
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  const ext = process.platform === 'win32' ? '.exe' : '';
  const tempPath = join(tempDir, `relay-${version}${ext}`);

  try {
    // 1. Download
    log.info(`Downloading update v${version}`, { url });
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) }); // 5min timeout
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

    const fileStream = createWriteStream(tempPath);
    await pipeline(res.body, fileStream);

    // 2. Verify SHA256
    if (sha256) {
      const hash = createHash('sha256').update(readFileSync(tempPath)).digest('hex');
      if (hash !== sha256) {
        unlinkSync(tempPath);
        throw new Error(`SHA256 mismatch: expected ${sha256}, got ${hash}`);
      }
      log.info('SHA256 verified');
    }

    // 3. Backup current binary
    backupCurrentBinary();

    // 4. Replace binary
    const currentBinary = process.argv[0];
    if (currentBinary && existsSync(currentBinary)) {
      // On Windows, can't replace running exe — schedule for restart
      if (process.platform === 'win32') {
        const pendingPath = join(dataDir, 'rollback', `pending-update${ext}`);
        renameSync(tempPath, pendingPath);
        clearUpdateInfo();
        log.info(`Update staged for restart: v${version}`);
        return { success: true, version, staged: true };
      }

      renameSync(tempPath, currentBinary);
    }

    clearUpdateInfo();
    log.info(`Update applied: v${version} — restarting...`);

    // 5. Restart process
    setTimeout(() => process.exit(0), 1000); // Let service manager restart us

    return { success: true, version };
  } catch (err) {
    log.error('Update failed', { error: err.message });
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* ignore */ }
    return { success: false, error: err.message };
  }
}
