/**
 * Rollback — keep previous binary, auto-restore on failure
 */

import { existsSync, mkdirSync, copyFileSync, renameSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../config.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('rollback');

/**
 * Backup the current binary to rollback directory.
 */
export function backupCurrentBinary() {
  const dataDir = getDataDir();
  const rollbackDir = join(dataDir, 'rollback');
  if (!existsSync(rollbackDir)) mkdirSync(rollbackDir, { recursive: true });

  const currentBinary = process.argv[0];
  if (!currentBinary || !existsSync(currentBinary)) {
    log.warn('Cannot backup: binary path not found');
    return;
  }

  const ext = process.platform === 'win32' ? '.exe' : '';
  const backupPath = join(rollbackDir, `relay-prev${ext}`);

  // Keep only one backup
  copyFileSync(currentBinary, backupPath);
  log.info('Binary backed up', { path: backupPath });
}

/**
 * Rollback to previous binary.
 */
export function rollback() {
  const dataDir = getDataDir();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const backupPath = join(dataDir, 'rollback', `relay-prev${ext}`);

  if (!existsSync(backupPath)) {
    log.error('No backup binary found — cannot rollback');
    return false;
  }

  const currentBinary = process.argv[0];
  if (!currentBinary) {
    log.error('Cannot determine current binary path');
    return false;
  }

  try {
    renameSync(backupPath, currentBinary);
    log.info('Rollback complete — restarting...');
    setTimeout(() => process.exit(0), 1000);
    return true;
  } catch (err) {
    log.error('Rollback failed', { error: err.message });
    return false;
  }
}

/**
 * Health check — if startup fails within 60s of update, auto-rollback.
 */
export function setupHealthWatchdog(timeoutMs = 60_000) {
  const startTime = Date.now();

  setTimeout(() => {
    // If we're still running after timeout, update is healthy
    log.info('Post-update health check passed');
  }, timeoutMs);

  // On uncaught error within timeout, rollback
  const handler = (err) => {
    if (Date.now() - startTime < timeoutMs) {
      log.error('Startup failure after update — rolling back', { error: err.message });
      rollback();
    }
  };

  process.on('uncaughtException', handler);
  process.on('unhandledRejection', handler);

  // Remove handlers after watchdog period
  setTimeout(() => {
    process.removeListener('uncaughtException', handler);
    process.removeListener('unhandledRejection', handler);
  }, timeoutMs);
}
