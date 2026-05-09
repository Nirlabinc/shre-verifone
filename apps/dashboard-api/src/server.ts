import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { appendFile, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname, platform, arch, totalmem, freemem, cpus } from "node:os";
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";

const port = Number(process.env.PORT || 5480);
const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");
const uiRoot = resolve("apps/dashboard-ui");

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

async function ensureRuntime(): Promise<void> {
  await mkdir(join(runtimeRoot, "connections"), { recursive: true });
  await mkdir(join(runtimeRoot, "queue"), { recursive: true });
  await mkdir(join(runtimeRoot, "logs"), { recursive: true });
  await mkdir(join(runtimeRoot, "diagnostics"), { recursive: true });
}

async function readJson<T extends JsonValue>(relativePath: string, fallback: T): Promise<T> {
  const path = join(runtimeRoot, relativePath);
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(relativePath: string, value: JsonValue): Promise<void> {
  const path = join(runtimeRoot, relativePath);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendActivity(eventName: string, metadata: JsonObject = {}): Promise<void> {
  await mkdir(join(runtimeRoot, "logs"), { recursive: true });
  const event = {
    id: randomUUID(),
    eventName,
    metadata,
    timestamp: new Date().toISOString(),
  };
  await appendFile(join(runtimeRoot, "logs", "activity.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

async function readActivity(limit = 100): Promise<JsonValue[]> {
  const path = join(runtimeRoot, "logs", "activity.jsonl");
  if (!existsSync(path)) return [];
  const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line) as JsonValue);
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
      sendJson(res, 200, await readJson("profile.json", {}));
      return;
    }
    if (req.method === "POST") {
      const body = await requestBody(req);
      await writeJson("profile.json", body);
      await appendActivity("profile_saved", { hasStoreId: Boolean(asObject(body).storeId) });
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (path === "/api/onboarding") {
    if (req.method === "GET") {
      sendJson(res, 200, await readJson("onboarding.json", {
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
      await writeJson("onboarding.json", state);
      await appendActivity("onboarding_updated", { currentStep: state.currentStep });
      sendJson(res, 200, state);
      return;
    }
  }

  if (path === "/api/verifone/status") {
    const connection = await readJson<JsonObject>("connections/verifone.json", {});
    sendJson(res, 200, {
      configured: existsSync(join(runtimeRoot, "connections", "verifone.json")),
      connection: redactConnection(connection),
      lastValidation: await readJson("connections/verifone-status.json", null),
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
      await writeJson("connections/verifone.json", connection);
      await appendActivity("verifone_config_saved", { commanderUrl: connection.commanderUrl });
      sendJson(res, 200, { ok: true, connection: redactConnection(connection) });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/verifone/validate" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const connection = await readJson<JsonObject>("connections/verifone.json", {});
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
    await writeJson("connections/verifone-status.json", validation);
    if (daysRemaining !== null) {
      await writeJson("connections/password-status.json", {
        state: daysRemaining <= 0 ? "expired" : daysRemaining <= 15 ? "expiring" : "valid",
        daysRemaining,
        autoResetLastAttempt: null,
        userActionRequired: daysRemaining <= 0,
        updatedAt: new Date().toISOString(),
      });
    }
    await appendActivity("verifone_connection_validated", { ok, daysRemaining });
    sendJson(res, ok ? 200 : 503, validation);
    return;
  }

  if (path === "/api/password/status") {
    sendJson(res, 200, await readJson("connections/password-status.json", {
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
    await writeJson("connections/password-status.json", status);
    await appendActivity(failed ? "password_auto_reset_failed" : "password_auto_reset_succeeded", {
      userActionRequired: status.userActionRequired,
    });
    sendJson(res, failed ? 409 : 200, status);
    return;
  }

  if (path === "/api/password/manual-update" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const newPassword = requireString(body, "newPassword");
      const connection = await readJson<JsonObject>("connections/verifone.json", {});
      if (!connection.commanderUrl || !connection.username) {
        badRequest(res, "Verifone connection must be configured before password update");
        return;
      }
      connection.password = encryptSecret(newPassword);
      connection.updatedAt = new Date().toISOString();
      await writeJson("connections/verifone.json", connection);
      const status = {
        state: "valid",
        daysRemaining: typeof body.daysRemaining === "number" ? body.daysRemaining : null,
        autoResetLastAttempt: null,
        userActionRequired: false,
        updatedAt: new Date().toISOString(),
      };
      await writeJson("connections/password-status.json", status);
      await appendActivity("password_manual_update_saved", { daysRemaining: status.daysRemaining });
      sendJson(res, 200, status);
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/queue") {
    const items = await readJson<JsonValue[]>("queue/items.json", []);
    const queueStatus = await readJson<JsonObject>("queue/status.json", {});
    const status = {
      pending: items.filter((item) => asObject(item).status === "pending").length,
      failed: items.filter((item) => asObject(item).status === "failed").length,
      completed: items.filter((item) => asObject(item).status === "completed").length,
      lastReplayAt: queueStatus.lastReplayAt || null,
      lastError: queueStatus.lastError || null,
      items,
    };
    sendJson(res, 200, status);
    return;
  }

  if (path === "/api/queue/enqueue" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const items = await readJson<JsonValue[]>("queue/items.json", []);
      const now = new Date().toISOString();
      const item: JsonObject = {
        id: randomUUID(),
        target: requireString(body, "target"),
        entityType: requireString(body, "entityType"),
        entityId: typeof body.entityId === "string" ? body.entityId : "",
        operation: requireString(body, "operation"),
        payload: asObject(body.payload || {}),
        status: "pending",
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      items.push(item);
      await writeJson("queue/items.json", items);
      await appendActivity("queue_item_enqueued", { id: item.id, target: item.target });
      sendJson(res, 201, item);
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/queue/replay" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const items = await readJson<JsonValue[]>("queue/items.json", []);
    const now = new Date().toISOString();
    const replayed = items.map((item) => {
      const current = asObject(item);
      if (current.status !== "pending") return current;
      const shouldFail = body.forceFailure === true;
      return {
        ...current,
        status: shouldFail ? "failed" : "completed",
        attemptCount: Number(current.attemptCount || 0) + 1,
        lastError: shouldFail ? "Replay forced to fail by test/operator request" : null,
        updatedAt: now,
      };
    });
    const failed = replayed.filter((item) => item.status === "failed").length;
    const status = {
      lastReplayAt: now,
      lastError: failed > 0 ? "One or more queue items failed replay" : null,
    };
    await writeJson("queue/items.json", replayed);
    await writeJson("queue/status.json", status);
    await appendActivity("offline_queue_replayed", { failed, completed: replayed.filter((item) => item.status === "completed").length });
    sendJson(res, 200, { ...status, items: replayed });
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
      profile: await readJson("profile.json", {}),
      verifoneStatus: await readJson("connections/verifone-status.json", null),
      passwordStatus: await readJson("connections/password-status.json", null),
      queue: await readJson("queue/items.json", []),
      activity: await readActivity(200),
    };
    const relativePath = `diagnostics/bundle-${bundle.id}.json`;
    await writeJson(relativePath, bundle);
    await appendActivity("diagnostics_bundle_created", { id: bundle.id });
    sendJson(res, 201, { ok: true, id: bundle.id, path: join(runtimeRoot, relativePath) });
    return;
  }

  if (path === "/api/activity") {
    sendJson(res, 200, { events: await readActivity(100) });
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
