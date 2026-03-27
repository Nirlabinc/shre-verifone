/**
 * Edge Relay Configuration — SQLite-backed
 *
 * Stores all relay config in relay.db `relay_config` table.
 * Falls back to environment variables and sensible defaults.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { platform, homedir } from 'os';
import Database from 'better-sqlite3';

// ── Data directory ───────────────────────────────────────────────────

function resolveDataDir() {
  if (process.env.RELAY_DATA_DIR) return process.env.RELAY_DATA_DIR;
  if (platform() === 'win32') return join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'VerifoneEdgeRelay');
  return '/var/lib/verifone-edge-relay';
}

const DATA_DIR = resolveDataDir();

export function getDataDir() { return DATA_DIR; }

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

// ── Database initialization ──────────────────────────────────────────

let _db = null;

export function getDb() {
  if (_db) return _db;
  ensureDataDir();
  _db = new Database(join(DATA_DIR, 'relay.db'));
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  initSchema(_db);
  return _db;
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_config (
      site_id TEXT PRIMARY KEY,
      site_name TEXT,
      commander_ip TEXT NOT NULL,
      username TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      sync_interval_ms INTEGER DEFAULT 300000,
      password_set_at TEXT,
      password_expires_at TEXT,
      password_rotation_failures INTEGER DEFAULT 0,
      password_auto_rotated_at TEXT,
      password_user_notified_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_ledger (
      site_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (site_id, endpoint)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      report_type TEXT NOT NULL,
      report_date TEXT NOT NULL,
      period_type INTEGER NOT NULL,
      raw_data TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now')),
      uploaded_at TEXT,
      UNIQUE(site_id, report_type, report_date, period_type)
    );

    CREATE TABLE IF NOT EXISTS transaction_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      period_file TEXT NOT NULL,
      report_date TEXT,
      raw_data TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now')),
      uploaded_at TEXT,
      UNIQUE(site_id, period_file)
    );

    CREATE TABLE IF NOT EXISTS uplink_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      sent_at TEXT,
      attempts INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS relay_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_rotation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      action TEXT NOT NULL,
      days_remaining INTEGER,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      direction TEXT NOT NULL,
      target TEXT,
      method TEXT,
      path TEXT,
      status INTEGER,
      duration_ms INTEGER,
      request_size INTEGER,
      response_size INTEGER,
      error TEXT,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts);

    CREATE TABLE IF NOT EXISTS audit_chain (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      event_type TEXT NOT NULL,
      actor TEXT,
      detail TEXT,
      prev_hmac TEXT,
      hmac TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_chain(ts);

    CREATE TABLE IF NOT EXISTS anomaly_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      rule TEXT NOT NULL,
      severity TEXT NOT NULL,
      detail TEXT,
      acknowledged INTEGER DEFAULT 0
    );
  `);
}

// ── Config getters/setters ───────────────────────────────────────────

export function getConfig(key, fallback = null) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM relay_config WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setConfig(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO relay_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function getAllConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM relay_config').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ── Defaults ─────────────────────────────────────────────────────────

export const DEFAULTS = {
  ADMIN_PORT: 18464,
  SYNC_INTERVAL_MS: 300_000,
  UPLINK_HEARTBEAT_MS: 5 * 60 * 1000,
  UPLINK_METRICS_MS: 15 * 60 * 1000,
  UPLINK_TRAINING_MS: 60 * 60 * 1000,
  UPLINK_TRANSACTIONS_MS: 4 * 60 * 60 * 1000,
  UPLINK_ACTIVITY_MS: 60 * 60 * 1000,
  DOWNLINK_COMMANDS_MS: 5 * 60 * 1000,
  DOWNLINK_DNA_MS: 60 * 60 * 1000,
  DOWNLINK_UPDATES_MS: 4 * 60 * 60 * 1000,
  CLEANUP_INTERVAL_MS: 60 * 60 * 1000,
  DISK_CHECK_MS: 10 * 60 * 1000,
  ANOMALY_CHECK_MS: 5 * 60 * 1000,
  PASSWORD_CHECK_MS: 60 * 60 * 1000,
  RETENTION_LOGS_DAYS: 14,
  RETENTION_ACTIVITY_DAYS: 30,
  RETENTION_REPORTS_DAYS: 90,
  RETENTION_TRANSACTIONS_DAYS: 90,
  RETENTION_WAL_DAYS: 7,
  RETENTION_AUDIT_DAYS: 365,
  DATA_TIER: 2, // 1=metrics only, 2=+skills/training, 3=+transactions
};

export function getCloudUrl() {
  return getConfig('cloud_url', process.env.RELAY_CLOUD_URL || 'https://chat.nirtek.net');
}

export function getRelayId() {
  return getConfig('relay_id', null);
}

export function getApiKey() {
  return getConfig('api_key', null);
}
