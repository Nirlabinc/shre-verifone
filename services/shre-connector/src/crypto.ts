// Field-level encryption helpers — must match dashboard-api/store.ts exactly.
// Encrypted values are stored as `encjson:v1:<base64(iv12||tag16||ciphertext)>`
// keyed by SHA-256 of either VERIFONE_SHRE_SECRET (env) or the .install-secret
// file in the runtime root. Both processes derive the same key, so the
// connector can decrypt rows the dashboard-api wrote.

import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const ENC_PREFIX = "encjson:v1:";

export function loadEncryptionKey(runtimeRoot: string): Buffer {
  const envSecret = process.env.VERIFONE_SHRE_SECRET;
  if (envSecret) return createHash("sha256").update(envSecret).digest();
  const secretPath = join(runtimeRoot, ".install-secret");
  if (!existsSync(secretPath)) {
    writeFileSync(secretPath, randomBytes(32).toString("hex"), { encoding: "utf8", mode: 0o600 });
  }
  try { chmodSync(secretPath, 0o600); } catch { /* best effort on Windows */ }
  return createHash("sha256").update(readFileSync(secretPath, "utf8").trim()).digest();
}

/** Returns the input unchanged if it doesn't start with the encryption prefix. */
export function decryptText(value: string, key: Buffer): string {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const raw = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
