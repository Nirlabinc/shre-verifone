import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { chmod, readFile, mkdir, readdir, stat, statfs } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname, platform, arch, totalmem, freemem, cpus } from "node:os";
import { createHash, createHmac, randomBytes, randomUUID, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from "node:crypto";
import { RuntimeStore, type JsonObject, type JsonValue } from "./store.js";
import { pdkCommandById, pdkCommandCatalog, type PdkCommand } from "./pdk-catalog.js";

const port = Number(process.env.PORT || 5480);
const host = process.env.HOST || "127.0.0.1";
const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");
const connectorRegistryUrl = process.env.CONNECTOR_REGISTRY_URL || "https://connector.aros.live";
const connectorSharedSecret = process.env.CONNECTOR_SHARED_SECRET || "";
const localBaseUrlOverride = process.env.LOCAL_BASE_URL || "";
const localAdminToken = process.env.LOCAL_ADMIN_TOKEN || "";
const shreAuthValidateUrl = process.env.SHRE_AUTH_VALIDATE_URL || "";
const shreAuthSignupUrl = process.env.SHRE_AUTH_SIGNUP_URL || "";
const shreSetupCaptureUrl = process.env.SHRE_SETUP_CAPTURE_URL || "";
const shreCostEndpoint = process.env.SHRE_COST_ENDPOINT || "";
const emailVerificationRequired = process.env.SHRE_EMAIL_VERIFICATION_REQUIRED === "true";
const commanderAccessMode = process.env.COMMANDER_ACCESS_MODE || process.env.SHRE_MODE || "read_only";
const appVersion = process.env.APP_VERSION || process.env.npm_package_version || "0.1.0";
const buildChannel = process.env.BUILD_CHANNEL || process.env.SHRE_ENV || "local";
const buildSha = process.env.BUILD_SHA || "dev";
const uiRoot = resolve("apps/dashboard-ui");
let store: RuntimeStore;

const retentionOptions = [7, 14, 30, 60, 90, 180, 365];
const heartbeatWorkerIntervalMs = Math.max(5_000, Number(process.env.HEARTBEAT_WORKER_INTERVAL_MS || 30_000));
const heartbeatWorkerEnabled = process.env.DISABLE_HEARTBEAT_WORKER !== "true";
const commanderSalesEndpointCandidates = (process.env.COMMANDER_SALES_ENDPOINTS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

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
  if (bytes > 10_000_000) throw new Error("Request body too large");
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

function recordErrorLog(severity: string, source: string, operation: string, message: string, details: JsonObject = {}, correlationId = "", entityId = ""): JsonObject {
  return store.recordError({
    severity,
    source,
    operation,
    entityId,
    message: redactSensitiveText(message),
    details: sanitizeErrorDetails(details),
    correlationId,
  });
}

function sanitizeErrorDetails(details: JsonObject): JsonObject {
  const scrub = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.slice(0, 25).map(scrub);
    if (value && typeof value === "object") {
      const output: JsonObject = {};
      for (const [key, child] of Object.entries(value)) {
        const lower = key.toLowerCase();
        if (["password", "passwd", "cookie", "token", "key", "secret", "authorization", "applicationkey"].some((item) => lower.includes(item))) {
          output[key] = "***";
        } else {
          output[key] = scrub(child as JsonValue);
        }
      }
      return output;
    }
    if (typeof value === "string") return redactSensitiveText(value).slice(0, 2000);
    return value;
  };
  return scrub(details) as JsonObject;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(passwd|password|user|username|token|key|cookie|secret)=([^&\s]+)/gi, "$1=***")
    .replace(/(authorization:\s*basic\s+)[A-Za-z0-9+/=._:-]+/gi, "$1***")
    .replace(/<\s*(Password|Passwd|Cookie|Token|Secret|Key)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "<$1>***</$1>");
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
  if (path === "/api/setup/first-run") return true;
  if (path === "/api/health" || path === "/api/version" || path === "/api/capabilities" || path === "/api/connector/manifest" || path === "/api/messages/inbound") return true;
  if (validSession(req)) return true;
  if (localAdminToken) {
    const provided = String(req.headers["x-local-admin-token"] || "");
    const expected = Buffer.from(localAdminToken);
    const actual = Buffer.from(provided);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return true;
    sendJson(res, 401, { error: "Local admin token or session required" });
    return false;
  }
  if (authState().configured === true) {
    sendJson(res, 401, { error: "Local login session required" });
    return false;
  }
  sendJson(res, 401, { error: "Local login must be configured first" });
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
        workspaceId: connector.workspaceId || "",
        storeId: connector.storeId || "",
        reason,
      }),
    });
    const payload = await response.json().catch(() => ({})) as JsonObject;
    const entitlement = String(
      payload.entitlementState ||
      payload.status ||
      (response.ok ? "active" : response.status === 402 ? "suspended" : response.status === 403 ? "deactivated" : "rejected"),
    );
    state.remoteValidation = {
      state: entitlement === "active" ? "valid" : entitlement,
      entitlementState: entitlement,
      lastCheckedAt: new Date().toISOString(),
      message: entitlement === "active"
        ? "Remote validation succeeded."
        : String(payload.message || `Remote validation returned ${entitlement} with HTTP ${response.status}.`),
      keyVersion: typeof payload.keyVersion === "string" ? payload.keyVersion : "",
      refreshedAt: entitlement === "active" ? new Date().toISOString() : null,
    };
  } catch (error) {
    state.remoteValidation = {
      state: "offline_pending",
      entitlementState: "offline_pending",
      lastCheckedAt: new Date().toISOString(),
      message: `Remote validation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  store.setJson("auth", "local-login", state);
}

function entitlementState(): string {
  const remote = asObject(authState().remoteValidation || {});
  return String(remote.entitlementState || remote.state || "unknown");
}

function meteredActionsAllowed(): boolean {
  const state = entitlementState();
  return !["suspended", "deactivated", "rejected"].includes(state);
}

function blockMeteredAction(res: ServerResponse): boolean {
  if (meteredActionsAllowed()) return false;
  sendJson(res, 402, {
    error: "Account is not active",
    entitlementState: entitlementState(),
    message: "This account must be reactivated before chat, cloud relay, or metered Shre services can continue.",
  });
  return true;
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

function redactTrainingText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone]")
    .replace(/\b\d{12,19}\b/g, "[long-number]")
    .replace(/\b(password|secret|token|key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 4000);
}

function recordLearningCandidate(source: string, tenantId: string, storeId: string, intent: string, toolName: string, inputText: string, outputText: string, metadata: JsonObject = {}): JsonObject {
  return store.saveLearningExample({
    source,
    tenantId,
    storeId,
    intent,
    toolName,
    inputText: redactTrainingText(inputText),
    outputText: redactTrainingText(outputText),
    metadata: {
      ...metadata,
      rawXmlIncluded: false,
      approvalRequired: true,
      destination: "shre-ai-rag-or-finetune",
    },
  });
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

function optionalString(body: JsonObject, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

async function captureFirstRunSetup(profile: JsonObject): Promise<JsonObject> {
  const now = new Date().toISOString();
  const payload = {
    app: "verifone_cstoresku",
    connectorId: "verifone-commander",
    workspaceName: profile.workspaceName,
    storeId: profile.storeId,
    corporateName: profile.corporateName,
    dba: profile.dba,
    address: profile.address,
    phone: profile.phone,
    email: profile.email,
    contactName: profile.contactName,
    host: { hostname: hostname(), platform: platform(), arch: arch() },
  };
  if (!shreSetupCaptureUrl) {
    return {
      state: emailVerificationRequired ? "pending_configuration" : "verified",
      provider: "local-simulated",
      capturedAt: now,
      message: emailVerificationRequired
        ? "Email verification is required, but SHRE_SETUP_CAPTURE_URL is not configured."
        : "Local setup captured. Production Shre setup capture is not configured.",
    };
  }
  const response = await fetch(shreSetupCaptureUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = asObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(String(data.error || data.message || `Shre setup capture failed with HTTP ${response.status}`));
  }
  return {
    state: String(data.emailVerificationState || data.state || "pending"),
    provider: String(data.provider || "shre-platform"),
    verificationId: typeof data.verificationId === "string" ? data.verificationId : "",
    capturedAt: now,
    message: String(data.message || "Setup captured by Shre Platform. Verify email to complete activation."),
  };
}

function normalizeAccessMode(value: JsonValue): string {
  const mode = typeof value === "string" ? value : commanderAccessMode;
  return ["read_only", "read_write", "write_only"].includes(mode) ? mode : "read_only";
}

function accessModeState(): JsonObject {
  return store.getJson<JsonObject>("config", "access-mode", {
    mode: normalizeAccessMode(commanderAccessMode),
    updatedAt: null,
    source: "env-default",
  });
}

function accessMode(): string {
  return normalizeAccessMode(accessModeState().mode);
}

function commanderWritesAllowed(): boolean {
  return accessMode() === "read_write" || accessMode() === "write_only";
}

function commanderReadsAllowed(): boolean {
  return accessMode() === "read_write" || accessMode() === "read_only";
}

function syncState(): JsonObject {
  return store.getJson<JsonObject>("sync", "state", {
    heartbeat: {
      status: "not_configured",
      lastCheckedAt: null,
      nextCheckAt: null,
      failureCount: 0,
      backoffSeconds: 30,
      message: "Verifone connection is not configured.",
    },
    localPull: {
      enabled: false,
      status: "idle",
      lastPullAt: null,
      nextPullAt: null,
      intervalSeconds: 300,
      source: "verifone-commander",
    },
    cstoresku: {
      linked: false,
      lastPushAt: null,
      lastPullAt: null,
      status: "not_linked",
    },
    commanderWriteBack: {
      enabled: commanderWritesAllowed(),
      mode: accessMode(),
      lastWriteAt: null,
      status: commanderWritesAllowed() ? "ready" : "blocked_by_access_mode",
    },
    updatedAt: null,
  });
}

function saveSyncState(patch: JsonObject): JsonObject {
  const current = syncState();
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store.setJson("sync", "state", next);
  return next;
}

function markLocalPullScheduled(reason: string): JsonObject {
  const now = new Date();
  return saveSyncState({
    localPull: {
      ...asObject(syncState().localPull || {}),
      enabled: true,
      status: "scheduled",
      nextPullAt: new Date(now.getTime() + 30_000).toISOString(),
      intervalSeconds: 300,
      reason,
      source: "verifone-commander",
    },
  });
}

function markLocalPullResult(status: string, patch: JsonObject): JsonObject {
  return saveSyncState({
    localPull: {
      ...asObject(syncState().localPull || {}),
      status,
      ...patch,
    },
  });
}

function markCstoreskuLinked(reason: string): JsonObject {
  return saveSyncState({
    cstoresku: {
      ...asObject(syncState().cstoresku || {}),
      linked: true,
      status: "linked",
      reason,
      lastLinkedAt: new Date().toISOString(),
    },
  });
}

function updateCommanderWriteBackState(): JsonObject {
  return saveSyncState({
    commanderWriteBack: {
      ...asObject(syncState().commanderWriteBack || {}),
      enabled: commanderWritesAllowed(),
      mode: accessMode(),
      status: commanderWritesAllowed() ? "ready" : "blocked_by_access_mode",
    },
  });
}

function isCommanderWriteOperation(item: JsonObject): boolean {
  const target = String(item.target || "").toLowerCase();
  const entityType = String(item.entityType || "").toLowerCase();
  const operation = String(item.operation || "").toLowerCase();
  if (target === "commander") return true;
  if (entityType.includes("inventory") || entityType.includes("price") || entityType.includes("item")) {
    return /\b(write|push|update|sync|set|change|adjust)\b/.test(operation);
  }
  return /\b(update commander|send to commander|inventory_write|price_update|push_inventory)\b/.test(operation);
}

function blockCommanderWriteIfNeeded(res: ServerResponse, item: JsonObject): boolean {
  if (!isCommanderWriteOperation(item) || commanderWritesAllowed()) return false;
  sendJson(res, 403, {
    error: "Commander write blocked",
    accessMode: accessMode(),
    message: "Inventory/Commander writes require access mode read_write or write_only.",
  });
  return true;
}

function validateVerifoneConnection(body: JsonObject = {}): JsonObject {
  const connection = store.getJson<JsonObject>("connections", "verifone", {});
  const configuredPassword = typeof connection.password === "string" ? decryptSecret(connection.password) : "";
  const ok = Boolean(connection.commanderUrl && connection.username && configuredPassword) && body.forceFailure !== true;
  const daysRemaining = typeof body.daysRemaining === "number" ? body.daysRemaining : null;
  const now = new Date();
  const currentSync = syncState();
  const previousHeartbeat = asObject(currentSync.heartbeat || {});
  const previousFailures = Number(previousHeartbeat.failureCount || 0);
  const failureCount = ok ? 0 : previousFailures + 1;
  const backoffSeconds = ok ? 30 : Math.min(300, 30 * (2 ** Math.min(failureCount - 1, 4)));
  const validation = {
    ok,
    status: ok ? "connected" : "failed",
    checkedAt: now.toISOString(),
    message: ok ? "Connection validated. Local pull is scheduled." : "Validation failed. Retry is backed off to avoid overloading Commander.",
    daysRemaining,
  };
  store.setJson("connections", "verifone-status", validation);
  saveSyncState({
    heartbeat: {
      status: ok ? "connected" : "disconnected",
      lastCheckedAt: now.toISOString(),
      nextCheckAt: new Date(now.getTime() + backoffSeconds * 1000).toISOString(),
      failureCount,
      backoffSeconds,
      message: validation.message,
    },
    localPull: {
      ...asObject(currentSync.localPull || {}),
      enabled: ok && commanderReadsAllowed(),
      status: ok && commanderReadsAllowed() ? "scheduled" : "blocked",
      lastPullAt: ok && commanderReadsAllowed() ? now.toISOString() : asObject(currentSync.localPull || {}).lastPullAt || null,
      nextPullAt: ok && commanderReadsAllowed() ? new Date(now.getTime() + 300_000).toISOString() : null,
      intervalSeconds: 300,
      source: "verifone-commander",
    },
  });
  if (daysRemaining !== null) {
    store.setJson("connections", "password-status", {
      state: daysRemaining <= 0 ? "expired" : daysRemaining <= 15 ? "expiring" : "valid",
      daysRemaining,
      autoResetLastAttempt: null,
      userActionRequired: daysRemaining <= 0,
      updatedAt: now.toISOString(),
    });
  }
  store.appendActivity("verifone_connection_validated", { ok, daysRemaining, backoffSeconds });
  return validation;
}

function pingVerifoneConnection(body: JsonObject = {}): JsonObject {
  const connection = store.getJson<JsonObject>("connections", "verifone", {});
  const configuredPassword = typeof connection.password === "string" ? decryptSecret(connection.password) : "";
  const ok = Boolean(connection.commanderUrl && connection.username && configuredPassword) && body.forceFailure !== true;
  const result = {
    ok,
    status: ok ? "reachable" : "unreachable",
    checkedAt: new Date().toISOString(),
    commanderUrlConfigured: Boolean(connection.commanderUrl),
    usernameConfigured: Boolean(connection.username),
    passwordConfigured: Boolean(configuredPassword),
    message: ok ? "Commander ping succeeded." : "Commander ping failed or Verifone connection is incomplete.",
  };
  store.appendActivity("verifone_connection_pinged", { ok, status: result.status });
  return result;
}

async function pullCommanderSales(body: JsonObject = {}): Promise<JsonObject> {
  return pullCommanderReport({ ...body, reportType: "sales" });
}

async function pullCommanderReport(body: JsonObject = {}): Promise<JsonObject> {
  if (!commanderReadsAllowed()) {
    return {
      ok: false,
      status: "blocked",
      message: "Commander reads are blocked by access mode.",
      accessMode: accessMode(),
    };
  }
  const reportType = normalizeReportType(typeof body.reportType === "string" ? body.reportType : "sales");
  const owner = typeof body.owner === "string" && body.owner.trim() ? body.owner.trim() : `${reportType}-ingest`;
  const lease = store.acquireCommanderLease(owner, 120);
  if (lease.acquired !== true) {
    return {
      ok: false,
      status: "lease_blocked",
      message: "Commander pull is already running.",
      lease,
    };
  }
  const startedAt = new Date();
  try {
    const connection = store.getJson<JsonObject>("connections", "verifone", {});
    const commanderUrl = String(connection.commanderUrl || "").replace(/\/$/, "");
    const username = String(connection.username || "");
    const password = typeof connection.password === "string" ? decryptSecret(connection.password) : "";
    if (!commanderUrl || !username || !password) {
      throw new Error("Verifone connection is not configured.");
    }
    const businessDate = typeof body.businessDate === "string" && body.businessDate.trim()
      ? body.businessDate.trim()
      : new Date().toISOString().slice(0, 10);
    const configuredEndpoint = configuredReportEndpoint(connection, reportType);
    const requestedEndpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const endpoints = reportEndpointCandidates(reportType, requestedEndpoint, configuredEndpoint);
    const attempts: JsonObject[] = [];
    for (const endpoint of endpoints) {
      const url = buildCommanderUrl(commanderUrl, endpoint, businessDate, username, password);
      try {
        const response = await fetchCommander(url, username, password, connection);
        const text = await response.text();
        attempts.push({
          endpoint,
          url: redactCommanderUrl(url),
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          bytes: text.length,
        });
        if (!response.ok || !text.trim()) continue;
        const normalizedReport = normalizeCommanderXmlReport(text, response.headers.get("content-type") || "", reportType, businessDate);
        if (!normalizedReport) continue;
        const report = store.saveCommanderReport({
          reportType: String(normalizedReport.reportType || reportType),
          businessDate,
          source: "verifone-commander-live",
          rootName: String(normalizedReport.rootName || ""),
          xml: text,
          normalized: asObject(normalizedReport.normalized || {}),
        });
        const snapshotInput = reportType === "sales" ? salesSnapshotFromConexxus(asObject(normalizedReport.normalized || {}), businessDate) : null;
        const snapshot = snapshotInput ? store.saveSalesSnapshot({
          ...snapshotInput,
          businessDate,
          source: "verifone-commander-live",
        }) : null;
        const finishedAt = new Date();
        markLocalPullResult("completed", {
          enabled: true,
          lastPullAt: finishedAt.toISOString(),
          nextPullAt: new Date(finishedAt.getTime() + 300_000).toISOString(),
          intervalSeconds: 300,
          source: "verifone-commander",
          lastError: null,
          lastEndpoint: endpoint,
          lastReportType: report.reportType,
        });
        store.appendActivity("commander_report_pull_completed", {
          businessDate,
          endpoint,
          reportType: report.reportType,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        });
        return {
          ok: true,
          status: "completed",
          businessDate,
          endpoint,
          report,
          snapshot,
          attempts,
        };
      } catch (error) {
        attempts.push({
          endpoint,
          url: redactCommanderUrl(url),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const message = `No Commander ${reportType} endpoint returned a recognizable Conexxus/NAXML XML payload. Configure the correct Commander report path or CGILink command.`;
    markLocalPullResult("failed", {
      enabled: true,
      lastError: message,
      lastAttemptAt: new Date().toISOString(),
      nextPullAt: new Date(Date.now() + 300_000).toISOString(),
      source: "verifone-commander",
      lastReportType: reportType,
    });
    store.appendActivity("commander_report_pull_failed", { businessDate, reportType, attempts: attempts.length, message });
    const errorLog = recordErrorLog("warning", "verifone-commander", "pull-report", message, { businessDate, reportType, attempts }, "", `${reportType}:${businessDate}`);
    return { ok: false, status: "failed", reportType, businessDate, message, attempts, errorId: errorLog.id };
  } finally {
    store.releaseCommanderLease(owner);
  }
}

function normalizeReportType(value: string): string {
  const type = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (["sales", "batch", "fuel", "tank", "item", "plu", "department", "category", "payment", "network", "tax", "journal", "cashier", "payroll", "esafe", "carwash", "loyalty"].includes(type)) return type;
  return "sales";
}

function configuredReportEndpoint(connection: JsonObject, reportType: string): string {
  const specificKey = `${reportType}Endpoint`;
  if (typeof connection[specificKey] === "string") return String(connection[specificKey]);
  if (reportType === "sales" && typeof connection.salesEndpoint === "string") return connection.salesEndpoint;
  return "";
}

function reportEndpointCandidates(reportType: string, requestedEndpoint: string, configuredEndpoint: string): string[] {
  const commonCgi = [
    `/cgi-bin/CGILink?cmd=${reportType}`,
    `/cgi-bin/CGILink?cmd=get${capitalize(reportType)}`,
    "/cgi-bin/CGILink?cmd=report",
    "/cgi-bin/CGILink?cmd=getReport",
  ];
  const byType: Record<string, string[]> = {
    sales: [
      requestedEndpoint,
      configuredEndpoint,
      ...commanderSalesEndpointCandidates,
      "/api/sales",
      "/api/reports/sales",
      "/api/reports/daily-sales",
      "/reports/sales",
      "/reports/daily-sales",
      "/sales",
      "/cgi-bin/CGILink?cmd=periodList",
      "/cgi-bin/CGILink?cmd=periodInfo",
      "/cgi-bin/CGILink?cmd=report",
      "/cgi-bin/CGILink?cmd=getReport",
      "/cgi-bin/CGILink?cmd=sales",
      "/cgi-bin/CGILink?cmd=getSales",
    ],
    batch: [requestedEndpoint, configuredEndpoint, "/api/reports/batch", "/reports/batch", "/batch", ...commonCgi],
    fuel: [requestedEndpoint, configuredEndpoint, "/api/reports/fuel", "/reports/fuel", "/fuel", "/cgi-bin/CGILink?cmd=fuelGradeMovement", ...commonCgi],
    tank: [requestedEndpoint, configuredEndpoint, "/api/reports/tank", "/reports/tank", "/tank", "/cgi-bin/CGILink?cmd=fuelTankStock", ...commonCgi],
    journal: [requestedEndpoint, configuredEndpoint, "/cgi-bin/CGILink?cmd=journal", "/cgi-bin/CGILink?cmd=getJournal", ...commonCgi],
  };
  return uniqueStrings(byType[reportType] || [requestedEndpoint, configuredEndpoint, ...commonCgi]);
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function redactCommanderUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ["passwd", "password", "user", "username", "token", "key", "cookie"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "***");
    }
    return url.toString();
  } catch {
    return value.replace(/(passwd|password|user|username|token|key)=([^&]+)/gi, "$1=***");
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildCommanderUrl(baseUrl: string, endpoint: string, businessDate: string, username: string, password: string): string {
  const url = new URL(endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`);
  if (!url.searchParams.has("businessDate")) url.searchParams.set("businessDate", businessDate);
  if (!url.searchParams.has("date")) url.searchParams.set("date", businessDate);
  if (url.pathname.toLowerCase().endsWith("/cgi-bin/cgilink")) {
    if (!url.searchParams.has("user")) url.searchParams.set("user", username);
    if (!url.searchParams.has("passwd")) url.searchParams.set("passwd", password);
  }
  return url.toString();
}

