import { mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { createLogger } from "@shreai/sdk/logger";
import { createLiteCortexClient, createLiteEventBus } from "@shreai/sdk/lite";

import { ArosClient, SDK_VERSION } from "./aros-client.js";
import { QueueDrain } from "./queue-drain.js";
import { loadEncryptionKey } from "./crypto.js";
import {
  loadArosConfig, loadOrCreateDeviceId, resolveField, resolveDeviceAlias,
} from "./install-config.js";

const SERVICE_NAME = "verifone-commander";
const HEARTBEAT_INTERVAL_MS = Number(process.env.SHRE_HEARTBEAT_INTERVAL_MS || 30_000);
const DRAIN_INTERVAL_MS = Number(process.env.SHRE_DRAIN_INTERVAL_MS || 10_000);
const CONFIG_REFRESH_MS = Number(process.env.SHRE_CONFIG_REFRESH_MS || 300_000);

const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");
const queueDir = join(runtimeRoot, "queue");
const cortexPersistPath = join(queueDir, "shre-cortex-lite.json");
const dbPath = process.env.SHRE_RUNTIME_DB || join(runtimeRoot, "runtime.sqlite");

// Resolution order for tenantId / app / mode / storeId / bootstrapKey / deviceAlias:
//   env var  >  aros-config.json  >  default
// aros-config.json is the persistent install state (written by setup wizard
// or install script). Env wins so operators can override per-deploy.
const installConfig = loadArosConfig(process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku"));
const tenantId = resolveField(process.env.SHRE_TENANT_ID, installConfig.tenantId, "");
const app = resolveField(process.env.SHRE_APP, installConfig.app, "verifone_commander_cstoresku");
const modeRaw = resolveField<"read_only" | "read_write">(
  process.env.SHRE_MODE as "read_only" | "read_write" | undefined,
  installConfig.mode,
  "read_only",
);
const mode = (modeRaw === "read_write" ? "read_write" : "read_only") as "read_only" | "read_write";
const storeId = resolveField(process.env.SHRE_STORE_ID, installConfig.storeId, "");
const userId = process.env.SHRE_USER_ID || "";
const role = process.env.SHRE_ROLE || "";
const env = process.env.SHRE_ENV || process.env.BUILD_CHANNEL || "local";
const bootstrapKey = resolveField(process.env.SHRE_BOOTSTRAP_KEY, installConfig.bootstrapKey, "");
const endpoint = process.env.SHRE_ENDPOINT || "https://apiauth.shre.ai";
const eventsEndpoint = process.env.SHRE_EVENTS_ENDPOINT || "https://events.shre.ai";
const deviceAlias = resolveDeviceAlias(process.env.SHRE_DEVICE_ALIAS, installConfig.deviceAlias);

let stopped = false;
let heartbeatTimer: NodeJS.Timeout | undefined;
let drainTimer: NodeJS.Timeout | undefined;
let configTimer: NodeJS.Timeout | undefined;

async function main(): Promise<void> {
  await mkdir(queueDir, { recursive: true });
  await mkdir(join(runtimeRoot, "logs"), { recursive: true });

  const deviceId = loadOrCreateDeviceId(runtimeRoot);
  const log = createLogger(SERVICE_NAME, { tenantId, app, mode, storeId, deviceId, deviceAlias, env });
  const cortex = createLiteCortexClient(SERVICE_NAME, { persistPath: cortexPersistPath });
  const events = createLiteEventBus(SERVICE_NAME, { logger: log });

  if (!tenantId) {
    log.warn("SHRE_TENANT_ID not set — events will not ship to AROS until configured");
  }
  if (mode === "read_write" && !bootstrapKey) {
    log.warn("read_write mode without SHRE_BOOTSTRAP_KEY — server may reject write operations");
  }

  // nodeId uses the stable deviceId so it survives PID/hostname churn.
  const nodeId = `${app}:${deviceId}`;
  const registration = {
    nodeId, service: SERVICE_NAME, tenantId, app, mode, storeId, env,
    deviceId, deviceAlias,
    host: hostname(), pid: process.pid, sdkTier: "lite" as const,
    arosEndpoint: endpoint, arosEventsEndpoint: eventsEndpoint,
    bootedAt: new Date().toISOString(),
  };
  await cortex.write("node_registration", registration);
  await events.publish("node.registered", "info", registration);
  log.info("node registered", { nodeId, tenantConfigured: Boolean(tenantId) });

  // AROS client + bootstrap (deferred — failures don't crash the worker)
  const aros = tenantId
    ? new ArosClient({
        endpoint, eventsEndpoint, tenantId, app, mode, storeId, userId, role,
        bootstrapKey, deviceId, deviceAlias, sdkVersion: SDK_VERSION, log,
      })
    : null;
  if (aros) {
    try { await aros.bootstrap(); }
    catch (err) {
      log.warn("aros bootstrap failed at boot — drain loop will retry", { error: (err as Error).message });
    }
    try { await aros.refreshConfig(); } catch { /* logged inside */ }
    // Send a connector-signed marker event so the Shre team has a clear data
    // point to verify against (independent of outbound_queue contents).
    const onlineEvent = {
      eventId: nodeId + ":" + Date.now(),
      eventName: "connector.online",
      entityType: "connector",
      entityId: nodeId,
      timestamp: new Date().toISOString(),
      metadata: {
        service: SERVICE_NAME, tenantId, app, mode, storeId, env,
        deviceId, deviceAlias,
        host: hostname(), pid: process.pid, sdkVersion: SDK_VERSION,
      },
    };
    try {
      const r = await aros.ship([onlineEvent]);
      log.info("connector.online shipped", {
        accepted: r.accepted, rejected: r.rejected,
        nextFlushSeconds: r.nextFlushSeconds, error: r.error,
      });
    } catch (err) {
      log.warn("connector.online ship failed", { error: (err as Error).message });
    }
  }

  // Queue drain — opens runtime.sqlite (WAL mode, shared with dashboard-api)
  // and decrypts payloads using the shared install-secret key.
  const drain = aros
    ? new QueueDrain({ dbPath, log, client: aros, encryptionKey: loadEncryptionKey(runtimeRoot) })
    : null;
  if (drain) {
    log.info("queue drain enabled", {
      dbPath, drainIntervalMs: DRAIN_INTERVAL_MS, pending: drain.countPending(),
    });
  }

  const beat = async () => {
    if (stopped) return;
    try {
      await events.publish("connector.heartbeat", "info", {
        nodeId, tenantId, app, mode, ts: new Date().toISOString(),
      });
    } catch (err) { log.warn("heartbeat publish failed", { error: (err as Error).message }); }
    if (aros) {
      const queued = drain ? drain.countPending() : 0;
      await aros.heartbeat(queued);
    }
  };
  await beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  let currentDrainMs = DRAIN_INTERVAL_MS;
  const drainTick = async () => {
    if (stopped || !drain) return;
    try {
      const r = await drain.drainOnce();
      if (r.shipped > 0 || r.failed > 0) {
        log.info("drain tick", r);
      }
      // Respect server-suggested flush cadence if it differs from current.
      if (r.nextFlushSeconds && r.nextFlushSeconds * 1000 !== currentDrainMs) {
        const newMs = r.nextFlushSeconds * 1000;
        log.info("adjusting drain interval per server hint", { fromMs: currentDrainMs, toMs: newMs });
        currentDrainMs = newMs;
        if (drainTimer) clearInterval(drainTimer);
        drainTimer = setInterval(drainTick, currentDrainMs);
      }
    } catch (err) {
      log.warn("drain tick failed", { error: (err as Error).message });
    }
  };
  if (drain) {
    void drainTick();
    drainTimer = setInterval(drainTick, currentDrainMs);
  }

  if (aros) {
    configTimer = setInterval(() => { void aros.refreshConfig(); }, CONFIG_REFRESH_MS);
  }

  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log.info("shre-connector shutting down", { signal });
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (drainTimer) clearInterval(drainTimer);
    if (configTimer) clearInterval(configTimer);
    if (drain) {
      try { await drain.drainOnce(); } catch { /* best effort */ }
      try { drain.close(); } catch { /* best effort */ }
    }
    try { await events.publish("node.deregistered", "info", { nodeId, signal }); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });

  log.info("shre-connector running", {
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    drainIntervalMs: DRAIN_INTERVAL_MS,
    arosEnabled: Boolean(aros),
  });
}

main().catch((err) => {
  console.error("shre-connector fatal:", err);
  process.exit(1);
});
