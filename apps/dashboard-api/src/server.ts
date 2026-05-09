import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { chmod, readFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname, platform, arch, totalmem, freemem, cpus } from "node:os";
import { createHash, createHmac, randomBytes, randomUUID, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from "node:crypto";
import { RuntimeStore, type JsonObject, type JsonValue } from "./store.js";

const port = Number(process.env.PORT || 5480);
const host = process.env.HOST || "127.0.0.1";
const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");
const connectorRegistryUrl = process.env.CONNECTOR_REGISTRY_URL || "https://connector.aros.live";
const connectorSharedSecret = process.env.CONNECTOR_SHARED_SECRET || "";
const localBaseUrlOverride = process.env.LOCAL_BASE_URL || "";
const localAdminToken = process.env.LOCAL_ADMIN_TOKEN || "";
const shreAuthValidateUrl = process.env.SHRE_AUTH_VALIDATE_URL || "";
const shreCostEndpoint = process.env.SHRE_COST_ENDPOINT || "";
const uiRoot = resolve("apps/dashboard-ui");
let store: RuntimeStore;

async function ensureRuntime(): Promise<void> {
  await mkdir(join(runtimeRoot, "connections"), { recursive: true });
  await mkdir(join(runtimeRoot, "queue"), { recursive: true });
  await mkdir(join(runtimeRoot, "logs"), { recursive: true });
  await mkdir(join(runtimeRoot, "diagnostics"), { recursive: true });
  await secureRuntimePath(runtimeRoot, 0o700);
  await Promise.all([
    secureRuntimePath(join(runtimeRoot, "connections"), 0o700),
    secureRuntimePath(join(runtimeRoot, "queue"), 0o700),
    secureRuntimePath(join(runtimeRoot, "logs"), 0o700),
    secureRuntimePath(join(runtimeRoot, "diagnostics"), 0o700),
  ]);
}

async function secureRuntimePath(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // Best effort on Windows and filesystems that do not support POSIX modes.
  }
}

async function requestBody(req: IncomingMessage): Promise<JsonValue> {
  const text = await requestText(req);
  return text ? JSON.parse(text) as JsonValue : {};
}

async function requestText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  for (const chunk of chunks) bytes += chunk.byteLength;
  if (bytes > 1_000_000) throw new Error("Request body too large");
  return Buffer.concat(chunks).toString("utf8").trim();
}

function sendJson(res: ServerResponse, statusCode: number, body: JsonValue): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body, null, 2));
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { error: message });
}

function isMutating(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function enforceJsonRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isMutating(req.method)) return true;
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "application/json content type is required" });
    return false;
  }
  return true;
}

function localOrigins(req: IncomingMessage): Set<string> {
  const hostHeader = String(req.headers.host || `localhost:${port}`);
  return new Set([
    `http://${hostHeader}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://cstoresku:${port}`,
    `http://cstoresku.local:${port}`,
  ]);
}

function enforceLocalOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isMutating(req.method)) return true;
  const origin = String(req.headers.origin || "");
  if (origin && !localOrigins(req).has(origin)) {
    sendJson(res, 403, { error: "Cross-origin local API request blocked" });
    return false;
  }
  return true;
}

function enforceLocalAdmin(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (path.startsWith("/api/auth/")) return true;
  if (!localAdminToken) return true;
  if (path === "/api/health" || path === "/api/connector/manifest" || path === "/api/messages/inbound") return true;
  if (validSession(req)) return true;
  const provided = String(req.headers["x-local-admin-token"] || "");
  const expected = Buffer.from(localAdminToken);
  const actual = Buffer.from(provided);
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) return true;
  sendJson(res, 401, { error: "Local admin token required" });
  return false;
}

function hashSecret(secret: string, salt = randomBytes(16).toString("hex")): JsonObject {
  const hash = scryptSync(secret, salt, 32).toString("hex");
  return { salt, hash, algorithm: "scrypt" };
}