async function fetchCommander(url: string, username: string, password: string, connection: JsonObject, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers: Record<string, string> = {
      accept: "application/json, application/xml, text/xml, text/plain;q=0.8, */*;q=0.5",
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      ...Object.fromEntries(new Headers(init.headers || {}).entries()),
    };
    if (typeof connection.applicationKey === "string" && connection.applicationKey) {
      headers["x-application-key"] = decryptSecret(connection.applicationKey);
    }
    return await fetch(url, { ...init, method: init.method || "GET", headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCommanderXmlReport(text: string, contentType: string, requestedType: string, businessDate: string): JsonObject | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/<\s*(?:[^:>]+:)?Fault\b/i.test(trimmed) || /<faultCode>/i.test(trimmed)) return null;
  if (trimmed.startsWith("<")) {
    const rootName = xmlRootName(trimmed);
    const reportType = classifyConexxusReport(trimmed, requestedType, rootName);
    return {
      reportType,
      rootName,
      normalized: normalizeConexxusXml(trimmed, reportType, businessDate),
    };
  }
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const normalized = normalizeSalesJson(JSON.parse(trimmed) as JsonValue, businessDate);
      return normalized ? { reportType: requestedType, rootName: "json", normalized } : null;
    } catch {
      return null;
    }
  }
  const normalized = normalizeSalesText(trimmed, businessDate);
  return normalized ? { reportType: requestedType, rootName: "text", normalized } : null;
}

function xmlRootName(xml: string): string {
  const match = xml.match(/<\s*([A-Za-z0-9_:-]+)/);
  return match ? match[1].replace(/^.*:/, "") : "unknown";
}

function classifyConexxusReport(xml: string, requestedType: string, rootName: string): string {
  const haystack = `${rootName} ${xml.slice(0, 4000)}`.toLowerCase();
  if (haystack.includes("movementreport") || haystack.includes("merchandisecodemovement") || haystack.includes("retailtransaction")) return "sales";
  if (
    haystack.includes("plu")
    || haystack.includes("pricebook")
    || haystack.includes("pluconfig")
    || haystack.includes("plumaintenance")
    || haystack.includes("itemmaintenance")
    || haystack.includes("ittdetail")
    || haystack.includes("poscode")
  ) return "plu";
  if (haystack.includes("itemlist")) return "item_list";
  if (haystack.includes("mixmatch")) return "promotion";
  if (haystack.includes("department") || haystack.includes("dept")) return "department";
  if (haystack.includes("category")) return "category";
  if (haystack.includes("tax")) return "tax";
  if (haystack.includes("viper") || haystack.includes("payment") || haystack.includes("prepaid") || haystack.includes("cardtype")) return "payment";
  if (haystack.includes("cashier") || haystack.includes("payroll")) return haystack.includes("payroll") ? "payroll" : "cashier";
  if (haystack.includes("esafe") || haystack.includes("safecontent")) return "esafe";
  if (haystack.includes("carwash") || haystack.includes("car wash")) return "carwash";
  if (haystack.includes("fueltankstock") || haystack.includes("tankstock") || haystack.includes("atg")) return "tank";
  if (
    haystack.includes("fuelgrademovement")
    || haystack.includes("fgmdetail")
    || haystack.includes("fuelgrade")
    || haystack.includes("fuelprices")
    || haystack.includes("fuelconfig")
    || haystack.includes("fuelproduct")
  ) return "fuel";
  if (haystack.includes("batchsummary") || haystack.includes("batchmovement") || haystack.includes("batch")) return "batch";
  if (haystack.includes("journal")) return "journal";
  return requestedType;
}

function normalizeConexxusXml(xml: string, reportType: string, businessDate: string): JsonObject {
  return {
    standard: "conexxus-naxml",
    schemaValidation: "not_configured",
    reportType,
    businessDate: findXmlText(xml, ["BusinessDate", "ReportDate", "PeriodBusinessDate", "MovementDate"]) || businessDate,
    totals: normalizeConexxusTotals(xml, reportType),
    records: normalizeConexxusRecords(xml, reportType),
    sourceRoot: xmlRootName(xml),
  };
}

