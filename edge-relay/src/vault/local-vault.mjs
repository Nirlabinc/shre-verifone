/**
 * Local Vault — AES-256-GCM Envelope Encryption (SQLite)
 *
 * Pattern from shre-secrets/src/vault.ts adapted for edge relay.
 * - KEK derived via PBKDF2(machine-id + passphrase, salt, 100000)
 * - Each credential gets its own DEK (AES-256-GCM)
 * - Separate vault.db (not relay.db)
 */

import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'crypto';
import { join } from 'path';
import Database from 'better-sqlite3';
import { getDataDir, ensureDataDir } from '../config.mjs';
import { createLogger } from '../logger.mjs';

const log = createLogger('vault');
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 100_000;

let _vaultDb = null;
let _kek = null;

/**
 * Initialize vault with a passphrase (or machine-derived key).
 * @param {string} passphrase - User passphrase or machine ID
 */
export function initVault(passphrase) {
  ensureDataDir();
  const dbPath = join(getDataDir(), 'vault.db');
  _vaultDb = new Database(dbPath);
  _vaultDb.pragma('journal_mode = WAL');

  _vaultDb.exec(`
    CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      dek_enc BLOB NOT NULL,
      value_enc BLOB NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Derive KEK from passphrase + stored salt
  let salt = _vaultDb.prepare('SELECT value FROM vault_meta WHERE key = ?').get('salt')?.value;
  if (!salt) {
    salt = randomBytes(32);
    _vaultDb.prepare('INSERT INTO vault_meta (key, value) VALUES (?, ?)').run('salt', salt);
  }

  _kek = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  log.info('Vault initialized');
}

/**
 * Encrypt data with a fresh DEK, then wrap DEK with KEK.
 * Returns packed blob: [12 iv_dek][16 tag_dek][enc_dek][12 iv_data][16 tag_data][enc_data]
 */
function encrypt(plaintext) {
  if (!_kek) throw new Error('Vault not initialized');

  // Generate DEK
  const dek = randomBytes(32);

  // Encrypt data with DEK
  const ivData = randomBytes(IV_LEN);
  const cipherData = createCipheriv(ALGO, dek, ivData);
  const encData = Buffer.concat([
    cipherData.update(Buffer.from(plaintext, 'utf8')),
    cipherData.final(),
  ]);
  const tagData = cipherData.getAuthTag();

  // Wrap DEK with KEK
  const ivDek = randomBytes(IV_LEN);
  const cipherDek = createCipheriv(ALGO, _kek, ivDek);
  const encDek = Buffer.concat([cipherDek.update(dek), cipherDek.final()]);
  const tagDek = cipherDek.getAuthTag();

  // Zeroize DEK
  dek.fill(0);

  return {
    dekEnc: Buffer.concat([ivDek, tagDek, encDek]),
    valueEnc: Buffer.concat([ivData, tagData, encData]),
  };
}

/**
 * Decrypt: unwrap DEK with KEK, then decrypt data with DEK.
 */
function decrypt(dekEnc, valueEnc) {
  if (!_kek) throw new Error('Vault not initialized');

  // Unwrap DEK
  const ivDek = dekEnc.subarray(0, IV_LEN);
  const tagDek = dekEnc.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encDek = dekEnc.subarray(IV_LEN + TAG_LEN);

  const decipherDek = createDecipheriv(ALGO, _kek, ivDek);
  decipherDek.setAuthTag(tagDek);
  const dek = Buffer.concat([decipherDek.update(encDek), decipherDek.final()]);

  // Decrypt data
  const ivData = valueEnc.subarray(0, IV_LEN);
  const tagData = valueEnc.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encData = valueEnc.subarray(IV_LEN + TAG_LEN);

  const decipherData = createDecipheriv(ALGO, dek, ivData);
  decipherData.setAuthTag(tagData);
  const plaintext = Buffer.concat([decipherData.update(encData), decipherData.final()]).toString(
    'utf8',
  );

  // Zeroize DEK
  dek.fill(0);

  return plaintext;
}

/**
 * Store a secret.
 */
export function setSecret(name, value) {
  const { dekEnc, valueEnc } = encrypt(value);
  _vaultDb
    .prepare(
      `
    INSERT INTO secrets (name, dek_enc, value_enc) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET dek_enc = excluded.dek_enc, value_enc = excluded.value_enc, updated_at = datetime('now')
  `,
    )
    .run(name, dekEnc, valueEnc);
  log.info('Secret stored', { name });
}

/**
 * Retrieve a secret.
 */
export function getSecret(name) {
  const row = _vaultDb.prepare('SELECT dek_enc, value_enc FROM secrets WHERE name = ?').get(name);
  if (!row) return null;
  return decrypt(row.dek_enc, row.value_enc);
}

/**
 * Delete a secret.
 */
export function deleteSecret(name) {
  _vaultDb.prepare('DELETE FROM secrets WHERE name = ?').run(name);
}

/**
 * List all secret names.
 */
export function listSecrets() {
  return _vaultDb.prepare('SELECT name, created_at, updated_at FROM secrets').all();
}

/**
 * Close vault database.
 */
export function closeVault() {
  if (_vaultDb) {
    _vaultDb.close();
    _vaultDb = null;
  }
  if (_kek) {
    _kek.fill(0);
    _kek = null;
  }
}