function verifySecret(secret: string, record: JsonObject): boolean {
  if (typeof record.salt !== "string" || typeof record.hash !== "string") return false;
  const actual = Buffer.from(String(hashSecret(secret, record.salt).hash), "hex");
  const expected = Buffer.from(record.hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function authState(): JsonObject {
  return store.getJson<JsonObject>("auth", "local-login", {
    configured: false,
    secretHash: null,
    remoteValidation: {
      state: "not_configured",
      lastCheckedAt: null,
      message: "Remote validation endpoint is not configured.",
    },
  });
}

function sessionState(): JsonObject {
  return store.getJson<JsonObject>("auth", "sessions", {});
}

function validSession(req: IncomingMessage): boolean {
  const token = String(req.headers["x-local-session"] || "");
  if (!token) return false;
  const sessions = sessionState();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const session = asObject(sessions[tokenHash] || null);
  return typeof session.expiresAt === "string" && session.expiresAt > new Date().toISOString();
}

function createSession(): JsonObject {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const sessions = sessionState();
  sessions[tokenHash] = { expiresAt, createdAt: new Date().toISOString() };
  store.setJson("auth", "sessions", sessions);
  return { token, expiresAt };
}

async function validateLoginRemote(reason: string): Promise<void> {
  const state = authState();
  if (!shreAuthValidateUrl || state.configured !== true) return;
  const connector = store.connectorStatus();
  try {
    const response = await fetch(shreAuthValidateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app: "verifone_cstoresku",
        connectorId: connector.connectorId || "verifone-commander",
        tenantId: connector.tenantId || "",
        storeId: connector.storeId || "",
        reason,
      }),
    });
    state.remoteValidation = {
      state: response.ok ? "valid" : "rejected",
      lastCheckedAt: new Date().toISOString(),
      message: response.ok ? "Remote validation succeeded." : `Remote validation failed with HTTP ${response.status}.`,
    };
  } catch (error) {
    state.remoteValidation = {
      state: "offline_pending",
      lastCheckedAt: new Date().toISOString(),
      message: `Remote validation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  store.setJson("auth", "local-login", state);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function recordUsage(source: string, tenantId: string, storeId: string, model: string, inputText: string, outputText: string, metadata: JsonObject = {}): JsonObject {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  const estimatedCostUsd = Number(((inputTokens + outputTokens) * 0.000001).toFixed(6));
  const event = store.recordUsageEvent({
    source,
    tenantId,
    storeId,
    model,
    inputTokens,
    outputTokens,
    estimatedCostUsd,
    metadata,
  });
  store.enqueue({
    target: "shre-cost",
    entityType: "usage_event",
    entityId: String(event.id || ""),
    operation: "report_usage",
    payload: {
      endpoint: shreCostEndpoint || "not_configured",
      event,
    },
  });
  return event;
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
  const installSecretPath = join(runtimeRoot, ".install-secret");
  const installSecret = existsSync(installSecretPath) ? readFileSync(installSecretPath, "utf8").trim() : "";
  const material = [
    process.env.VERIFONE_SHRE_SECRET || "",
    installSecret,
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

function verifyConnectorSignature(req: IncomingMessage, bodyText: string, registration: JsonObject): { ok: boolean; reason?: string } {
  if (!connectorSharedSecret) {
    return registration.cloudRelayEnabled === true
      ? { ok: false, reason: "connector_shared_secret_required_when_cloud_relay_enabled" }
      : { ok: true };
  }
  const timestamp = String(req.headers["x-shre-timestamp"] || "");
  const nonce = String(req.headers["x-shre-nonce"] || "");
  const tenantId = String(req.headers["x-shre-tenant-id"] || "");
  const agentId = String(req.headers["x-shre-agent-id"] || "");
  const signature = String(req.headers["x-shre-signature"] || "");
  if (!timestamp || !nonce || !tenantId || !agentId || !signature) return { ok: false, reason: "missing_signature_headers" };
  const time = Number(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000) {
    return { ok: false, reason: "signature_timestamp_outside_allowed_window" };
  }
  if (!store.consumeConnectorNonce(nonce)) return { ok: false, reason: "replayed_nonce" };
  const expected = createHmac("sha256", connectorSharedSecret).update(`${timestamp}.${nonce}.${tenantId}.${agentId}.${bodyText}`).digest("hex");
  const provided = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(provided, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return { ok: false, reason: "signature_mismatch" };
  return timingSafeEqual(expectedBuffer, providedBuffer) ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

function redactConnection(connection: JsonObject): JsonObject {
  const redacted: JsonObject = { ...connection };
  if (typeof redacted.password === "string" && redacted.password) redacted.password = "***";
  if (typeof redacted.applicationKey === "string" && redacted.applicationKey) redacted.applicationKey = "***";
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

function notification(id: string, severity: string, title: string, message: string, action: string): JsonObject {
  return { id, severity, title, message, action, createdAt: new Date().toISOString() };
}

function currentNotifications(): JsonObject {
  const items: JsonObject[] = [];
  const connection = store.getJson<JsonObject>("connections", "verifone", {});
  const verifoneStatus = store.getJson<JsonObject | null>("connections", "verifone-status", null);
  const passwordStatus = store.getJson<JsonObject>("connections", "password-status", {
    state: "unknown",
    daysRemaining: null,
    userActionRequired: false,
  });
  const queue = store.queueSummary();
  const connector = store.connectorStatus();
  const sales = store.latestSalesSnapshot();
  const auth = authState();
  const usage = store.usageSummary(25);

  if (!connection.commanderUrl || !connection.username || !connection.password) {
    items.push(notification(
      "verifone_not_configured",
      "critical",
      "Verifone is not configured",
      "Commander URL, username, and password are required before this connector can go live.",
      "Open Verifone setup",
    ));
  } else if (!verifoneStatus || verifoneStatus.status !== "connected") {
    items.push(notification(
      "verifone_not_connected",
      "critical",
      "Verifone is not connected",
      "The last Commander validation did not complete successfully.",
      "Validate Verifone connection",
    ));
  }

  if (passwordStatus.userActionRequired === true || passwordStatus.state === "expired" || passwordStatus.state === "auto_reset_failed") {
    items.push(notification(
      "password_action_required",
      "critical",
      "Commander password needs attention",
      String(passwordStatus.message || "Manual password update is required."),
      "Open password workflow",
    ));
  } else if (passwordStatus.state === "expiring") {
    items.push(notification(
      "password_expiring",
      "warning",
      "Commander password is expiring",
      `${passwordStatus.daysRemaining ?? "Unknown"} days remaining.`,
      "Review password workflow",
    ));
  }

  if (Number(queue.failed || 0) > 0) {
    items.push(notification(
      "queue_failed",
      "critical",
      "Queue has failed work",
      `${queue.failed} queue item(s) failed replay or processing.`,
      "Open queue",
    ));
  } else if (Number(queue.pending || 0) > 0) {
    items.push(notification(
      "queue_pending",
      "warning",
      "Queue has pending work",
      `${queue.pending} queue item(s) are waiting to process.`,
      "Open queue",
    ));
  }

  if (connector.status !== "activated") {
    items.push(notification(
      "connector_not_activated",
      "warning",
      "Marketplace connector is not activated",
      "Cloud/message gateway routing needs tenant and store registration.",
      "Open marketplace registration",
    ));
  }

  if (!sales) {
    items.push(notification(
      "sales_snapshot_missing",
      "info",
      "No local sales snapshot",
      "Sales chat answers need a local Commander sales snapshot or live ingest.",
      "Open sales query",
    ));
  }

  if (auth.configured !== true) {
    items.push(notification(
      "login_not_configured",
      "critical",
      "Local login is not configured",
      "Create a local login secret before going live.",
      "Open login setup",
    ));
  } else {
    const remote = asObject(auth.remoteValidation || {});
    if (remote.state === "offline_pending") {
      items.push(notification(
        "login_validation_pending",
        "warning",
        "Login validation is pending",
        "Offline login is allowed, and remote validation will retry when the service is reachable.",
        "Review login status",
      ));
    } else if (remote.state === "rejected") {
      items.push(notification(
        "login_validation_rejected",
        "critical",
        "Login validation was rejected",
        String(remote.message || "Remote login validation rejected this install."),
        "Contact support",
      ));
    }
  }

  if (Number(usage.estimatedCostUsd || 0) > 0 && Number(queue.pending || 0) > 0) {
    items.push(notification(
      "usage_report_pending",
      "info",
      "Usage report is pending",
      "Token/cost usage has been tracked locally and is waiting to report to Shre billing.",
      "Open usage summary",
    ));
  }

  const rank: Record<string, number> = { critical: 3, warning: 2, info: 1 };
  const topSeverity = items.reduce((top, item) => Math.max(top, rank[String(item.severity)] || 0), 0);
  return {
    count: items.length,
    highestSeverity: topSeverity === 3 ? "critical" : topSeverity === 2 ? "warning" : topSeverity === 1 ? "info" : "ok",
    items,
  };
}

function localBaseUrl(req: IncomingMessage): string {
  if (localBaseUrlOverride) return localBaseUrlOverride.replace(/\/$/, "");
  const requestHost = String(req.headers.host || `localhost:${port}`);
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `cstoresku:${port}`, `cstoresku.local:${port}`]);
  const safeHost = allowedHosts.has(requestHost.toLowerCase()) ? requestHost : `localhost:${port}`;
  return `http://${safeHost}`;
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
  if (!enforceJsonRequest(req, res) || !enforceLocalOrigin(req, res)) return;
  if (!enforceLocalAdmin(req, res, path)) return;

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

  if (path === "/api/auth/status") {
    const state = authState();
    sendJson(res, 200, {
      configured: state.configured === true,
      authenticated: validSession(req),
      remoteValidation: state.remoteValidation || null,
      offlineAllowed: true,
    });
    return;
  }

  if (path === "/api/auth/setup" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const loginSecret = requireString(body, "loginSecret");
      const state = authState();
      if (state.configured === true && !validSession(req) && localAdminToken) {
        sendJson(res, 401, { error: "Existing login must be authenticated before changing secret" });
        return;
      }
      const next = {
        configured: true,
        secretHash: hashSecret(loginSecret),
        updatedAt: new Date().toISOString(),
        remoteValidation: {
          state: shreAuthValidateUrl ? "pending" : "not_configured",
          lastCheckedAt: null,
          message: shreAuthValidateUrl ? "Remote validation pending." : "Remote validation endpoint is not configured.",
        },
      };
      store.setJson("auth", "local-login", next);
      store.appendActivity("local_login_configured", { remoteValidationConfigured: Boolean(shreAuthValidateUrl) });
      validateLoginRemote("setup").catch(() => undefined);
      sendJson(res, 200, { ok: true, session: createSession(), remoteValidation: next.remoteValidation });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const loginSecret = requireString(body, "loginSecret");
      const state = authState();
      if (state.configured !== true || !state.secretHash || typeof state.secretHash !== "object") {
        badRequest(res, "Local login is not configured");
        return;
      }
      if (!verifySecret(loginSecret, state.secretHash as JsonObject)) {
        sendJson(res, 401, { error: "Invalid login secret" });
        return;
      }
      const session = createSession();
      store.appendActivity("local_login_succeeded", { offlineAllowed: true });
      validateLoginRemote("login").catch(() => undefined);
      sendJson(res, 200, { ok: true, session, remoteValidation: state.remoteValidation || null });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/auth/validate" && req.method === "POST") {
    await validateLoginRemote("manual");
    sendJson(res, 200, authState());
    return;
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    const token = String(req.headers["x-local-session"] || "");
    if (token) {
      const sessions = sessionState();
      delete sessions[createHash("sha256").update(token).digest("hex")];
      store.setJson("auth", "sessions", sessions);
    }
    sendJson(res, 200, { ok: true });
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
        applicationKey: typeof body.applicationKey === "string" && body.applicationKey ? encryptSecret(body.applicationKey) : "",
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
      manifest: "/api/connector/manifest",
      salesQuery: "/api/sales/query",
      messages: "/api/messages/inbound",
      activity: "/api/activity",
      messageAudit: "/api/messages/audit",
      notifications: "/api/notifications",
      activitySummary: store.activitySummary(),
    });
    return;
  }

  if (path === "/api/notifications") {
    sendJson(res, 200, currentNotifications());
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

  if (path === "/api/connector/manifest") {
    sendJson(res, 200, store.connectorManifest(localBaseUrl(req)));
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

  if (path === "/api/sales/snapshot" && req.method === "POST") {
    const snapshot = store.saveSalesSnapshot(asObject(await requestBody(req)));
    store.appendActivity("sales_snapshot_saved", {
      businessDate: snapshot.businessDate,
      source: snapshot.source,
    });
    sendJson(res, 201, snapshot);
    return;
  }

  if (path === "/api/sales/query" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const query = typeof body.query === "string" && body.query.trim() ? body.query.trim() : "sales";
    const businessDate = typeof body.businessDate === "string" && body.businessDate.trim()
      ? body.businessDate.trim()
      : undefined;
    const result = store.answerSalesQuery(query, businessDate);
    store.appendActivity("sales_query_answered", {
      status: result.status,
      businessDate: result.businessDate,
      requiresDataSource: result.requiresDataSource,
    });
    sendJson(res, result.status === "answered" ? 200 : 202, result);
    return;
  }

  if (path === "/api/messages/inbound" && req.method === "POST") {
    try {
      const bodyText = await requestText(req);
      const registration = store.connectorStatus();
      const signature = verifyConnectorSignature(req, bodyText, registration);
      if (!signature.ok) {
        sendJson(res, 401, { error: "Invalid connector signature", reason: signature.reason || "invalid_signature" });
        return;
      }
      const body = asObject(bodyText ? JSON.parse(bodyText) as JsonValue : {});
      const messageText = requireString(body, "messageText");
      const source = typeof body.source === "string" ? body.source : "unknown";
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : String(registration.tenantId || "");
      const storeId = typeof body.storeId === "string" ? body.storeId : String(registration.storeId || "");
      if (registration.status === "activated" && (tenantId !== registration.tenantId || storeId !== registration.storeId)) {
        sendJson(res, 403, { error: "Inbound tenant/store does not match local connector activation" });
        return;
      }
      const allowedSources = new Set(["shre-chat", "message-gateway", "whatsapp", "claude", "codex", "shre-cli", "unknown"]);
      if (!allowedSources.has(source)) {
        sendJson(res, 403, { error: "Inbound source is not allowed" });
        return;
      }
      const userId = typeof body.userId === "string" ? body.userId : "";
      const classification = classifyMessage(messageText);
      const connectorResponse = classification.intent === "sales_query"
        ? store.answerSalesQuery(messageText)
        : {
            status: "queued",
            answer: "Message accepted locally and queued for processing.",
          };
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
        message: String(connectorResponse.answer || "Message accepted locally and queued for processing."),
        connectorResponse,
      };
      const audit = store.saveChatAudit({
        source,
        tenantId,
        storeId,
        userId,
        messageText,
        intent: classification.intent,
        status: connectorResponse.status === "answered" ? "answered" : "queued",
        response,
      });
      store.appendActivity("inbound_message_queued", {
        source,
        intent: classification.intent,
        queueId: queueItem.id,
      });
      recordUsage(source, tenantId, storeId, "local-sales-query", messageText, response.message, {
        intent: classification.intent,
        auditId: audit.id,
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

  if (path === "/api/usage/summary") {
    sendJson(res, 200, store.usageSummary(100));
    return;
  }

  if (path === "/api/usage/record" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const event = store.recordUsageEvent(body);
    store.enqueue({
      target: "shre-cost",
      entityType: "usage_event",
      entityId: String(event.id || ""),
      operation: "report_usage",
      payload: { endpoint: shreCostEndpoint || "not_configured", event },
    });
    sendJson(res, 201, event);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveUi(res: ServerResponse): Promise<void> {
  const html = await readFile(join(uiRoot, "index.html"), "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;",
  });
  res.end(html);
}

async function main(): Promise<void> {
  await ensureRuntime();
  store = new RuntimeStore(runtimeRoot, { connectorRegistryUrl });
  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    res.on("finish", () => {
      if (!url.pathname.startsWith("/api/")) return;
      store.appendActivity("api_request_completed", {
        requestId,
        method: req.method || "GET",
        path: url.pathname,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        remoteAddress: req.socket.remoteAddress || "",
      });
    });
    handleRequest(req, res, url.pathname).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.listen(port, host, () => {
    console.log(`dashboard-api listening on http://${host}:${port}`);
  });
  validateLoginRemote("startup").catch(() => undefined);
  setInterval(() => validateLoginRemote("background").catch(() => undefined), 5 * 60 * 1000).unref();
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path.startsWith("/api/")) {
    await handleApi(req, res, path);
    return;
  }
  await serveUi(res);
}

await main();