function normalizeConexxusTotals(xml: string, reportType: string): JsonObject {
  if (reportType === "plu" || reportType === "item") {
    return {
      itemCount: countTags(xml, ["PLU", "Item", "PricebookItem", "MerchandiseCodeMovement", "ItemMaintenance", "ITTDetail", "POSCode"]),
      salesAmount: matchXmlNumber(xml, ["SalesAmount", "ItemSalesAmount", "TotalSales", "NetSales"]) || 0,
      salesQuantity: matchXmlNumber(xml, ["SalesQuantity", "Quantity", "ItemSalesQuantity"]) || 0,
    };
  }
  if (reportType === "department" || reportType === "category") {
    return {
      recordCount: countTags(xml, ["Department", "DepartmentMovement", "DepartmentSummary", "Category", "CategoryMovement"]),
      salesAmount: matchXmlNumber(xml, ["DepartmentSalesAmount", "CategorySalesAmount", "SalesAmount", "TotalSales"]) || 0,
      salesQuantity: matchXmlNumber(xml, ["DepartmentSalesQuantity", "CategorySalesQuantity", "SalesQuantity", "Quantity"]) || 0,
    };
  }
  if (reportType === "tax") {
    return {
      taxCount: countTags(xml, ["Tax", "TaxLevel", "TaxSummary", "TaxDetail"]),
      taxableAmount: matchXmlNumber(xml, ["TaxableAmount", "TaxableSalesAmount", "SalesAmount"]) || 0,
      taxAmount: matchXmlNumber(xml, ["TaxAmount", "CollectedTaxAmount"]) || 0,
    };
  }
  if (reportType === "payment" || reportType === "network") {
    return {
      paymentCount: countTags(xml, ["Payment", "Tender", "Network", "Batch", "CardType"]),
      paymentAmount: matchXmlNumber(xml, ["PaymentAmount", "TenderAmount", "NetworkAmount", "BatchTotalAmount", "TotalAmount"]) || 0,
      transactionCount: matchXmlNumber(xml, ["TransactionCount", "PaymentCount", "TenderCount"]) || 0,
    };
  }
  if (reportType === "cashier" || reportType === "payroll") {
    return {
      cashierCount: countTags(xml, ["Cashier", "CashierSummary", "Payroll", "Employee"]),
      salesAmount: matchXmlNumber(xml, ["SalesAmount", "TotalSales", "CashierSalesAmount"]) || 0,
      transactionCount: matchXmlNumber(xml, ["TransactionCount", "TicketCount"]) || 0,
    };
  }
  if (reportType === "esafe" || reportType === "carwash" || reportType === "loyalty") {
    return {
      recordCount: countTags(xml, ["Detail", "Record", "Transaction", "CarWash", "Loyalty", "Safe"]),
      totalAmount: matchXmlNumber(xml, ["TotalAmount", "Amount", "SalesAmount", "CollectedAmount"]) || 0,
      transactionCount: matchXmlNumber(xml, ["TransactionCount", "Count"]) || 0,
    };
  }
  if (reportType === "tank") {
    return {
      tankCount: countTags(xml, ["TankID", "TankNumber"]),
      grossVolume: matchXmlNumber(xml, ["GrossVolume", "TankVolume", "FuelVolume", "ProductVolume"]) || 0,
      waterVolume: matchXmlNumber(xml, ["WaterVolume"]) || 0,
    };
  }
  if (reportType === "fuel") {
    return {
      fuelProductCount: countTags(xml, ["FuelProduct"]),
      priceCount: countTags(xml, ["Price"]),
      fuelGradeSalesVolume: matchXmlNumber(xml, ["FuelGradeSalesVolume", "SalesVolume", "FuelSalesVolume"]) || 0,
      fuelGradeSalesAmount: matchXmlNumber(xml, ["FuelGradeSalesAmount", "SalesAmount", "FuelSalesAmount"]) || 0,
      firstPrice: matchXmlNumber(xml, ["Price", "price"]) || 0,
    };
  }
  if (reportType === "batch") {
    return {
      batchCount: countTags(xml, ["BatchID", "BatchNumber"]),
      batchTotalAmount: matchXmlNumber(xml, ["BatchTotalAmount", "SettlementAmount", "TotalAmount"]) || 0,
      transactionCount: matchXmlNumber(xml, ["TransactionCount", "BatchTransactionCount"]) || 0,
    };
  }
  return {
    totalSales: matchXmlNumber(xml, ["TotalSales", "NetSales", "GrossSales", "SalesAmount", "transactionTotalAmt"]) || 0,
    transactionCount: matchXmlNumber(xml, ["TransactionCount", "TicketCount", "SalesCount"]) || 0,
    merchandiseSales: matchXmlNumber(xml, ["MerchandiseSalesAmount", "MCMSalesAmount", "SalesAmount"]) || 0,
    fuelSales: matchXmlNumber(xml, ["FuelGradeSalesAmount", "FuelSalesAmount"]) || 0,
  };
}

function normalizeConexxusRecords(xml: string, reportType: string): JsonValue[] {
  const recordNames = reportType === "tank"
    ? ["TankStockDetail", "Tank", "TankRecord"]
    : reportType === "fuel"
      ? ["FGMDetail", "FuelGradeMovement", "FuelGradeRecord", "FuelProduct"]
      : reportType === "batch"
        ? ["BatchDetail", "BatchSummary", "BatchRecord"]
        : reportType === "plu" || reportType === "item"
          ? ["ITTDetail", "PLU", "PricebookItem", "ItemMaintenance", "Item", "MCMDetail", "ItemLine"]
          : reportType === "department"
            ? ["Department", "DepartmentMovement", "DepartmentSummary", "DeptDetail"]
            : reportType === "category"
              ? ["Category", "CategoryMovement", "CategorySummary"]
              : reportType === "tax"
                ? ["Tax", "TaxLevel", "TaxSummary", "TaxDetail"]
                : reportType === "payment" || reportType === "network"
                  ? ["Payment", "Tender", "Network", "BatchSummary", "CardType"]
                  : reportType === "cashier" || reportType === "payroll"
                    ? ["Cashier", "CashierSummary", "Payroll", "Employee"]
                    : reportType === "esafe"
                      ? ["Safe", "ESafe", "SafeContent", "SafeDetail"]
                      : reportType === "carwash"
                        ? ["CarWash", "CarWashDetail", "CarWashPaypoint"]
                        : ["MCMDetail", "RetailTransaction", "SaleLine", "ItemLine"];
  return extractXmlRecords(xml, recordNames, 25);
}

function salesSnapshotFromConexxus(normalized: JsonObject, businessDate: string): JsonObject | null {
  const totals = asObject(normalized.totals || {});
  const totalSales = numberFrom(totals.totalSales, totals.merchandiseSales, totals.fuelSales);
  const fuelSales = numberFrom(totals.fuelSales);
  const transactionCount = numberFrom(totals.transactionCount);
  if (totalSales === null && fuelSales === null && transactionCount === null) return null;
  return {
    businessDate: String(normalized.businessDate || businessDate),
    totalSales: (totalSales || 0) + (totalSales === null ? (fuelSales || 0) : 0),
    transactionCount: transactionCount || 0,
    topItems: [],
  };
}

