/**
 * Embedded Structured Logger
 *
 * Lightweight logger for edge relay — no Redis dependency.
 * Outputs JSON lines to stdout + optional file rotation.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { join } from 'path';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per log file

let _stream = null;
let _logDir = null;
let _level = LEVELS.info;

/**
 * Initialize file logging.
 * @param {string} dataDir - Data directory path
 * @param {{ level?: string }} options
 */
export function initLogger(dataDir, options = {}) {
  _logDir = join(dataDir, 'logs');
  if (!existsSync(_logDir)) mkdirSync(_logDir, { recursive: true });
  _level = LEVELS[options.level || 'info'] ?? LEVELS.info;
  rotateIfNeeded();
  _stream = createWriteStream(join(_logDir, 'relay.log'), { flags: 'a' });
}

/**
 * Create a child logger with a component prefix.
 * @param {string} component
 * @returns {{ debug, info, warn, error }}
 */
export function createLogger(component) {
  return {
    debug: (msg, meta) => log('debug', component, msg, meta),
    info: (msg, meta) => log('info', component, msg, meta),
    warn: (msg, meta) => log('warn', component, msg, meta),
    error: (msg, meta) => log('error', component, msg, meta),
  };
}

function log(level, component, msg, meta) {
  if (LEVELS[level] < _level) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...meta,
  };

  const line = JSON.stringify(entry);

  // Always write to stdout
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }

  // Write to file if initialized
  if (_stream) {
    _stream.write(line + '\n');
  }
}

function rotateIfNeeded() {
  if (!_logDir) return;
  const logPath = join(_logDir, 'relay.log');
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_SIZE) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      renameSync(logPath, join(_logDir, `relay-${ts}.log`));
    }
  } catch {
    /* non-fatal */
  }
}

export function closeLogger() {
  if (_stream) {
    _stream.end();
    _stream = null;
  }
}
