// Per-install identity & AROS connection config.
//
//   .install-device-id  — single UUID line, generated on first boot, never changes.
//                         Survives hostname renames, PID changes, OS reinstalls
//                         (as long as the runtime dir is preserved).
//
//   aros-config.json    — written by the setup wizard / install script when the
//                         customer provides their Shre marketplace tenantId,
//                         a friendly deviceAlias, optional bootstrapKey, and
//                         optional storeId. Connector reads this at boot.
//
// Resolution order for each field:   env var  >  aros-config.json  >  hard default
// (Env wins so operators can override in a LaunchAgent/systemd unit without
//  editing the config file; the config file is the persistent install state.)

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, dirname } from "node:path";

export interface ArosInstallConfig {
  tenantId?: string;
  bootstrapKey?: string;
  storeId?: string;
  deviceAlias?: string;
  app?: string;
  mode?: "read_only" | "read_write";
}

export function loadOrCreateDeviceId(runtimeRoot: string): string {
  const path = join(runtimeRoot, ".install-device-id");
  if (existsSync(path)) {
    const id = readFileSync(path, "utf8").trim();
    if (id) return id;
  }
  mkdirSync(runtimeRoot, { recursive: true });
  const id = randomUUID();
  writeFileSync(path, id + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
  return id;
}

export function loadArosConfig(runtimeRoot: string): ArosInstallConfig {
  const path = join(runtimeRoot, "aros-config.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ArosInstallConfig;
    return {};
  } catch {
    return {};
  }
}

/** Write or merge keys into the aros-config.json. Called by the setup wizard /
 *  install scripts when the customer provides tenantId + alias + (optional) key. */
export function saveArosConfig(runtimeRoot: string, patch: ArosInstallConfig): ArosInstallConfig {
  const path = join(runtimeRoot, "aros-config.json");
  mkdirSync(dirname(path), { recursive: true });
  const current = loadArosConfig(runtimeRoot);
  const next: ArosInstallConfig = { ...current, ...patch };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
  return next;
}

/** Pick env var, fall back to config-file value, fall back to default. */
export function resolveField<T extends string>(
  envValue: string | undefined,
  configValue: T | undefined,
  fallback: T,
): T {
  if (envValue && envValue.length > 0) return envValue as T;
  if (configValue && (configValue as string).length > 0) return configValue;
  return fallback;
}

/** Friendly device label: explicit alias > hostname. */
export function resolveDeviceAlias(envValue: string | undefined, configValue: string | undefined): string {
  if (envValue && envValue.length > 0) return envValue;
  if (configValue && configValue.length > 0) return configValue;
  return hostname();
}
