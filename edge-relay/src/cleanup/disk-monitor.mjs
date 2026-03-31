/**
 * Disk Monitor — alert on low disk space, emergency cleanup
 *
 * Runs every 10 minutes:
 * - < 500MB → warning via uplink heartbeat
 * - < 100MB → emergency: halve all retention periods
 * - < 50MB  → critical: stop sync to prevent filling disk
 */

import { execSync } from 'child_process';
import { platform } from 'os';
import { getDataDir, DEFAULTS } from '../config.mjs';
import { runRetention } from './retention-manager.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('disk-monitor');
let _timer = null;

/**
 * Get free disk space in MB for the data directory.
 */
export function getDiskFreeMB() {
  try {
    const dataDir = getDataDir();
    if (platform() === 'win32') {
      const drive = dataDir.slice(0, 2); // e.g. "C:"
      const output = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`, {
        encoding: 'utf8',
      });
      const match = output.match(/FreeSpace=(\d+)/);
      return match ? parseInt(match[1]) / (1024 * 1024) : null;
    } else {
      const output = execSync(`df -BM "${dataDir}" | tail -1 | awk '{print $4}'`, {
        encoding: 'utf8',
      });
      return parseInt(output.replace('M', ''));
    }
  } catch (err) {
    log.warn('Disk check failed', { error: err.message });
    return null;
  }
}

/**
 * Run disk check and take action if needed.
 */
export function checkDisk() {
  const freeMB = getDiskFreeMB();
  if (freeMB === null) return { status: 'unknown', freeMB: null };

  // Expose to heartbeat
  global.__diskFreeMB = freeMB;

  if (freeMB < 50) {
    log.error(`CRITICAL: Only ${freeMB}MB free — stopping sync`);
    // Stop sync will be handled by main.mjs checking this status
    runRetention({ emergency: true });
    return { status: 'critical', freeMB, action: 'sync_stopped' };
  }

  if (freeMB < 100) {
    log.warn(`Emergency: Only ${freeMB}MB free — halving retention`);
    runRetention({ emergency: true });
    return { status: 'emergency', freeMB, action: 'retention_halved' };
  }

  if (freeMB < 500) {
    log.warn(`Low disk: ${freeMB}MB free`);
    return { status: 'warning', freeMB };
  }

  return { status: 'ok', freeMB };
}

/**
 * Start periodic disk monitoring.
 */
export function startDiskMonitor(intervalMs) {
  _timer = setInterval(checkDisk, intervalMs || DEFAULTS.DISK_CHECK_MS);
  checkDisk(); // Initial check
  log.info('Disk monitor started');
}

export function stopDiskMonitor() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
