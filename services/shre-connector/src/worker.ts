import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";

const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");
const queuePath = join(runtimeRoot, "queue", "shre-events.jsonl");

interface ShreEvent {
  eventId: string;
  eventName: string;
  entityType?: string;
  entityId?: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

async function queueEvent(event: ShreEvent): Promise<void> {
  await mkdir(join(runtimeRoot, "queue"), { recursive: true });
  await appendFile(queuePath, `${JSON.stringify(event)}\n`, "utf8");
}

async function heartbeat(): Promise<void> {
  const event: ShreEvent = {
    eventId: randomUUID(),
    eventName: "connector_heartbeat",
    entityType: "service",
    entityId: "shre-connector",
    metadata: {
      host: hostname(),
      app: process.env.SHRE_APP || "verifone_cstoresku",
      tenantConfigured: Boolean(process.env.SHRE_TENANT_ID),
    },
    timestamp: new Date().toISOString(),
  };
  await queueEvent(event);
}

async function writeStatus(): Promise<void> {
  await mkdir(join(runtimeRoot, "queue"), { recursive: true });
  const queued = existsSync(queuePath) ? (await readFile(queuePath, "utf8")).split(/\r?\n/).filter(Boolean).length : 0;
  await appendFile(join(runtimeRoot, "logs", "shre-connector.log"), `${new Date().toISOString()} queued=${queued}\n`, "utf8");
}

async function main(): Promise<void> {
  await mkdir(join(runtimeRoot, "logs"), { recursive: true });
  await heartbeat();
  await writeStatus();
  console.log("shre-connector initialized. SDK transport wiring is the next implementation step.");
}

await main();
