import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname, platform, arch, totalmem, freemem, cpus } from "node:os";
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { RuntimeStore, type JsonObject, type JsonValue } from "./store.js";

const port = Number(process.env.PORT || 5480);
const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");
const connectorRegistryUrl = process.env.CONNECTOR_REGISTRY_URL || "https://connector.aros.live";
const uiRoot = resolve("apps/dashboard-ui");
let store: RuntimeStore;

async function ensureRuntime(): Promise<void> {
  await mkdir(join(runtimeRoot, "connections"), { recursive: true });
  await mkdir(join(runtimeRoot, "queue"), { recursive: true });
  await mkdir(join(runtimeRoot, "logs"), { recursive: true });
  await mkdir(join(runtimeRoot, "diagnostics"), { recursive: true });
}

async function requestBody(req: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) as JsonValue : {};
}

function sendJson(res: ServerResponse, statusCode: number, body: JsonValue): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { error: message });
}

function asObject(value: JsonValue): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function requireString(body: JsonObject, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function secretKey(): Buffer {
  const material = [
    process.env.VERIFONE_SHRE_SECRET || "",
    hostname(),
    homedir(),
    "verifone-shre-cstoresku-local-secret",
  ].join("|");
  return createHash("sha256").update(material).digest();
}

function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

function decryptSecret(value: string): string {
  if (!value.startsWith("enc:v1:")) return value;
  const raw = Buffer.from(value.slice("enc:v1:".length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function redactConnection(connection: JsonObject): JsonObject {
  const redacted: JsonObject = { ...connection };
  if (typeof redacted.password === "string" && redacted.password) redacted.password = "***";
  return redacted;
}

function classifyMessage(messageText: string): { intent: string; target: string; operation: string } {
  const text = messageText.toLowerCase();
  if (/\b(sales|revenue|gross|net|top items?|best sellers?)\b/.test(text)) {
    return { intent: "sales_query", target: "local-db", operation: "query_sales" };
  }
  if (/\b(sync|push|pull|update commander|send to commander)\b/.test(text)) {
    return { intent: "sync_command", target: "commander", operation: "sync" };
  }
  if (/\b(health|status|diagnostic|logs?|is it running)\b/.test(text)) {
    return { intent: "health_check", target: "diagnostics", operation: "inspect" };
  }
  return { intent: "general_question", target: "shre", operation: "answer" };
}

async function directorySize(path: string): Promise<{ files: number; bytes: number }> {
  if (!existsSync(path)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(child);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await stat(child)).size;
    }
  }
  return { files, bytes };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === "/api/health") {
    const storage = await directorySize(runtimeRoot);
    sendJson(res, 200, {
      ok: true,
      service: "dashboard-api",
      runtimeRoot,
      database: store.path(),
      host: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model || "unknown",
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
      },
      storage,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (path === "/api/profile") {
    if (req.method === "GET") {
      sendJson(res, 200, store.getJson("profile", "current", {}));
      return;
    }
    if (req.method === "POST") {
      const body = await requestBody(req);
      store.setJson("profile", "current", body);
      store.appendActivity("profile_saved", { hasStoreId: Boolean(asObject(body).storeId) });
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (path === "/api/onboarding") {
    if (req.method === "GET") {
      sendJson(res, 200, store.getJson("onboarding", "current", {
        completedSteps: [],
        currentStep: "profile",
        updatedAt: null,
      }));
      return;
    }
    if (req.method === "POST") {
      const body = asObject(await requestBody(req));
      const state = {
        completedSteps: Array.isArray(body.completedSteps) ? body.completedSteps : [],
        currentStep: typeof body.currentStep === "string" ? body.currentStep : "profile",
        updatedAt: new Date().toISOString(),
      };
      store.setJson("onboarding", "current", state);
      store.appendActivity("onboarding_updated", { currentStep: state.currentStep });
      sendJson(res, 200, state);
      return;
    }
  }

  if (path === "/api/verifone/status") {
    const connection = store.getJson<JsonObject>("connections", "verifone", {});
    sendJson(res, 200, {
      configured: Boolean(connection.commanderUrl && connection.username && connection.password),
      connection: redactConnection(connection),
      lastValidation: store.getJson("connections", "verifone-status", null),
    });
    return;
  }

  if (path === "/api/verifone/config" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const connection: JsonObject = {
        commanderUrl: requireString(body, "commanderUrl"),
        username: requireString(body, "username"),
        password: encryptSecret(requireString(body, "password")),
        applicationKey: typeof body.applicationKey === "string" ? body.applicationKey : "",
        updatedAt: new Date().toISOString(),
      };
      store.setJson("connections", "verifone", connection);
      store.appendActivity("verifone_config_saved", { commanderUrl: connection.commanderUrl });
      sendJson(res, 200, { ok: true, connection: redactConnection(connection) });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/verifone/validate" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const connection = store.getJson<JsonObject>("connections", "verifone", {});
    const configuredPassword = typeof connection.password === "string" ? decryptSecret(connection.password) : "";
    const ok = Boolean(connection.commanderUrl && connection.username && configuredPassword) && body.forceFailure !== true;
    const daysRemaining = typeof body.daysRemaining === "number" ? body.daysRemaining : null;
    const validation = {
      ok,
      status: ok ? "connected" : "failed",
      checkedAt: new Date().toISOString(),
      message: ok ? "Local validation passed. Live Commander validation is the next integration step." : "Validation failed.",
      daysRemaining,
    };
    store.setJson("connections", "verifone-status", validation);
    if (daysRemaining !== null) {
      store.setJson("connections", "password-status", {
        state: daysRemaining <= 0 ? "expired" : daysRemaining <= 15 ? "expiring" : "valid",
        daysRemaining,
        autoResetLastAttempt: null,
        userActionRequired: daysRemaining <= 0,
        updatedAt: new Date().toISOString(),
      });
    }
    store.appendActivity("verifone_connection_validated", { ok, daysRemaining });
    sendJson(res, ok ? 200 : 503, validation);
    return;
  }

  if (path === "/api/password/status") {
    sendJson(res, 200, store.getJson("connections", "password-status", {
      state: "unknown",
      daysRemaining: null,
      autoResetLastAttempt: null,
      userActionRequired: false,
    }));
    return;
  }

  if (path === "/api/password/auto-reset" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const failed = body.forceFailure === true;
    const status = failed ? {
      state: "auto_reset_failed",
      daysRemaining: typeof body.daysRemaining === "number" ? body.daysRemaining : null,
      autoResetLastAttempt: new Date().toISOString(),
      userActionRequired: true,
      message: "Automatic reset failed. Manual password update is required.",
    } : {
      state: "auto_reset_succeeded",
      daysRemaining: 90,
      autoResetLastAttempt: new Date().toISOString(),
      userActionRequired: false,
      message: "Automatic reset completed locally. Live Commander password change is the next integration step.",
    };
    store.setJson("connections", "password-status", status);
    store.appendActivity(failed ? "password_auto_reset_failed" : "password_auto_reset_succeeded", {
      userActionRequired: status.userActionRequired,
    });
    sendJson(res, failed ? 409 : 200, status);
    return;
  }

  if (path === "/api/password/manual-update" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const newPassword = requireString(body, "newPassword");
      const connection = store.getJson<JsonObject>("connections", "verifone", {});
      if (!connection.commanderUrl || !connection.username) {
        badRequest(res, "Verifone connection must be configured before password update");
        return;
      }
      connection.password = encryptSecret(newPassword);
      connection.updatedAt = new Date().toISOString();
      store.setJson("connections", "verifone", connection);
      const status = {
        state: "valid",
        daysRemaining: typeof body.daysRemaining === "number" ? body.daysRemaining : null,
        autoResetLastAttempt: null,
        userActionRequired: false,
        updatedAt: new Date().toISOString(),
      };
      store.setJson("connections", "password-status", status);
      store.appendActivity("password_manual_update_saved", { daysRemaining: status.daysRemaining });
      sendJson(res, 200, status);
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/queue") {
    sendJson(res, 200, store.queueSummary());
    return;
  }

  if (path === "/api/queue/enqueue" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const item = store.enqueue({
        target: requireString(body, "target"),
        entityType: requireString(body, "entityType"),
        entityId: typeof body.entityId === "string" ? body.entityId : "",
        operation: requireString(body, "operation"),
        payload: asObject(body.payload || {}),
      });
      store.appendActivity("queue_item_enqueued", { id: item.id, target: item.target });
      sendJson(res, 201, item);
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/queue/replay" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const result = store.replayQueue(body.forceFailure === true);
    const items = Array.isArray(result.items) ? result.items : [];
    store.appendActivity("offline_queue_replayed", {
      failed: items.filter((item) => asObject(item).status === "failed").length,
      completed: items.filter((item) => asObject(item).status === "completed").length,
    });
    sendJson(res, 200, result);
    return;
  }

  if (path === "/api/commander/lease/status") {
    sendJson(res, 200, store.commanderLeaseStatus());
    return;
  }

  if (path === "/api/commander/lease/acquire" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const owner = typeof body.owner === "string" && body.owner.trim() ? body.owner.trim() : "dashboard-api";
    const ttlSeconds = typeof body.ttlSeconds === "number" ? body.ttlSeconds : 120;
    const lease = store.acquireCommanderLease(owner, ttlSeconds);
    store.appendActivity(lease.acquired ? "commander_lease_acquired" : "commander_lease_blocked", {
      owner,
      activeOwner: lease.owner,
    });
    sendJson(res, lease.acquired ? 200 : 423, lease);
    return;
  }

  if (path === "/api/commander/lease/release" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const owner = typeof body.owner === "string" && body.owner.trim() ? body.owner.trim() : "dashboard-api";
    const release = store.releaseCommanderLease(owner);
    store.appendActivity(release.released ? "commander_lease_released" : "commander_lease_release_blocked", {
      owner,
      activeOwner: release.owner,
    });
    sendJson(res, release.released ? 200 : 409, release);
    return;
  }

  if (path === "/api/diagnostics") {
    sendJson(res, 200, {
      runtimeRoot,
      health: "/api/health",
      profile: "/api/profile",
      verifone: "/api/verifone/status",
      password: "/api/password/status",
      queue: "/api/queue",
      connector: "/api/connector/status",
      messages: "/api/messages/inbound",
    });
    return;
  }

  if (path === "/api/diagnostics/bundle" && req.method === "POST") {
    const storage = await directorySize(runtimeRoot);
    const bundle = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      runtimeRoot,
      host: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model || "unknown",
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
      },
      storage,
      profile: store.getJson("profile", "current", {}),
      verifoneStatus: store.getJson("connections", "verifone-status", null),
      passwordStatus: store.getJson("connections", "password-status", null),
      queue: store.queueSummary(),
      activity: store.activity(200),
    };
    const saved = store.saveDiagnosticBundle(bundle);
    store.appendActivity("diagnostics_bundle_created", { id: bundle.id });
    sendJson(res, 201, saved);
    return;
  }

  if (path === "/api/activity") {
    sendJson(res, 200, { events: store.activity(100) });
    return;
  }

  if (path === "/api/connector/status") {
    sendJson(res, 200, store.connectorStatus());
    return;
  }

  if (path === "/api/connector/activate" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const registration = store.saveConnectorRegistration({
      connectorId: typeof body.connectorId === "string" ? body.connectorId : "verifone-commander",
      connectorName: typeof body.connectorName === "string" ? body.connectorName : "Verifone Commander",
      tenantId: typeof body.tenantId === "string" ? body.tenantId : "",
      storeId: typeof body.storeId === "string" ? body.storeId : "",
      app: typeof body.app === "string" ? body.app : "verifone_cstoresku",
      mode: typeof body.mode === "string" ? body.mode : "local_first",
      cloudRelayEnabled: body.cloudRelayEnabled === true,
      registryUrl: typeof body.registryUrl === "string" ? body.registryUrl : connectorRegistryUrl,
      relatedConnectors: Array.isArray(body.relatedConnectors) ? body.relatedConnectors : ["rapidrms-api"],
    });
    store.appendActivity("connector_activated", {
      connectorId: registration.connectorId,
      tenantConfigured: Boolean(registration.tenantId),
      cloudRelayEnabled: registration.cloudRelayEnabled === true,
    });
    sendJson(res, 200, registration);
    return;
  }

  if (path === "/api/connectors/catalog") {
    sendJson(res, 200, store.connectorCatalog());
    return;
  }

  if (path === "/api/messages/inbound" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const messageText = requireString(body, "messageText");
      const source = typeof body.source === "string" ? body.source : "unknown";
      const registration = store.connectorStatus();
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : String(registration.tenantId || "");
      const storeId = typeof body.storeId === "string" ? body.storeId : String(registration.storeId || "");
      const userId = typeof body.userId === "string" ? body.userId : "";
      const classification = classifyMessage(messageText);
      const queueItem = store.enqueue({
        target: classification.target,
        entityType: "message",
        entityId: typeof body.messageId === "string" ? body.messageId : randomUUID(),
        operation: classification.operation,
        payload: {
          source,
          tenantId,
          storeId,
          userId,
          messageText,
          intent: classification.intent,
          receivedAt: new Date().toISOString(),
        },
      });
      const response = {
        accepted: true,
        mode: registration.cloudRelayEnabled ? "cloud_relay" : "local_first",
        intent: classification.intent,
        queuedOperation: queueItem.id,
        message: "Message accepted locally and queued for processing.",
      };
      const audit = store.saveChatAudit({
        source,
        tenantId,
        storeId,
        userId,
        messageText,
        intent: classification.intent,
        status: "queued",
        response,
      });
      store.appendActivity("inbound_message_queued", {
        source,
        intent: classification.intent,
        queueId: queueItem.id,
      });
      sendJson(res, 202, { ...response, auditId: audit.id });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/messages/audit") {
    sendJson(res, 200, { messages: store.chatAudit(100) });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveUi(res: ServerResponse): Promise<void> {
  const html = await readFile(join(uiRoot, "index.html"), "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function main(): Promise<void> {
  await ensureRuntime();
  store = new RuntimeStore(runtimeRoot, { connectorRegistryUrl });
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    handleRequest(req, res, url.pathname).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.listen(port, () => {
    console.log(`dashboard-api listening on http://localhost:${port}`);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path.startsWith("/api/")) {
    await handleApi(req, res, path);
    return;
  }
  await serveUi(res);
}

await main();