function findXmlText(xml: string, names: string[]): string | null {
  for (const name of names) {
    const pattern = new RegExp(`<(?:[^:>]+:)?${name}[^>]*>\\s*([^<]+)\\s*</(?:[^:>]+:)?${name}>`, "i");
    const match = xml.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function countTags(xml: string, names: string[]): number {
  return names.reduce((sum, name) => sum + (xml.match(new RegExp(`<(?:[^:>]+:)?${name}\\b`, "gi")) || []).length, 0);
}

function extractXmlRecords(xml: string, names: string[], limit: number): JsonValue[] {
  const records: JsonValue[] = [];
  for (const name of names) {
    const pattern = new RegExp(`<((?:[^:>]+:)?${name})\\b[^>]*>([\\s\\S]*?)</\\1>`, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(xml)) && records.length < limit) {
      records.push({
        recordType: name,
        id: findXmlText(match[0], ["ID", "SysID", "sysid", "TankID", "FuelGradeID", "NAXMLFuelGradeID", "BatchID", "TransactionID", "ItemCode", "PLUCode", "POSCode", "UPC", "upc", "pcode", "DepartmentID", "MerchandiseCode", "CategoryID", "TenderID", "CashierID"]) || findXmlAttribute(match[0], ["sysid", "id", "NAXMLFuelGradeID"]) || "",
        name: findXmlText(match[0], ["Name", "Description", "description", "FuelGradeName", "TankName", "ItemDescription", "DepartmentDescription", "CategoryDescription", "TenderName", "CashierName"]) || findXmlAttribute(match[0], ["name"]) || "",
        amount: matchXmlNumber(match[0], ["Amount", "amount", "SalesAmount", "TotalAmount", "NetSales", "PaymentAmount", "TenderAmount", "TaxAmount"]) || 0,
        quantity: matchXmlNumber(match[0], ["Quantity", "SalesQuantity", "Volume", "FuelGradeSalesVolume", "TransactionCount", "Count", "SellingUnits", "SellUnit"]) || 0,
        price: matchXmlNumber(match[0], ["Price", "RegularSellPrice", "UnitPrice", "CurrentPrice"]) || 0,
        department: findXmlText(match[0], ["Department", "department", "MerchandiseCode"]) || "",
        modifier: findXmlText(match[0], ["POSCodeModifier", "upcModifier"]) || "",
      });
    }
    if (records.length >= limit) break;
  }
  return records;
}

function findXmlAttribute(xml: string, names: string[]): string | null {
  const openTag = xml.match(/<[^>]+>/);
  if (!openTag) return null;
  for (const name of names) {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i");
    const match = openTag[0].match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function normalizeSalesJson(value: JsonValue, businessDate: string): JsonObject | null {
  const root = Array.isArray(value) ? { items: value } : asObject(value);
  const data = asObject(root.data || root.sales || root.report || root.summary || root);
  const totalSales = numberFrom(data.totalSales, data.total, data.netSales, data.grossSales, data.amount, data.salesAmount);
  const transactionCount = numberFrom(data.transactionCount, data.transactions, data.transaction_count, data.count, data.ticketCount);
  const itemList = Array.isArray(data.topItems) ? data.topItems : Array.isArray(data.items) ? data.items : Array.isArray(root.items) ? root.items : [];
  const topItems = itemList.slice(0, 10).map((item) => {
    const obj = asObject(item);
    return {
      name: String(obj.name || obj.description || obj.itemName || obj.sku || "Item"),
      quantity: numberFrom(obj.quantity, obj.qty, obj.count, obj.units) || 0,
      sales: numberFrom(obj.sales, obj.total, obj.amount, obj.netSales) || 0,
    };
  });
  if (totalSales === null && transactionCount === null && topItems.length === 0) return null;
  return {
    businessDate: String(data.businessDate || data.date || businessDate),
    totalSales: totalSales || 0,
    transactionCount: transactionCount || 0,
    topItems,
  };
}

function normalizeSalesText(text: string, businessDate: string): JsonObject | null {
  if (/<\s*(?:[^:>]+:)?Fault\b/i.test(text) || /<faultCode>/i.test(text)) return null;
  const xmlTotal = matchXmlNumber(text, ["netSales", "grossSales", "totalSales", "transactionTotalAmt", "salesAmount", "total"]);
  const xmlCount = matchXmlNumber(text, ["transactionCount", "transactions", "ticketCount", "count"]);
  const total = matchNumber(text, /(?:total|net|gross)\s*sales[^0-9-]*(-?\$?[0-9,]+(?:\.[0-9]+)?)/i);
  const count = matchNumber(text, /(?:transactions?|tickets?|count)[^0-9-]*([0-9,]+)/i);
  if (total === null && count === null && xmlTotal === null && xmlCount === null) return null;
  return {
    businessDate,
    totalSales: total || xmlTotal || 0,
    transactionCount: count || xmlCount || 0,
    topItems: [],
  };
}

function numberFrom(...values: JsonValue[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[$,]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function matchNumber(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  return numberFrom(match[1]);
}

function matchXmlNumber(text: string, names: string[]): number | null {
  for (const name of names) {
    const pattern = new RegExp(`<(?:[^:>]+:)?${name}[^>]*>\\s*([^<]+)\\s*</(?:[^:>]+:)?${name}>`, "i");
    const value = matchNumber(text, pattern);
    if (value !== null) return value;
  }
  return null;
}

async function executePdkCommand(body: JsonObject): Promise<JsonObject> {
  const commandId = requireString(body, "commandId");
  const definition = pdkCommandById(commandId);
  if (!definition) {
    return { ok: false, status: "unknown_command", message: `PDK command not found: ${commandId}` };
  }
  if (definition.mutating && !commanderWritesAllowed()) {
    return {
      ok: false,
      status: "blocked",
      commandId: definition.id,
      accessMode: accessMode(),
      message: "PDK update/control commands require access mode read_write or write_only.",
    };
  }
  const connection = store.getJson<JsonObject>("connections", "verifone", {});
  const commanderUrl = String(connection.commanderUrl || "").replace(/\/$/, "");
  const username = String(connection.username || "");
  const password = typeof connection.password === "string" ? decryptSecret(connection.password) : "";
  if (!commanderUrl || !username || !password) {
    return { ok: false, status: "not_configured", message: "Verifone connection is not configured." };
  }
  const params = asObject(body.params || {});
  const cookie = definition.cmd === "validate" ? "" : await pdkCookie(commanderUrl, username, password, connection);
  const url = buildPdkUrl(commanderUrl, definition, params, cookie, username, password);
  const owner = `pdk-${definition.cmd}`;
  const lease = store.acquireCommanderLease(owner, definition.mutating ? 180 : 60);
  if (lease.acquired !== true) {
    return { ok: false, status: "lease_blocked", message: "Commander command is already running.", lease };
  }
  try {
    const response = await fetchCommander(url, username, password, connection);
    const text = await response.text();
    const ok = response.ok && !isCommanderFault(text);
    const contentType = response.headers.get("content-type") || "";
    const reportType = definition.reportType || classifyConexxusReport(text, definition.category, xmlRootName(text));
    let savedReport: JsonObject | null = null;
    if (text.trim().startsWith("<") && !isCommanderFault(text)) {
      const normalized = normalizeCommanderXmlReport(text, contentType, reportType, String(params.businessDate || new Date().toISOString().slice(0, 10)));
      savedReport = store.saveCommanderReport({
        reportType: String(normalized?.reportType || reportType),
        businessDate: String(params.businessDate || new Date().toISOString().slice(0, 10)),
        source: `verifone-pdk:${definition.id}`,
        rootName: String(normalized?.rootName || xmlRootName(text)),
        xml: text,
        normalized: asObject(normalized?.normalized || { commandId: definition.id, cmd: definition.cmd }),
      });
    }
    store.appendActivity("verifone_pdk_command_executed", {
      commandId: definition.id,
      cmd: definition.cmd,
      category: definition.category,
      mutating: definition.mutating,
      ok,
      statusCode: response.status,
    });
    if (!ok) {
      const errorLog = recordErrorLog("warning", "verifone-pdk", definition.id, summarizeCommanderFault(text) || `PDK command failed with HTTP ${response.status}`, {
        commandId: definition.id,
        cmd: definition.cmd,
        category: definition.category,
        statusCode: response.status,
        fault: isCommanderFault(text) ? summarizeCommanderFault(text) : null,
      }, "", definition.id);
      savedReport = savedReport ? { ...savedReport, errorId: errorLog.id } : { errorId: errorLog.id };
    }
    return {
      ok,
      status: ok ? "completed" : "failed",
      command: sanitizePdkCommand(definition),
      request: {
        url: redactCommanderUrl(url),
      },
      response: {
        statusCode: response.status,
        contentType,
        bytes: text.length,
        fault: isCommanderFault(text) ? summarizeCommanderFault(text) : null,
      },
      report: savedReport,
      bodyPreview: text.slice(0, 1000),
    };
  } finally {
    store.releaseCommanderLease(owner);
  }
}

async function submitCommanderWriteBack(body: JsonObject): Promise<JsonObject> {
  if (!commanderWritesAllowed()) {
    return {
      ok: false,
      status: "blocked",
      accessMode: accessMode(),
      message: "Commander write-back requires access mode read_write or write_only.",
    };
  }
  const commandId = requireString(body, "commandId");
  const definition = pdkCommandById(commandId);
  if (!definition) return { ok: false, status: "unknown_command", message: `PDK command not found: ${commandId}` };
  if (!definition.mutating) {
    return { ok: false, status: "not_a_write_command", commandId, message: "Write-back requires a mutating PDK command." };
  }
  const xml = requireString(body, "xml");
  if (!xml.trim().startsWith("<")) throw new Error("xml must contain an XML document.");
  const params = asObject(body.params || {});
  const entityType = typeof body.entityType === "string" && body.entityType.trim() ? body.entityType.trim() : "commander_xml";
  const entityId = typeof body.entityId === "string" && body.entityId.trim() ? body.entityId.trim() : createHash("sha256").update(xml).digest("hex").slice(0, 16);
  const verification = withDefaultWriteVerification(commandId, asObject(body.verification || {}), xml, entityId);
  const transport = String(body.transport || "post_body");
  const payload: JsonObject = {
    commandId,
    params,
    xml,
    xmlSha256: createHash("sha256").update(xml).digest("hex"),
    transport,
    verification,
    submittedAt: new Date().toISOString(),
  };
  const queueItem = store.enqueue({
    target: "commander",
    entityType,
    entityId,
    operation: "pdk_xml_writeback",
    payload,
  });
  const startedAt = new Date().toISOString();
  store.appendActivity("commander_writeback_queued", {
    queueId: queueItem.id,
    commandId,
    entityType,
    entityId,
    xmlBytes: xml.length,
  });
  try {
    const writeResult = await executePdkXmlWrite(definition, params, xml, transport);
    const verifyResult = writeResult.ok ? await verifyCommanderWriteBack(verification, writeResult, xml) : {
      ok: false,
      status: "write_failed",
      message: "Write command failed, verification was skipped.",
    };
    const complete = writeResult.ok === true && verifyResult.ok === true;
    const finalStatus = complete ? "completed" : writeResult.ok ? "verification_failed" : "failed";
    const finalPayload: JsonObject = {
      ...payload,
      writeResult: summarizePdkExecution(writeResult),
      verificationResult: summarizePdkExecution(verifyResult),
      completedAt: new Date().toISOString(),
    };
    const updated = store.updateQueueItem(
      String(queueItem.id),
      finalStatus,
      complete ? null : String(verifyResult.message || writeResult.message || "Commander write-back did not verify."),
      finalPayload,
    );
    store.recordSyncAttempt({
      queueId: String(queueItem.id),
      target: "commander",
      startedAt,
      finishedAt: new Date().toISOString(),
      status: finalStatus,
      error: complete ? "" : String(verifyResult.message || writeResult.message || "verification failed"),
    });
    store.appendActivity(complete ? "commander_writeback_verified" : "commander_writeback_failed", {
      queueId: queueItem.id,
      commandId,
      status: finalStatus,
      verificationStatus: verifyResult.status,
    });
    if (!complete) {
      const errorLog = recordErrorLog(
        finalStatus === "failed" ? "critical" : "warning",
        "commander-writeback",
        commandId,
        String(verifyResult.message || writeResult.message || "Commander write-back did not verify."),
        { queueId: queueItem.id, entityType, entityId, finalStatus, write: summarizePdkExecution(writeResult), verification: summarizePdkExecution(verifyResult) },
        "",
        entityId,
      );
      finalPayload.errorId = errorLog.id;
    }
    return {
      ok: complete,
      status: finalStatus,
      queueItem: updated,
      write: writeResult,
      verification: verifyResult,
      errorId: finalPayload.errorId || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const updated = store.updateQueueItem(String(queueItem.id), "failed", message, { ...payload, failedAt: new Date().toISOString() });
    store.recordSyncAttempt({
      queueId: String(queueItem.id),
      target: "commander",
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "failed",
      error: message,
    });
    store.appendActivity("commander_writeback_failed", { queueId: queueItem.id, commandId, message });
    const errorLog = recordErrorLog("critical", "commander-writeback", commandId, message, { queueId: queueItem.id, entityType, entityId }, "", entityId);
    return { ok: false, status: "failed", queueItem: updated, message, errorId: errorLog.id };
  }
}

async function executePdkXmlWrite(definition: PdkCommand, params: JsonObject, xml: string, transport: string): Promise<JsonObject> {
  const connection = store.getJson<JsonObject>("connections", "verifone", {});
  const commanderUrl = String(connection.commanderUrl || "").replace(/\/$/, "");
  const username = String(connection.username || "");
  const password = typeof connection.password === "string" ? decryptSecret(connection.password) : "";
  if (!commanderUrl || !username || !password) {
    return { ok: false, status: "not_configured", message: "Verifone connection is not configured." };
  }
  const cookie = await pdkCookie(commanderUrl, username, password, connection);
  const writeParams = { ...params };
  if (transport === "query_param") {
    const xmlParamName = String(params.xmlParamName || "xml");
    writeParams[xmlParamName] = xml;
  }
  const url = buildPdkUrl(commanderUrl, definition, writeParams, cookie, username, password);
  const owner = `pdk-write-${definition.cmd}`;
  const lease = store.acquireCommanderLease(owner, 240);
  if (lease.acquired !== true) {
    return { ok: false, status: "lease_blocked", message: "Commander write is already running.", lease };
  }
  try {
    const init: RequestInit = transport === "query_param"
      ? {}
      : { method: "POST", headers: { "content-type": "application/xml; charset=utf-8" }, body: xml };
    const response = await fetchCommander(url, username, password, connection, init);
    const text = await response.text();
    const ok = response.ok && !isCommanderFault(text);
    return {
      ok,
      status: ok ? "submitted" : "failed",
      command: sanitizePdkCommand(definition),
      request: {
        method: transport === "query_param" ? "GET" : "POST",
        url: redactCommanderUrl(url),
        xmlSha256: createHash("sha256").update(xml).digest("hex"),
        xmlBytes: xml.length,
      },
      response: {
        statusCode: response.status,
        contentType: response.headers.get("content-type") || "",
        bytes: text.length,
        fault: isCommanderFault(text) ? summarizeCommanderFault(text) : null,
      },
      bodyPreview: text.slice(0, 1000),
    };
  } finally {
    store.releaseCommanderLease(owner);
  }
}

async function verifyCommanderWriteBack(verification: JsonObject, writeResult: JsonObject, xml: string): Promise<JsonObject> {
  if (typeof verification.expectedResponseContains === "string" && verification.expectedResponseContains) {
    const preview = String(writeResult.bodyPreview || "");
    const ok = preview.includes(verification.expectedResponseContains);
    return {
      ok,
      status: ok ? "response_matched" : "response_mismatch",
      message: ok ? "Write response matched expected text." : "Write response did not contain expected text.",
    };
  }
  if (typeof verification.commandId === "string" && verification.commandId) {
    const readResult = await executePdkCommand({
      commandId: verification.commandId,
      params: asObject(verification.params || {}),
    });
    const contains = typeof verification.expectedReadContains === "string" ? verification.expectedReadContains : "";
    const bodyPreview = String(readResult.bodyPreview || "");
    const containsOk = !contains || bodyPreview.includes(contains);
    return {
      ok: readResult.ok === true && containsOk,
      status: readResult.ok === true && containsOk ? "readback_verified" : "readback_failed",
      message: readResult.ok === true && containsOk
        ? "Verification read completed."
        : contains
          ? "Verification read did not contain expected text."
          : "Verification read failed.",
      read: summarizePdkExecution(readResult),
    };
  }
  const writeAccepted = writeResult.ok === true;
  return {
    ok: false,
    status: writeAccepted ? "verification_required" : "write_failed",
    message: writeAccepted
      ? "Commander accepted the XML write, but no read-back verification rule was available."
      : "Commander did not accept the XML write.",
    xmlSha256: createHash("sha256").update(xml).digest("hex"),
  };
}

function withDefaultWriteVerification(commandId: string, verification: JsonObject, xml: string, entityId: string): JsonObject {
  if (verification.commandId || verification.expectedResponseContains || verification.expectedReadContains) return verification;
  const expected = entityId || findXmlText(xml, ["ItemCode", "PLUCode", "FuelGradeID", "DepartmentID", "CategoryID", "ID"]) || "";
  if (commandId === "uPLUs") {
    return { commandId: "vPLUs", expectedReadContains: expected };
  }
  if (commandId === "ufuelprices" || commandId === "cfuelprices") {
    return { commandId: "vfuelprices", expectedReadContains: expected };
  }
  if (/^u.+cfg$/i.test(commandId)) {
    return { commandId: `v${commandId.slice(1)}`, expectedReadContains: expected };
  }
  if (/^u(.+)$/i.test(commandId)) {
    return { commandId: `v${commandId.slice(1)}`, expectedReadContains: expected };
  }
  return verification;
}

function summarizePdkExecution(result: JsonObject): JsonObject {
  const response = asObject(result.response || {});
  return {
    ok: result.ok === true,
    status: String(result.status || ""),
    commandId: String(asObject(result.command || {}).id || ""),
    statusCode: typeof response.statusCode === "number" ? response.statusCode : null,
    fault: response.fault || null,
  };
}

async function pdkCookie(commanderUrl: string, username: string, password: string, connection: JsonObject): Promise<string> {
  const state = store.getJson<JsonObject>("connections", "pdk-session", {});
  const expiresAt = typeof state.expiresAt === "string" ? Date.parse(state.expiresAt) : 0;
  if (typeof state.cookie === "string" && state.cookie && expiresAt > Date.now() + 60_000) {
    return decryptSecret(state.cookie);
  }
  const url = new URL(`${commanderUrl}/cgi-bin/CGILink`);
  url.searchParams.set("cmd", "validate");
  url.searchParams.set("user", username);
  url.searchParams.set("passwd", password);
  const response = await fetchCommander(url.toString(), username, password, connection);
  const text = await response.text();
  const cookie = extractPdkCookie(text);
  if (!response.ok || !cookie) {
    throw new Error(`PDK login failed: ${summarizeCommanderFault(text) || response.status}`);
  }
  store.setJson("connections", "pdk-session", {
    cookie: encryptSecret(cookie),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  store.appendActivity("verifone_pdk_login_succeeded", { expiresInMinutes: 15 });
  return cookie;
}

function buildPdkUrl(commanderUrl: string, definition: PdkCommand, params: JsonObject, cookie: string, username: string, password: string): string {
  const url = new URL(`${commanderUrl}/cgi-bin/CGILink`);
  url.searchParams.set("cmd", definition.cmd);
  if (definition.cmd === "validate") {
    url.searchParams.set("user", String(params.user || username));
    url.searchParams.set("passwd", String(params.passwd || password));
  } else {
    url.searchParams.set("cookie", String(params.cookie || cookie));
  }
  for (const [key, value] of Object.entries(definition.defaults || {})) {
    url.searchParams.set(key, value);
  }
  for (const key of definition.params) {
    if (key === "cookie" || key === "user" || key === "passwd") continue;
    const value = params[key];
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function extractPdkCookie(text: string): string {
  const patterns = [
    /<cookie[^>]*>\s*([^<\s]+)\s*<\/cookie>/i,
    /<Cookie[^>]*>\s*([^<\s]+)\s*<\/Cookie>/i,
    /cookie["'=:\s]+([A-Za-z0-9._:-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function isCommanderFault(text: string): boolean {
  return /<\s*(?:[^:>]+:)?Fault\b/i.test(text) || /<faultCode>/i.test(text);
}

function summarizeCommanderFault(text: string): string {
  return findXmlText(text, ["faultString", "faultCode", "message", "Message"]) || "";
}

function sanitizePdkCommand(command: PdkCommand): JsonObject {
  return {
    id: command.id,
    cmd: command.cmd,
    category: command.category,
    params: command.params,
    mutating: command.mutating,
    description: command.description,
    deprecated: command.deprecated === true,
    reportType: command.reportType || null,
    defaults: command.defaults || {},
  };
}

function heartbeatWorkerStatus(): JsonObject {
  const sync = syncState();
  const heartbeat = asObject(sync.heartbeat || {});
  return {
    enabled: heartbeatWorkerEnabled,
    intervalMs: heartbeatWorkerIntervalMs,
    lastRunAt: heartbeat.workerLastRunAt || null,
    lastResult: heartbeat.workerLastResult || null,
    nextCheckAt: heartbeat.nextCheckAt || null,
  };
}

function runHeartbeatWorkerOnce(): JsonObject {
  const connection = store.getJson<JsonObject>("connections", "verifone", {});
  const configuredPassword = typeof connection.password === "string" ? decryptSecret(connection.password) : "";
  if (!connection.commanderUrl || !connection.username || !configuredPassword) {
    return { checked: false, reason: "verifone_not_configured" };
  }
  const current = syncState();
  const heartbeat = asObject(current.heartbeat || {});
  const nextCheckAt = typeof heartbeat.nextCheckAt === "string" ? Date.parse(heartbeat.nextCheckAt) : 0;
  if (nextCheckAt > Date.now()) {
    return { checked: false, reason: "backoff_active", nextCheckAt: heartbeat.nextCheckAt || null };
  }
  const result = validateVerifoneConnection({ source: "heartbeat_worker" });
  const latest = syncState();
  const latestHeartbeat = asObject(latest.heartbeat || {});
  saveSyncState({
    heartbeat: {
      ...latestHeartbeat,
      workerLastRunAt: new Date().toISOString(),
      workerLastResult: result.status,
    },
  });
  store.appendActivity("heartbeat_worker_checked", { status: result.status, ok: result.ok === true });
  return { checked: true, result };
}

function startHeartbeatWorker(): void {
  if (!heartbeatWorkerEnabled) {
    store.appendActivity("heartbeat_worker_disabled", { intervalMs: heartbeatWorkerIntervalMs });
    return;
  }
  const tick = () => {
    try {
      runHeartbeatWorkerOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.appendActivity("heartbeat_worker_failed", { error: message });
      recordErrorLog("warning", "heartbeat-worker", "heartbeat-check", message);
    }
  };
  setTimeout(tick, Math.min(5_000, heartbeatWorkerIntervalMs)).unref();
  setInterval(tick, heartbeatWorkerIntervalMs).unref();
  store.appendActivity("heartbeat_worker_started", { intervalMs: heartbeatWorkerIntervalMs });
}

const addonDefinitions: JsonObject[] = [
  {
    id: "verifone-fcc",
    name: "FCC",
    category: "payments",
    bundled: false,
    enabledByDefault: false,
    dependsOn: ["verifone-commander"],
    scopes: ["fcc.status.read", "fcc.sync.write"],
    queueTarget: "verifone-fcc",
  },
  {
    id: "verifone-loyalty",
    name: "Loyalty",
    category: "loyalty",
    bundled: false,
    enabledByDefault: false,
    dependsOn: ["verifone-commander"],
    scopes: ["loyalty.status.read", "loyalty.sync.write"],
    queueTarget: "verifone-loyalty",
  },
];

function addonState(): JsonObject {
  return store.getJson<JsonObject>("addons", "installations", {});
}

function addonStatus(id: string): JsonObject {
  const definition = addonDefinitions.find((addon) => addon.id === id);
  if (!definition) return {};
  const state = asObject(addonState()[id] || {});
  const connector = store.connectorStatus();
  return {
    ...definition,
    installed: state.installed === true,
    enabled: state.enabled === true,
    status: state.enabled === true ? "enabled" : state.installed === true ? "installed" : "available",
    activatedAt: state.activatedAt || null,
    marketplaceRequired: true,
    dependencyReady: connector.status === "activated",
    lastSyncAt: state.lastSyncAt || null,
    lastError: state.lastError || null,
  };
}

function addonsStatus(): JsonObject {
  return {
    addOns: addonDefinitions.map((addon) => addonStatus(String(addon.id))),
  };
}

function saveAddonState(id: string, patch: JsonObject): JsonObject {
  const definition = addonDefinitions.find((addon) => addon.id === id);
  if (!definition) throw new Error(`Unknown add-on: ${id}`);
  const state = addonState();
  const current = asObject(state[id] || {});
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  state[id] = next;
  store.setJson("addons", "installations", state);
  return addonStatus(id);
}

function remoteAccessStatus(): JsonObject {
  const config = store.getJson<JsonObject>("remote-access", "config", {
    provider: "cloudflare",
    enabled: false,
    tunnelId: "",
    publicUrl: "",
    updatedAt: null,
  });
  return {
    ...config,
    ready: config.enabled === true && Boolean(config.publicUrl),
    localBaseUrl: localBaseUrlFromString(""),
    inboundEndpoint: "/api/messages/inbound",
    requirements: ["connector activation", "signed inbound messages", "tunnel identity", "local admin access"],
  };
}

function adapterStatus(): JsonObject {
  const connector = store.connectorStatus();
  const addons = addonsStatus().addOns as JsonObject[];
  return {
    edgeDevice: true,
    adapters: [
      {
        id: "verifone-commander",
        name: "POS/BOS",
        type: "core",
        status: connector.status === "activated" ? "configured" : "pending_activation",
        read: true,
        write: commanderWritesAllowed(),
      },
      {
        id: "verifone-fcc",
        name: "FCC",
        type: "addon",
        status: asObject(addons.find((addon) => addon.id === "verifone-fcc") || {}).status || "available",
        read: asObject(addons.find((addon) => addon.id === "verifone-fcc") || {}).enabled === true,
        write: asObject(addons.find((addon) => addon.id === "verifone-fcc") || {}).enabled === true && commanderWritesAllowed(),
      },
      {
        id: "verifone-loyalty",
        name: "Loyalty",
        type: "addon",
        status: asObject(addons.find((addon) => addon.id === "verifone-loyalty") || {}).status || "available",
        read: asObject(addons.find((addon) => addon.id === "verifone-loyalty") || {}).enabled === true,
        write: asObject(addons.find((addon) => addon.id === "verifone-loyalty") || {}).enabled === true && commanderWritesAllowed(),
      },
      { id: "hardware", name: "Hardware", type: "future", status: "not_implemented", read: false, write: false },
      { id: "network", name: "Network", type: "future", status: "not_implemented", read: false, write: false },
      { id: "tlog", name: "TLog", type: "future", status: "not_implemented", read: false, write: false },
      { id: "mcp", name: "MCP", type: "contract", status: "contract_available", read: true, write: false },
    ],
  };
}

function mcpTools(): JsonObject {
  return {
    protocol: "mcp-compatible-tool-contract",
    transport: "local-http and stdio",
    stdioCommand: "npm run start:mcp",
    tools: [
      { name: "verifone.sales.query", endpoint: "/api/sales/query", mutating: false, scopes: ["sales.read"] },
      { name: "verifone.commander.data_query", endpoint: "/api/commander/data-query", mutating: false, scopes: ["commander.local.read", "inventory.read", "fuel.read", "tank.read"] },
      { name: "verifone.commander.entities", endpoint: "/api/verifone/entities", mutating: false, scopes: ["commander.local.read"] },
      { name: "verifone.learning.examples", endpoint: "/api/learning/examples", mutating: false, scopes: ["learning.read"] },
      { name: "verifone.queue.enqueue", endpoint: "/api/queue/enqueue", mutating: true, scopes: ["sync.write"] },
      { name: "verifone.commander.writeback", endpoint: "/api/commander/writeback", mutating: true, scopes: ["sync.write", "commander.write"] },
      { name: "verifone.health.read", endpoint: "/api/diagnostics", mutating: false, scopes: ["diagnostics.read"] },
      { name: "verifone.fcc.status", endpoint: "/api/addons/fcc/status", mutating: false, scopes: ["fcc.status.read"], optionalAddOn: true },
      { name: "verifone.loyalty.status", endpoint: "/api/addons/loyalty/status", mutating: false, scopes: ["loyalty.status.read"], optionalAddOn: true },
    ],
  };
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

function activeConnectorSharedSecret(): string {
  if (connectorSharedSecret) return connectorSharedSecret;
  const credentials = store.getJson<JsonObject>("connector", "credentials", {});
  return typeof credentials.sharedSecret === "string" ? credentials.sharedSecret : "";
}

function verifyConnectorSignature(req: IncomingMessage, bodyText: string, registration: JsonObject): { ok: boolean; reason?: string } {
  const sharedSecret = activeConnectorSharedSecret();
  if (!sharedSecret) {
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
  const expected = createHmac("sha256", sharedSecret).update(`${timestamp}.${nonce}.${tenantId}.${agentId}.${bodyText}`).digest("hex");
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
  if (/\b(plu|sku|upc|item|inventory|price|fuel|tank|batch|payment|tax|department|category)\b/.test(text)) {
    return { intent: "commander_data_query", target: "local-db", operation: "query_commander_data" };
  }
  if (/\b(sync|push|pull|update commander|send to commander)\b/.test(text)) {
    return { intent: "sync_command", target: "commander", operation: "sync" };
  }
  if (/\b(health|status|diagnostic|logs?|is it running)\b/.test(text)) {
    return { intent: "health_check", target: "diagnostics", operation: "inspect" };
  }
  return { intent: "general_question", target: "shre", operation: "answer" };
}

function inferCommanderReportType(query: string, explicit = ""): string {
  if (explicit) return explicit.trim().toLowerCase();
  const text = query.toLowerCase();
  if (/\b(fuel|grade|gas|price)\b/.test(text)) return "fuel";
  if (/\b(tank|atg|volume|water)\b/.test(text)) return "tank";
  if (/\b(batch|settlement)\b/.test(text)) return "batch";
  if (/\b(payment|tender|mop|card)\b/.test(text)) return "payment";
  if (/\b(tax)\b/.test(text)) return "tax";
  if (/\b(department|dept)\b/.test(text)) return "department";
  if (/\b(category)\b/.test(text)) return "category";
  if (/\b(plu|sku|upc|item|inventory)\b/.test(text)) return "plu";
  return "";
}

function answerCommanderDataQuery(query: string, reportType = "", limit = 10): JsonObject {
  const inferredReportType = inferCommanderReportType(query, reportType);
  const entities = store.commanderEntities(Math.min(Math.max(limit, 1), 25), inferredReportType, "");
  if (entities.length === 0) {
    return {
      status: "queued",
      requiresDataSource: true,
      answer: inferredReportType
        ? `No local ${inferredReportType} data is available yet. Pull Commander XML for that report type first.`
        : "No local Commander entity data is available yet. Pull Commander XML first.",
      query,
      reportType: inferredReportType || null,
      data: [],
    };
  }
  const preview = entities.slice(0, 5).map((entity) => {
    const name = String(entity.entityName || entity.entityKey || entity.entityType || "record");
    const parts = [name];
    if (entity.price !== null && entity.price !== undefined) parts.push(`price ${Number(entity.price).toFixed(2)}`);
    if (entity.quantity !== null && entity.quantity !== undefined && Number(entity.quantity) !== 0) parts.push(`qty ${Number(entity.quantity).toFixed(3)}`);
    if (entity.amount !== null && entity.amount !== undefined && Number(entity.amount) !== 0) parts.push(`amount ${Number(entity.amount).toFixed(2)}`);
    return parts.join(" ");
  }).join("; ");
  return {
    status: "answered",
    requiresDataSource: false,
    answer: `Found ${entities.length} local Commander ${inferredReportType || "entity"} record(s). ${preview}`,
    query,
    reportType: inferredReportType || null,
    data: entities,
  };
}

function normalizeSource(value: string): string {
  const source = value.trim().toLowerCase().replace(/_/g, "-");
  const aliases: Record<string, string> = {
    shrechat: "shre-chat",
    shre: "shre-chat",
    gateway: "message-gateway",
    "messagegateway": "message-gateway",
    "whats-app": "whatsapp",
    "meta-whatsapp": "whatsapp",
    anthropic: "claude",
    "claude-desktop": "claude",
    openai: "codex",
  };
  return aliases[source] || source || "unknown";
}

function textFromJson(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const object = value as JsonObject;
  for (const key of ["messageText", "text", "prompt", "content", "query"]) {
    if (typeof object[key] === "string" && String(object[key]).trim()) return String(object[key]);
  }
  const message = asObject(object.message || {});
  for (const key of ["text", "content", "body"]) {
    if (typeof message[key] === "string" && String(message[key]).trim()) return String(message[key]);
  }
  if (Array.isArray(object.messages)) {
    const latest = object.messages.map(asObject).reverse().find((item) => typeof item.content === "string" || typeof item.text === "string");
    if (latest) return String(latest.content || latest.text || "");
  }
  return "";
}

function normalizeInboundMessage(body: JsonObject, registration: JsonObject): JsonObject {
  const context = asObject(body.context || {});
  const message = asObject(body.message || {});
  const source = normalizeSource(String(body.source || body.channel || body.provider || context.source || "unknown"));
  return {
    source,
    tenantId: typeof body.tenantId === "string" ? body.tenantId : String(context.tenantId || registration.tenantId || ""),
    workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : String(context.workspaceId || registration.workspaceId || ""),
    storeId: typeof body.storeId === "string" ? body.storeId : String(context.storeId || registration.storeId || ""),
    userId: String(body.userId || body.senderId || body.from || message.from || context.userId || ""),
    messageId: String(body.messageId || body.id || message.id || randomUUID()),
    messageText: textFromJson(body).trim(),
    businessDate: typeof body.businessDate === "string" ? body.businessDate : String(context.businessDate || ""),
    rawShape: {
      hasMessageObject: Boolean(body.message && typeof body.message === "object"),
      hasMessagesArray: Array.isArray(body.messages),
      keys: Object.keys(body).slice(0, 20),
    },
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "store";
}

async function shreSignupActivate(body: JsonObject): Promise<JsonObject> {
  const email = requireString(body, "email").toLowerCase();
  const password = requireString(body, "password");
  const company = requireString(body, "company");
  const workspaceName = typeof body.workspaceName === "string" && body.workspaceName.trim() ? body.workspaceName.trim() : company;
  const storeName = typeof body.storeName === "string" && body.storeName.trim() ? body.storeName.trim() : "Main Store";
  const storeCode = typeof body.storeCode === "string" && body.storeCode.trim() ? body.storeCode.trim() : slug(storeName);
  const localManifest = store.connectorManifest(localBaseUrlFromString(typeof body.localBaseUrl === "string" ? body.localBaseUrl : ""));
  const hostInfo = {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  };

  let activation: JsonObject;
  if (shreAuthSignupUrl) {
    const response = await fetch(shreAuthSignupUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        company,
        workspaceName,
        storeName,
        storeCode,
        app: "verifone_cstoresku",
        connectorId: "verifone-commander",
        localManifest,
        host: hostInfo,
      }),
    });
    const payload = await response.json().catch(() => ({})) as JsonObject;
    if (!response.ok) {
      throw new Error(String(payload.message || payload.error || `Shre Auth signup failed with HTTP ${response.status}`));
    }
    activation = payload;
  } else {
    const base = `${email}|${company}|${storeCode}`;
    activation = {
      status: "activated",
      tenantId: `tenant_${slug(company)}_${createHash("sha256").update(email).digest("hex").slice(0, 8)}`,
      workspaceId: `workspace_${slug(workspaceName)}_${createHash("sha256").update(`${email}|${workspaceName}`).digest("hex").slice(0, 8)}`,
      storeId: `store_${slug(storeCode)}_${createHash("sha256").update(base).digest("hex").slice(0, 8)}`,
      connectorId: "verifone-commander",
      connectorName: "Verifone Commander",
      registryUrl: connectorRegistryUrl,
      sharedSecret: randomBytes(32).toString("hex"),
      allowedSources: ["shre-chat", "message-gateway", "whatsapp", "claude", "codex", "shre-cli"],
      entitlementState: "active",
      billingEndpoint: shreCostEndpoint || "",
      mode: "local_first",
      cloudRelayEnabled: true,
      simulated: true,
    };
  }

  const tenantId = String(activation.tenantId || "");
  const workspaceId = String(activation.workspaceId || activation.workspace || "");
  const storeId = String(activation.storeId || "");
  const sharedSecret = String(activation.sharedSecret || activation.connectorSharedSecret || "");
  if (!tenantId || !workspaceId || !storeId || !sharedSecret) {
    throw new Error("Shre activation response must include tenantId, workspaceId, storeId, and sharedSecret");
  }
  const registration = store.saveConnectorRegistration({
    connectorId: String(activation.connectorId || "verifone-commander"),
    connectorName: String(activation.connectorName || "Verifone Commander"),
    tenantId,
    workspaceId,
    storeId,
    app: "verifone_cstoresku",
    mode: String(activation.mode || "local_first"),
    cloudRelayEnabled: activation.cloudRelayEnabled !== false,
    registryUrl: String(activation.registryUrl || connectorRegistryUrl),
    relatedConnectors: ["rapidrms-api"],
  });
  store.setJson("connector", "credentials", {
    sharedSecret,
    allowedSources: Array.isArray(activation.allowedSources) ? activation.allowedSources : ["shre-chat", "message-gateway", "whatsapp", "claude", "codex", "shre-cli"],
    billingEndpoint: typeof activation.billingEndpoint === "string" ? activation.billingEndpoint : "",
    activatedVia: shreAuthSignupUrl ? "shre-auth" : "local-simulated-shre-auth",
    activatedEmail: email,
    activatedAt: new Date().toISOString(),
  });
  store.setJson("profile", "current", {
    ...store.getJson<JsonObject>("profile", "current", {}),
    company,
    workspaceId,
    workspaceName,
    storeId,
    contactEmail: email,
  });
  const auth = authState();
  auth.remoteValidation = {
    state: String(activation.entitlementState || activation.status || "active") === "active" ? "valid" : String(activation.entitlementState || activation.status),
    entitlementState: String(activation.entitlementState || activation.status || "active"),
    lastCheckedAt: new Date().toISOString(),
    message: shreAuthSignupUrl ? "Shre Auth signup and connector activation succeeded." : "Local simulated Shre Auth activation succeeded.",
    keyVersion: typeof activation.keyVersion === "string" ? activation.keyVersion : "",
    refreshedAt: new Date().toISOString(),
  };
  store.setJson("auth", "local-login", auth);
  return {
    ok: true,
    registration,
    tenantId,
    workspaceId,
    storeId,
    connectorId: registration.connectorId,
    registryUrl: registration.registryUrl,
    cloudRelayEnabled: registration.cloudRelayEnabled,
    allowedSources: Array.isArray(activation.allowedSources) ? activation.allowedSources : [],
    entitlementState: asObject(auth.remoteValidation || {}).entitlementState || "active",
    simulated: activation.simulated === true,
  };
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
  const sync = syncState();
  const cstoresku = asObject(sync.cstoresku || {});
  const sales = store.latestSalesSnapshot();
  const auth = authState();
  const usage = store.usageSummary(25);
  const mode = accessMode();
  const errors = store.errorSummary();

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

  if (Number(errors.open || 0) > 0) {
    const highest = String(errors.highestOpenSeverity || "warning");
    items.push(notification(
      "error_log_open",
      highest === "critical" ? "critical" : "warning",
      "Open error log items",
      `${errors.open} unresolved error(s) need review.`,
      "Open health error log",
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
  } else {
    if (connector.cloudRelayEnabled === true && !activeConnectorSharedSecret()) {
      items.push(notification(
        "connector_secret_missing",
        "critical",
        "Shre connector needs signing secret",
        "Cloud/message gateway routing is activated but no connector signing secret is available.",
        "Open marketplace registration",
      ));
    }
    const remote = asObject(auth.remoteValidation || {});
    if (connector.cloudRelayEnabled === true && remote.state === "offline_pending") {
      items.push(notification(
        "shre_connector_validation_offline",
        "warning",
        "Shre connector validation is offline",
        "Local work can continue, but cloud relay and billing validation need Shre Auth connectivity.",
        "Review login status",
      ));
    }
  }

  if (connection.applicationKey) {
    const cstoreskuStatus = String(cstoresku.status || "not_linked");
    const linked = cstoresku.linked === true;
    const healthyStatuses = new Set(["linked", "synced", "active", "ready"]);
    if (!linked || !healthyStatuses.has(cstoreskuStatus)) {
      items.push(notification(
        "cstoresku_link_attention",
        "critical",
        "CStoreSKU link needs attention",
        `CStoreSKU key is configured, but link status is ${cstoreskuStatus}.`,
        "Open Verifone setup",
      ));
    }
  }

  if (mode === "read_only") {
    items.push(notification(
      "commander_read_only",
      "info",
      "Commander writes are disabled",
      "Inventory updates and Commander write commands are blocked in read-only mode.",
      "Open marketplace registration",
    ));
  } else if (mode === "write_only") {
    items.push(notification(
      "commander_write_only",
      "warning",
      "Commander reads are disabled",
      "Sales read/query workflows are blocked in write-only mode.",
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
    } else if (remote.state === "suspended") {
      items.push(notification(
        "account_suspended",
        "critical",
        "Account is suspended",
        String(remote.message || "Reactivate billing or resolve the account hold to resume chat and cloud relay."),
        "Reactivate account",
      ));
    } else if (remote.state === "deactivated") {
      items.push(notification(
        "account_deactivated",
        "critical",
        "Account is deactivated",
        String(remote.message || "Reactivate this install before using chat and cloud relay."),
        "Reactivate account",
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

function currentReadiness(): JsonObject {
  const checks: JsonObject[] = [];
  const add = (id: string, ok: boolean, severity: string, message: string): void => {
    checks.push({ id, ok, severity, message });
  };
  const connection = store.getJson<JsonObject>("connections", "verifone", {});
  const verifoneStatus = store.getJson<JsonObject | null>("connections", "verifone-status", null);
  const connector = store.connectorStatus();
  const credentials = store.getJson<JsonObject>("connector", "credentials", {});
  const auth = authState();
  const remote = asObject(auth.remoteValidation || {});
  const sales = store.latestSalesSnapshot();
  const queue = store.queueSummary();

  add("local_login_configured", auth.configured === true, "critical", "Local login secret is configured.");
  add("shre_auth_signup_configured", Boolean(shreAuthSignupUrl), "warning", "Production Shre Auth signup URL is configured.");
  add("connector_activated", connector.status === "activated", "critical", "Connector is activated.");
  add("tenant_id", Boolean(connector.tenantId), "critical", "Tenant ID is present.");
  add("workspace_id", Boolean(connector.workspaceId), "critical", "Workspace ID is present.");
  add("store_id", Boolean(connector.storeId), "critical", "Store ID is present.");
  add("connector_secret", Boolean(activeConnectorSharedSecret()), "critical", "Connector signing secret is available.");
  add("access_mode_configured", ["read_only", "read_write", "write_only"].includes(accessMode()), "critical", "Commander access mode is configured.");
  add("cloud_relay", connector.cloudRelayEnabled === true, "warning", "Cloud relay is enabled.");
  add("entitlement_active", !["suspended", "deactivated", "rejected"].includes(String(remote.entitlementState || remote.state || "")), "critical", "Entitlement is active or not blocking local work.");
  add("verifone_configured", Boolean(connection.commanderUrl && connection.username && connection.password), "critical", "Verifone connection is configured.");
  add("verifone_connected", Boolean(verifoneStatus && verifoneStatus.status === "connected"), "critical", "Verifone connection has validated.");
  add("sales_data_available", Boolean(sales), "warning", "Local sales data is available.");
  add("queue_not_failed", Number(queue.failed || 0) === 0, "critical", "Queue has no failed work.");
  add("cost_endpoint_configured", Boolean(shreCostEndpoint || credentials.billingEndpoint), "warning", "Usage billing endpoint is configured.");

  const blockers = checks.filter((check) => check.ok !== true && check.severity === "critical");
  const warnings = checks.filter((check) => check.ok !== true && check.severity !== "critical");
  return {
    ready: blockers.length === 0,
    productionReady: blockers.length === 0 && warnings.length === 0,
    blockers,
    warnings,
    checks,
    nextSteps: [...blockers, ...warnings].map((check) => check.message),
  };
}

function versionInfo(): JsonObject {
  return {
    app: "verifone-commander-shre-cstoresku",
    version: appVersion,
    buildChannel,
    buildSha,
    environment: process.env.SHRE_ENV || "local",
    cacheKey: `${appVersion}-${buildChannel}-${buildSha}`,
    services: {
      dashboardApi: appVersion,
      fccConnector: process.env.FCC_CONNECTOR_VERSION || appVersion,
    },
    timestamp: new Date().toISOString(),
  };
}

function capabilitiesInfo(): JsonObject {
  return {
    app: "verifone-commander-shre-cstoresku",
    version: appVersion,
    buildChannel,
    buildSha,
    capabilities: {
      errorLog: true,
      commanderWriteBack: true,
      verifiedWriteBack: true,
      pdkCatalog: true,
      pdkCommandTotal: pdkCommandCatalog.length,
      localLoginApiGuard: true,
      typedLocalProjections: true,
      conexxusFamilies: ["sales", "batch", "fuel", "tank", "journal", "plu", "department", "category", "tax", "payment", "cashier", "payroll", "esafe", "carwash", "loyalty"],
    },
    timestamp: new Date().toISOString(),
  };
}

function localBaseUrl(req: IncomingMessage): string {
  if (localBaseUrlOverride) return localBaseUrlOverride.replace(/\/$/, "");
  const requestHost = String(req.headers.host || `localhost:${port}`);
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `cstoresku:${port}`, `cstoresku.local:${port}`]);
  const safeHost = allowedHosts.has(requestHost.toLowerCase()) ? requestHost : `localhost:${port}`;
  return `http://${safeHost}`;
}

function localBaseUrlFromString(value: string): string {
  if (value) return value.replace(/\/$/, "");
  return localBaseUrlOverride || `http://localhost:${port}`;
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

async function diskFreeBytes(path: string): Promise<number | null> {
  try {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

function storagePolicy(): JsonObject {
  const fallbackBackupPath = join(homedir(), "VerifoneCommanderBackups");
  const policy = store.getJson<JsonObject>("storage", "policy", {});
  const retentionDays = normalizeRetentionDays(policy.retentionDays, 30);
  return {
    retentionDays,
    retentionOptions,
    backupEnabled: policy.backupEnabled === true,
    backupTarget: typeof policy.backupTarget === "string" ? policy.backupTarget : "local_folder",
    localBackupPath: typeof policy.localBackupPath === "string" && policy.localBackupPath.trim() ? policy.localBackupPath.trim() : fallbackBackupPath,
    shrePlatformSynologyEnabled: policy.shrePlatformSynologyEnabled === true,
    remoteArchiveStatus: policy.shrePlatformSynologyEnabled === true ? "configured_pending_cloud_upload" : "not_configured",
    lastBackup: policy.lastBackup || null,
    updatedAt: policy.updatedAt || null,
  };
}

function normalizeStoragePolicy(body: JsonObject): JsonObject {
  const current = storagePolicy();
  const retentionDays = normalizeRetentionDays(body.retentionDays, Number(current.retentionDays));
  const backupTarget = ["local_folder", "shre_platform_synology", "both"].includes(String(body.backupTarget)) ? String(body.backupTarget) : String(current.backupTarget);
  return {
    retentionDays,
    retentionOptions,
    backupEnabled: body.backupEnabled === true || body.backupEnabled === "true",
    backupTarget,
    localBackupPath: typeof body.localBackupPath === "string" && body.localBackupPath.trim() ? body.localBackupPath.trim() : String(current.localBackupPath),
    shrePlatformSynologyEnabled: body.shrePlatformSynologyEnabled === true || body.shrePlatformSynologyEnabled === "true" || backupTarget === "shre_platform_synology" || backupTarget === "both",
    updatedAt: new Date().toISOString(),
    lastBackup: current.lastBackup || null,
  };
}

function normalizeRetentionDays(value: JsonValue | undefined, fallback: number): number {
  const days = Math.floor(Number(value));
  if (!Number.isFinite(days)) return fallback;
  return Math.min(3650, Math.max(1, days));
}

async function storageOverview(): Promise<JsonObject> {
  const storage = await directorySize(runtimeRoot);
  const freeBytes = await diskFreeBytes(runtimeRoot);
  const policy = storagePolicy();
  return {
    policy,
    runtimeRoot,
    database: store.path(),
    storage,
    disk: {
      freeBytes,
    },
    analysis: store.storageAnalysis(Number(policy.retentionDays), storage.bytes, freeBytes),
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!enforceJsonRequest(req, res) || !enforceLocalOrigin(req, res)) return;
  if (!enforceLocalAdmin(req, res, path)) return;

  if (path === "/api/health") {
    const storage = await directorySize(runtimeRoot);
    const freeBytes = await diskFreeBytes(runtimeRoot);
    const policy = storagePolicy();
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
      disk: { freeBytes },
      retention: {
        days: policy.retentionDays,
        backupEnabled: policy.backupEnabled,
        backupTarget: policy.backupTarget,
        storageRisk: store.storageAnalysis(Number(policy.retentionDays), storage.bytes, freeBytes).risk,
      },
      timestamp: new Date().toISOString(),
      version: versionInfo(),
    });
    return;
  }

  if (path === "/api/version") {
    sendJson(res, 200, versionInfo());
    return;
  }

  if (path === "/api/capabilities") {
    sendJson(res, 200, capabilitiesInfo());
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

  if (path === "/api/auth/refresh-key" && req.method === "POST") {
    await validateLoginRemote("refresh_key");
    const state = authState();
    store.appendActivity("auth_key_refresh_checked", {
      entitlementState: entitlementState(),
      remoteValidation: asObject(state.remoteValidation || {}).state || "unknown",
    });
    sendJson(res, 200, state);
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

  if (path === "/api/setup/first-run" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const loginSecret = requireString(body, "loginSecret");
      const profile: JsonObject = {
        workspaceName: requireString(body, "workspaceName"),
        storeId: optionalString(body, "storeId"),
        corporateName: optionalString(body, "corporateName"),
        dba: requireString(body, "dba"),
        address: optionalString(body, "address"),
        phone: optionalString(body, "phone"),
        email: requireString(body, "email").toLowerCase(),
        contactName: optionalString(body, "contactName"),
        timezone: optionalString(body, "timezone") || "America/New_York",
        updatedAt: new Date().toISOString(),
      };
      const existing = authState();
      if (existing.configured === true && !validSession(req) && localAdminToken) {
        sendJson(res, 401, { error: "Existing login must be authenticated before changing setup" });
        return;
      }
      const verification = await captureFirstRunSetup(profile);
      store.setJson("profile", "current", profile);
      store.setJson("setup", "email-verification", verification);
      store.setJson("auth", "local-login", {
        configured: true,
        secretHash: hashSecret(loginSecret),
        updatedAt: new Date().toISOString(),
        remoteValidation: {
          state: shreAuthValidateUrl ? "pending" : "not_configured",
          lastCheckedAt: null,
          message: shreAuthValidateUrl ? "Remote validation pending." : "Remote validation endpoint is not configured.",
        },
      });
      store.setJson("onboarding", "current", {
        completedSteps: ["local-login", "workspace-profile"],
        currentStep: "verifone",
        updatedAt: new Date().toISOString(),
      });
      store.appendActivity("first_run_setup_completed", {
        workspaceName: profile.workspaceName,
        dba: profile.dba,
        email: profile.email,
        emailVerificationState: verification.state,
      });
      const verified = ["verified", "dev_verified", "simulated_verified"].includes(String(verification.state));
      if (emailVerificationRequired && !verified) {
        sendJson(res, 202, { ok: true, session: null, profile, emailVerification: verification, message: "Email verification required before dashboard access." });
        return;
      }
      sendJson(res, 200, { ok: true, session: createSession(), profile, emailVerification: verification });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/setup/email-verification") {
    sendJson(res, 200, store.getJson("setup", "email-verification", {
      state: "not_started",
      provider: shreSetupCaptureUrl ? "shre-platform" : "local-simulated",
      required: emailVerificationRequired,
    }));
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
      cstoreskuKeyConfigured: Boolean(connection.applicationKey),
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
        salesEndpoint: optionalString(body, "salesEndpoint"),
        updatedAt: new Date().toISOString(),
      };
      store.setJson("connections", "verifone", connection);
      markLocalPullScheduled("verifone_config_saved");
      store.appendActivity("verifone_config_saved", { commanderUrl: connection.commanderUrl });
      sendJson(res, 200, { ok: true, connection: redactConnection(connection), sync: syncState() });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/cstoresku/key" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const applicationKey = requireString(body, "applicationKey");
      const connection = store.getJson<JsonObject>("connections", "verifone", {});
      connection.applicationKey = encryptSecret(applicationKey);
      connection.applicationKeyUpdatedAt = new Date().toISOString();
      connection.updatedAt = new Date().toISOString();
      store.setJson("connections", "verifone", connection);
      markCstoreskuLinked("cstoresku_key_saved");
      store.appendActivity("cstoresku_key_saved", { configured: true });
      sendJson(res, 200, { ok: true, cstoreskuKeyConfigured: true, connection: redactConnection(connection), sync: syncState() });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/shre/activation-token" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const activationToken = requireString(body, "activationToken");
      const profile = store.getJson<JsonObject>("profile", "current", {});
      const registration = store.saveConnectorRegistration({
        connectorId: "verifone-commander",
        connectorName: "Verifone Commander",
        tenantId: optionalString(body, "tenantId") || `tenant_${slug(String(profile.corporateName || profile.dba || "local"))}`,
        workspaceId: optionalString(body, "workspaceId") || `workspace_${slug(String(profile.workspaceName || "default"))}`,
        storeId: optionalString(body, "storeId") || String(profile.storeId || `store_${slug(String(profile.dba || "main"))}`),
        app: "verifone_cstoresku",
        registryUrl: optionalString(body, "registryUrl") || connectorRegistryUrl,
        sharedSecret: randomBytes(32).toString("hex"),
        cloudRelayEnabled: true,
        allowedSources: ["shre-chat", "whatsapp", "claude", "codex"],
        relatedConnectors: ["rapidrms-api"],
      });
      store.setJson("connector", "activation-token", {
        token: encryptSecret(activationToken),
        source: "dashboard-ui",
        storedAt: new Date().toISOString(),
      });
      store.appendActivity("shre_activation_token_saved", { workspaceId: registration.workspaceId, storeId: registration.storeId });
      markCstoreskuLinked("shre_activation_token_saved");
      sendJson(res, 200, { ok: true, status: registration.status, tenantId: registration.tenantId, workspaceId: registration.workspaceId, storeId: registration.storeId });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/verifone/validate" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const validation = validateVerifoneConnection(body);
    const ok = validation.ok === true;
    sendJson(res, ok ? 200 : 503, validation);
    return;
  }

  if (path === "/api/verifone/ping" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const ping = pingVerifoneConnection(body);
    sendJson(res, ping.ok === true ? 200 : 503, ping);
    return;
  }

  if (path === "/api/verifone/heartbeat") {
    if (req.method === "GET") {
      sendJson(res, 200, syncState());
      return;
    }
    if (req.method === "POST") {
      const body = asObject(await requestBody(req));
      const current = syncState();
      const heartbeat = asObject(current.heartbeat || {});
      const nextCheckAt = typeof heartbeat.nextCheckAt === "string" ? Date.parse(heartbeat.nextCheckAt) : 0;
      if (body.force !== true && nextCheckAt > Date.now()) {
        sendJson(res, 202, {
          skipped: true,
          reason: "backoff_active",
          nextCheckAt: heartbeat.nextCheckAt,
          sync: current,
        });
        return;
      }
      const validation = validateVerifoneConnection(body);
      sendJson(res, validation.ok ? 200 : 503, { validation, sync: syncState() });
      return;
    }
  }

  if (path === "/api/verifone/pull-sales" && req.method === "POST") {
    const result = await pullCommanderSales(asObject(await requestBody(req)));
    sendJson(res, result.ok === true ? 200 : result.status === "lease_blocked" ? 423 : 502, result);
    return;
  }

  if (path === "/api/verifone/pull-report" && req.method === "POST") {
    const result = await pullCommanderReport(asObject(await requestBody(req)));
    sendJson(res, result.ok === true ? 200 : result.status === "lease_blocked" ? 423 : 502, result);
    return;
  }

  if (path === "/api/verifone/reports") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const reportType = url.searchParams.get("type") || "";
    sendJson(res, 200, {
      summary: store.commanderReportSummary(),
      reports: store.commanderReports(50, reportType),
    });
    return;
  }

  if (path === "/api/verifone/entities") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    sendJson(res, 200, {
      summary: store.commanderEntitySummary(),
      entities: store.commanderEntities(
        Number(url.searchParams.get("limit") || 100),
        url.searchParams.get("reportType") || "",
        url.searchParams.get("entityType") || "",
      ),
    });
    return;
  }

  if (path === "/api/verifone/pdk/commands") {
    sendJson(res, 200, {
      total: pdkCommandCatalog.length,
      commands: pdkCommandCatalog.map(sanitizePdkCommand),
      categories: [...new Set(pdkCommandCatalog.map((item) => item.category))].sort(),
    });
    return;
  }

  if (path === "/api/verifone/pdk/execute" && req.method === "POST") {
    const result = await executePdkCommand(asObject(await requestBody(req)));
    sendJson(res, result.ok === true ? 200 : result.status === "blocked" ? 403 : result.status === "lease_blocked" ? 423 : 502, result);
    return;
  }

  if (path === "/api/commander/writeback" && req.method === "POST") {
    try {
      const result = await submitCommanderWriteBack(asObject(await requestBody(req)));
      sendJson(res, result.ok === true ? 200 : result.status === "blocked" ? 403 : result.status === "lease_blocked" ? 423 : 502, result);
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/sync/status") {
    updateCommanderWriteBackState();
    sendJson(res, 200, syncState());
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
      if (blockCommanderWriteIfNeeded(res, body)) return;
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
    const failedItems = items.filter((item) => asObject(item).status === "failed").map((item) => asObject(item));
    let errorId: JsonValue = null;
    if (failedItems.length > 0) {
      const errorLog = recordErrorLog("critical", "offline-queue", "replay", "One or more queue items failed replay.", {
        failedCount: failedItems.length,
        failedItems: failedItems.map((item) => ({
          id: item.id,
          target: item.target,
          operation: item.operation,
          entityType: item.entityType,
          entityId: item.entityId,
          lastError: item.lastError,
        })),
      });
      errorId = errorLog.id || null;
    }
    sendJson(res, 200, { ...result, errorId });
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
      messageContract: "/api/messages/contract",
      activity: "/api/activity",
      errors: "/api/errors",
      messageAudit: "/api/messages/audit",
      notifications: "/api/notifications",
      readiness: "/api/readiness",
      accessMode: "/api/access-mode",
      addons: "/api/addons",
      adapters: "/api/adapters",
      remoteAccess: "/api/remote-access",
      mcpTools: "/api/mcp/tools",
      usage: "/api/usage/summary",
      firstRunSetup: "/api/setup/first-run",
      emailVerification: "/api/setup/email-verification",
      shreActivationToken: "/api/shre/activation-token",
      syncStatus: "/api/sync/status",
      heartbeat: "/api/verifone/heartbeat",
      heartbeatWorker: "/api/heartbeat/worker",
      verifonePing: "/api/verifone/ping",
      verifoneEntities: "/api/verifone/entities",
      storagePolicy: "/api/storage/policy",
      storageAnalysis: "/api/storage/analysis",
      storageBackup: "/api/storage/backup",
      storageRetentionApply: "/api/storage/retention/apply",
      shreSignupActivate: "/api/shre/signup-activate",
      commanderWriteBack: "/api/commander/writeback",
      activitySummary: store.activitySummary(),
      errorSummary: store.errorSummary(),
    });
    return;
  }

  if (path === "/api/notifications") {
    sendJson(res, 200, currentNotifications());
    return;
  }

  if (path === "/api/heartbeat/worker") {
    if (req.method === "GET") {
      sendJson(res, 200, heartbeatWorkerStatus());
      return;
    }
    if (req.method === "POST") {
      const result = runHeartbeatWorkerOnce();
      sendJson(res, 200, { ...heartbeatWorkerStatus(), ...result });
      return;
    }
  }

  if (path === "/api/readiness") {
    sendJson(res, 200, currentReadiness());
    return;
  }

  if (path === "/api/access-mode") {
    if (req.method === "GET") {
      sendJson(res, 200, accessModeState());
      return;
    }
    if (req.method === "POST") {
      try {
        const body = asObject(await requestBody(req));
        const mode = normalizeAccessMode(requireString(body, "mode"));
        const state = {
          mode,
          updatedAt: new Date().toISOString(),
          source: "dashboard-api",
        };
        store.setJson("config", "access-mode", state);
        updateCommanderWriteBackState();
        store.appendActivity("access_mode_updated", { mode });
        sendJson(res, 200, state);
      } catch (error) {
        badRequest(res, error instanceof Error ? error.message : String(error));
      }
      return;
    }
  }

  if (path === "/api/storage/policy") {
    if (req.method === "GET") {
      sendJson(res, 200, storagePolicy());
      return;
    }
    if (req.method === "POST") {
      const policy = normalizeStoragePolicy(asObject(await requestBody(req)));
      store.setJson("storage", "policy", policy);
      store.appendActivity("storage_policy_updated", {
        retentionDays: policy.retentionDays,
        backupEnabled: policy.backupEnabled,
        backupTarget: policy.backupTarget,
      });
      sendJson(res, 200, policy);
      return;
    }
  }

  if (path === "/api/storage/analysis") {
    sendJson(res, 200, await storageOverview());
    return;
  }

  if (path === "/api/storage/backup" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const current = storagePolicy();
    const backupPath = typeof body.localBackupPath === "string" && body.localBackupPath.trim() ? body.localBackupPath.trim() : String(current.localBackupPath);
    const backup = await store.backupRuntime(backupPath);
    const next = {
      ...current,
      backupEnabled: true,
      lastBackup: {
        createdAt: backup.createdAt,
        path: backup.path,
        target: "local_folder",
      },
      updatedAt: new Date().toISOString(),
    };
    store.setJson("storage", "policy", next);
    store.appendActivity("runtime_backup_created", { path: backup.path });
    sendJson(res, 201, { ...backup, policy: next });
    return;
  }

  if (path === "/api/storage/retention/apply" && req.method === "POST") {
    const policy = storagePolicy();
    const result = store.applyRetention(Number(policy.retentionDays));
    store.appendActivity("storage_retention_applied", {
      retentionDays: result.retentionDays,
      cutoff: result.cutoff,
      deletions: result.deletions,
    });
    sendJson(res, 200, { ...result, overview: await storageOverview() });
    return;
  }

  if (path === "/api/addons") {
    sendJson(res, 200, addonsStatus());
    return;
  }

  if (path === "/api/addons/activate" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const id = requireString(body, "id");
      const status = saveAddonState(id, {
        installed: true,
        enabled: body.enabled !== false,
        activatedAt: new Date().toISOString(),
        source: typeof body.source === "string" ? body.source : "marketplace",
        scopes: Array.isArray(body.scopes) ? body.scopes : addonDefinitions.find((addon) => addon.id === id)?.scopes || [],
      });
      store.appendActivity("addon_activated", { id, enabled: status.enabled });
      sendJson(res, 200, status);
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/addons/fcc/status") {
    sendJson(res, 200, addonStatus("verifone-fcc"));
    return;
  }

  if (path === "/api/addons/loyalty/status") {
    sendJson(res, 200, addonStatus("verifone-loyalty"));
    return;
  }

  if (path === "/api/adapters") {
    sendJson(res, 200, adapterStatus());
    return;
  }

  if (path === "/api/mcp/tools") {
    sendJson(res, 200, mcpTools());
    return;
  }

  if (path === "/api/remote-access") {
    if (req.method === "GET") {
      sendJson(res, 200, remoteAccessStatus());
      return;
    }
    if (req.method === "POST") {
      const body = asObject(await requestBody(req));
      const config = {
        provider: typeof body.provider === "string" ? body.provider : "cloudflare",
        enabled: body.enabled === true,
        tunnelId: typeof body.tunnelId === "string" ? body.tunnelId : "",
        publicUrl: typeof body.publicUrl === "string" ? body.publicUrl : "",
        updatedAt: new Date().toISOString(),
      };
      store.setJson("remote-access", "config", config);
      store.appendActivity("remote_access_updated", { provider: config.provider, enabled: config.enabled });
      sendJson(res, 200, remoteAccessStatus());
      return;
    }
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
      errors: store.errorLog(200, "all"),
      activity: store.activity(200),
    };
    const saved = store.saveDiagnosticBundle(bundle);
    store.appendActivity("diagnostics_bundle_created", { id: bundle.id });
    sendJson(res, 201, saved);
    return;
  }

  if (path === "/api/activity") {
    sendJson(res, 200, { events: store.activity(250) });
    return;
  }

  if (path === "/api/errors") {
    if (req.method === "GET") {
      const status = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("status") || "open";
      sendJson(res, 200, { summary: store.errorSummary(), errors: store.errorLog(250, status) });
      return;
    }
    if (req.method === "POST") {
      try {
        const body = asObject(await requestBody(req));
        const errorLog = recordErrorLog(
          typeof body.severity === "string" ? body.severity : "warning",
          typeof body.source === "string" ? body.source : "manual",
          typeof body.operation === "string" ? body.operation : "manual",
          requireString(body, "message"),
          asObject(body.details || {}),
          typeof body.correlationId === "string" ? body.correlationId : "",
          typeof body.entityId === "string" ? body.entityId : "",
        );
        store.appendActivity("error_log_recorded", { id: errorLog.id, severity: errorLog.severity, source: errorLog.source });
        sendJson(res, 201, errorLog);
      } catch (error) {
        badRequest(res, error instanceof Error ? error.message : String(error));
      }
      return;
    }
  }

  if (path === "/api/errors/resolve" && req.method === "POST") {
    try {
      const body = asObject(await requestBody(req));
      const resolved = store.resolveError(requireString(body, "id"), asObject(body.resolution || {}));
      if (!resolved) {
        sendJson(res, 404, { error: "Error log item not found" });
        return;
      }
      store.appendActivity("error_log_resolved", { id: resolved.id, severity: resolved.severity, source: resolved.source });
      sendJson(res, 200, resolved);
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
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
      workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : "",
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

  if (path === "/api/shre/signup-activate" && req.method === "POST") {
    try {
      const activation = await shreSignupActivate(asObject(await requestBody(req)));
      store.appendActivity("shre_auth_signup_activated", {
        tenantId: activation.tenantId,
        storeId: activation.storeId,
        simulated: activation.simulated,
      });
      sendJson(res, 200, activation);
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/connectors/catalog") {
    sendJson(res, 200, store.connectorCatalog());
    return;
  }

  if (path === "/api/messages/contract") {
    sendJson(res, 200, {
      schemaVersion: "2026-05-09",
      endpoint: "/api/messages/inbound",
      signing: {
        algorithm: "hmac-sha256",
        baseString: "timestamp.nonce.tenantId.agentId.rawBody",
        requiredHeaders: ["x-shre-timestamp", "x-shre-nonce", "x-shre-tenant-id", "x-shre-agent-id", "x-shre-signature"],
      },
      supportedSources: ["shre-chat", "message-gateway", "whatsapp", "claude", "codex", "shre-cli"],
      acceptedPayloads: [
        { shape: "canonical", required: ["source", "tenantId", "storeId", "messageText"], optional: ["messageId", "userId", "businessDate"] },
        { shape: "gateway", required: ["channel", "tenantId", "storeId", "message.text"], optional: ["message.id", "senderId", "context.businessDate"] },
        { shape: "assistant", required: ["provider", "messages[].content"], optional: ["context.tenantId", "context.storeId"] },
      ],
      response: {
        accepted: "boolean",
        intent: "sales_query | sync_command | health_check | general_question",
        message: "human-readable response",
        gatewayResponse: "stable response object for connector.aros.live and future gateways",
      },
    });
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
    if (!commanderReadsAllowed()) {
      sendJson(res, 403, {
        error: "Commander read blocked",
        accessMode: accessMode(),
        message: "Sales reads require access mode read_only or read_write.",
      });
      return;
    }
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

  if (path === "/api/commander/data-query" && req.method === "POST") {
    if (!commanderReadsAllowed()) {
      sendJson(res, 403, {
        error: "Commander read blocked",
        accessMode: accessMode(),
        message: "Commander local data queries require access mode read_only or read_write.",
      });
      return;
    }
    const body = asObject(await requestBody(req));
    const query = typeof body.query === "string" && body.query.trim() ? body.query.trim() : "commander data";
    const reportType = typeof body.reportType === "string" ? body.reportType : "";
    const limit = typeof body.limit === "number" ? body.limit : 10;
    const result = answerCommanderDataQuery(query, reportType, limit);
    store.appendActivity("commander_data_query_answered", {
      status: result.status,
      reportType: result.reportType,
      requiresDataSource: result.requiresDataSource,
    });
    sendJson(res, result.status === "answered" ? 200 : 202, result);
    return;
  }

  if (path === "/api/messages/inbound" && req.method === "POST") {
    try {
      if (blockMeteredAction(res)) return;
      const bodyText = await requestText(req);
      const registration = store.connectorStatus();
      const signature = verifyConnectorSignature(req, bodyText, registration);
      if (!signature.ok) {
        sendJson(res, 401, { error: "Invalid connector signature", reason: signature.reason || "invalid_signature" });
        return;
      }
      const body = asObject(bodyText ? JSON.parse(bodyText) as JsonValue : {});
      const inbound = normalizeInboundMessage(body, registration);
      const messageText = requireString(inbound, "messageText");
      const source = String(inbound.source || "unknown");
      const tenantId = String(inbound.tenantId || "");
      const workspaceId = String(inbound.workspaceId || "");
      const storeId = String(inbound.storeId || "");
      if (registration.status === "activated" && (
        tenantId !== registration.tenantId ||
        storeId !== registration.storeId ||
        (registration.workspaceId && workspaceId !== registration.workspaceId)
      )) {
        sendJson(res, 403, { error: "Inbound tenant/workspace/store does not match local connector activation" });
        return;
      }
      const allowedSources = new Set(["shre-chat", "message-gateway", "whatsapp", "claude", "codex", "shre-cli", "unknown"]);
      if (!allowedSources.has(source)) {
        sendJson(res, 403, { error: "Inbound source is not allowed" });
        return;
      }
      const userId = String(inbound.userId || "");
      const classification = classifyMessage(messageText);
      if (classification.target === "commander" && !commanderWritesAllowed()) {
        sendJson(res, 403, {
          error: "Commander write blocked",
          accessMode: accessMode(),
          message: "Commander write commands are blocked in read-only mode.",
        });
        return;
      }
      if ((classification.intent === "sales_query" || classification.intent === "commander_data_query") && !commanderReadsAllowed()) {
        sendJson(res, 403, {
          error: "Commander read blocked",
          accessMode: accessMode(),
          message: "Commander local data reads are blocked in write-only mode.",
        });
        return;
      }
      const connectorResponse = classification.intent === "sales_query"
        ? store.answerSalesQuery(messageText, typeof inbound.businessDate === "string" && inbound.businessDate ? inbound.businessDate : undefined)
        : classification.intent === "commander_data_query"
          ? answerCommanderDataQuery(messageText, typeof body.reportType === "string" ? body.reportType : "")
        : {
            status: "queued",
            answer: "Message accepted locally and queued for processing.",
          };
      const queueItem = store.enqueue({
        target: classification.target,
        entityType: "message",
        entityId: String(inbound.messageId || randomUUID()),
        operation: classification.operation,
        payload: {
          source,
          tenantId,
          workspaceId,
          storeId,
          userId,
          messageText,
          intent: classification.intent,
          businessDate: String(inbound.businessDate || ""),
          rawShape: asObject(inbound.rawShape || {}),
          receivedAt: new Date().toISOString(),
        },
      });
      const usage = recordUsage(source, tenantId, storeId, classification.intent === "sales_query" ? "local-sales-query" : "local-commander-data-query", messageText, String(connectorResponse.answer || ""), {
        intent: classification.intent,
        queueId: queueItem.id,
      });
      const learning = recordLearningCandidate(source, tenantId, storeId, classification.intent, classification.operation, messageText, String(connectorResponse.answer || ""), {
        queueId: queueItem.id,
        gateway: true,
      });
      const response = {
        accepted: true,
        mode: registration.cloudRelayEnabled ? "cloud_relay" : "local_first",
        source,
        tenantId,
        workspaceId,
        storeId,
        intent: classification.intent,
        queuedOperation: queueItem.id,
        message: String(connectorResponse.answer || "Message accepted locally and queued for processing."),
        connectorResponse,
        usage,
        learning,
        gatewayResponse: {
          schemaVersion: "2026-05-09",
          connectorId: registration.connectorId || "verifone-commander",
          tenantId,
          workspaceId,
          storeId,
          source,
          messageId: String(inbound.messageId || ""),
          status: connectorResponse.status || "queued",
          text: String(connectorResponse.answer || "Message accepted locally and queued for processing."),
          tool: classification.target,
          usageId: usage.id || "",
        },
      };
      const audit = store.saveChatAudit({
        source,
        tenantId,
        workspaceId,
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
        messageId: inbound.messageId,
      });
      sendJson(res, 202, { ...response, auditId: audit.id });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/chat/local" && req.method === "POST") {
    try {
      if (blockMeteredAction(res)) return;
      const body = asObject(await requestBody(req));
      const messageText = requireString(body, "messageText");
      const connector = store.connectorStatus();
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : String(connector.tenantId || "");
      const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : String(connector.workspaceId || "");
      const storeId = typeof body.storeId === "string" ? body.storeId : String(connector.storeId || "");
      const classification = classifyMessage(messageText);
      if (classification.target === "commander" && !commanderWritesAllowed()) {
        sendJson(res, 403, {
          error: "Commander write blocked",
          accessMode: accessMode(),
          message: "Commander write commands are blocked in read-only mode.",
        });
        return;
      }
      if ((classification.intent === "sales_query" || classification.intent === "commander_data_query") && !commanderReadsAllowed()) {
        sendJson(res, 403, {
          error: "Commander read blocked",
          accessMode: accessMode(),
          message: "Commander local data reads are blocked in write-only mode.",
        });
        return;
      }
      const connectorResponse = classification.intent === "sales_query"
        ? store.answerSalesQuery(messageText, typeof body.businessDate === "string" ? body.businessDate : undefined)
        : classification.intent === "commander_data_query"
          ? answerCommanderDataQuery(messageText, typeof body.reportType === "string" ? body.reportType : "")
        : {
            status: "answered",
            requiresDataSource: false,
            answer: "I can answer local sales questions now. Commander write commands and richer model tools are planned for the next phase.",
          };
      const answer = String(connectorResponse.answer || "No answer available.");
      const usage = recordUsage("local-chat", tenantId, storeId, "local-tool-router", messageText, answer, {
        intent: classification.intent,
        tool: classification.intent === "sales_query" ? "sales_query" : "local_help",
      });
      const learning = recordLearningCandidate("local-chat", tenantId, storeId, classification.intent, classification.operation, messageText, answer, {
        dashboard: true,
      });
      const audit = store.saveChatAudit({
        source: "local-chat",
        tenantId,
        workspaceId,
        storeId,
        userId: typeof body.userId === "string" ? body.userId : "local-dashboard",
        messageText,
        intent: classification.intent,
        status: String(connectorResponse.status || "answered"),
        response: {
          message: answer,
          connectorResponse,
          usage,
          learning,
        },
      });
      store.appendActivity("local_chat_answered", {
        intent: classification.intent,
        auditId: audit.id,
        usageId: usage.id,
      });
      sendJson(res, 200, {
        accepted: true,
        intent: classification.intent,
        message: answer,
        connectorResponse,
        usage,
        learning,
        auditId: audit.id,
      });
    } catch (error) {
      badRequest(res, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (path === "/api/messages/audit") {
    sendJson(res, 200, { messages: store.chatAudit(100) });
    return;
  }

  if (path === "/api/learning/examples") {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    sendJson(res, 200, {
      examples: store.learningExamples(
        Number(url.searchParams.get("limit") || 100),
        url.searchParams.get("status") || "",
      ),
      policy: {
        rawXmlIncluded: false,
        approvalRequired: true,
        exportDestinations: ["shre-rag", "shre-finetune"],
      },
    });
    return;
  }

  if (path === "/api/learning/approve" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const id = requireString(body, "id");
    const example = store.approveLearningExample(id);
    if (!example) {
      sendJson(res, 404, { error: "Learning example not found" });
      return;
    }
    store.appendActivity("learning_example_approved", { id, intent: example.intent });
    sendJson(res, 200, example);
    return;
  }

  if (path === "/api/usage/summary") {
    sendJson(res, 200, store.usageSummary(100));
    return;
  }

  if (path === "/api/usage/replay" && req.method === "POST") {
    const body = asObject(await requestBody(req));
    const result = store.replayUsageReports(body.forceFailure === true);
    store.appendActivity("usage_reports_replayed", {
      pendingReport: asObject(result.usage || {}).pendingReport || 0,
      reported: asObject(result.usage || {}).reported || 0,
      failedReport: asObject(result.usage || {}).failedReport || 0,
    });
    sendJson(res, 200, result);
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
      const message = error instanceof Error ? error.message : String(error);
      const errorLog = recordErrorLog("critical", "dashboard-api", `${req.method || "GET"} ${url.pathname}`, message, {
        requestId,
        path: url.pathname,
        method: req.method || "GET",
      }, requestId);
      sendJson(res, 500, { error: redactSensitiveText(message), errorId: errorLog.id, requestId });
    });
  });
  server.listen(port, host, () => {
    console.log(`dashboard-api listening on http://${host}:${port}`);
  });
  validateLoginRemote("startup").catch(() => undefined);
  startHeartbeatWorker();
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
