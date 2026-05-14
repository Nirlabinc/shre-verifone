import { mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { createLogger } from "@shreai/sdk/logger";
import { createLiteCortexClient, createLiteEventBus } from "@shreai/sdk/lite";

const SERVICE_NAME = "verifone-commander";
const HEARTBEAT_INTERVAL_MS = Number(process.env.SHRE_HEARTBEAT_INTERVAL_MS || 30_000);

const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");
const queueDir = join(runtimeRoot, "queue");
const cortexPersistPath = join(queueDir, "shre-cortex-lite.json");

const tenantId = process.env.SHRE_TENANT_ID || "";
const app = process.env.SHRE_APP || "verifone_cstoresku";
const mode = process.env.SHRE_MODE || "read_only";
const storeId = process.env.SHRE_STORE_ID || "";
const env = process.env.SHRE_ENV || process.env.BUILD_CHANNEL || "local";
const bootstrapKey = process.env.SHRE_BOOTSTRAP_KEY || "";

let stopped = false;
let timer: NodeJS.Timeout | undefined;

async function main(): Promise<void> {
  await mkdir(queueDir, { recursive: true });
  await mkdir(join(runtimeRoot, "logs"), { recursive: true });

  const log = createLogger(SERVICE_NAME, { tenantId, app, mode, storeId, env });
  const cortex = createLiteCortexClient(SERVICE_NAME, { persistPath: cortexPersistPath });
  const events = createLiteEventBus(SERVICE_NAME, { logger: log });

  if (mode === "read_write" && !bootstrapKey) {
    log.warn("read_write mode without SHRE_BOOTSTRAP_KEY — server may reject write operations");
  }

  const nodeId = `${app}:${hostname()}:${process.pid}`;
  const registration = {
    nodeId,
    service: SERVICE_NAME,
    tenantId,
    app,
    mode,
    storeId,
    env,
    host: hostname(),
    pid: process.pid,
    sdkTier: "lite" as const,
    bootedAt: new Date().toISOString(),
  };

  await cortex.write("node_registration", registration);
  await events.publish("node.registered", "info", registration);
  log.info("node registered", { nodeId, tenantConfigured: Boolean(tenantId) });

  const beat = async () => {
    if (stopped) return;
    try {
      await events.publish("connector.heartbeat", "info", {
        nodeId,
        tenantId,
        app,
        mode,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      log.warn("heartbeat publish failed", { error: (err as Error).message });
    }
  };
  await beat();
  timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log.info("shre-connector shutting down", { signal });
    if (timer) clearInterval(timer);
    try {
      await events.publish("node.deregistered", "info", { nodeId, signal });
    } catch {
      // best-effort on shutdown
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });

  log.info("shre-connector running", { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
}

main().catch((err) => {
  console.error("shre-connector fatal:", err);
  process.exit(1);
});
