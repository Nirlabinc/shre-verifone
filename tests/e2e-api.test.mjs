import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";

const port = 20_000 + Math.floor(Math.random() * 20_000);
const baseUrl = `http://127.0.0.1:${port}`;
const connectorSecret = "test-connector-secret";

async function waitForHealth(child) {
  const deadline = Date.now() + 10_000;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error("dashboard-api exited before becoming healthy");
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("dashboard-api did not become healthy");
}

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

function signedBody(body, tenantId = "tenant_rapid_001") {
  const text = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const agentId = "e2e-agent";
  const signature = createHmac("sha256", connectorSecret)
    .update(`${timestamp}.${nonce}.${tenantId}.${agentId}.${text}`)
    .digest("hex");
  return {
    body: text,
    headers: {
      "x-shre-timestamp": timestamp,
      "x-shre-nonce": nonce,
      "x-shre-tenant-id": tenantId,
      "x-shre-agent-id": agentId,
      "x-shre-signature": `sha256=${signature}`,
    },
  };
}

test("local-first onboarding, password, queue, and diagnostics flow", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "verifone-shre-e2e-"));
  const child = spawn(process.execPath, ["dist/apps/dashboard-api/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VERIFONE_SHRE_HOME: runtimeRoot,
      CONNECTOR_REGISTRY_URL: "https://connector.aros.live",
      CONNECTOR_SHARED_SECRET: connectorSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForHealth(child).catch((error) => {
      throw new Error(`${error.message}\n${output}`);
    });

    const health = await json("/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.runtimeRoot, runtimeRoot);
    assert.match(health.body.database, /runtime\.sqlite$/);
    await access(health.body.database);

    const onboarding = await json("/api/onboarding", {
      method: "POST",
      body: JSON.stringify({ completedSteps: ["profile"], currentStep: "verifone" }),
    });
    assert.equal(onboarding.response.status, 200);
    assert.equal(onboarding.body.currentStep, "verifone");

    const profile = await json("/api/profile", {
      method: "POST",
      body: JSON.stringify({
        company: "Rapid Infosoft LLC",
        storeId: "store_001",
        contactEmail: "info@rapidinfosoft.com",
        timezone: "America/New_York",
      }),
    });
    assert.equal(profile.response.status, 200);
    assert.equal(profile.body.ok, true);

    const config = await json("/api/verifone/config", {
      method: "POST",
      body: JSON.stringify({
        commanderUrl: "http://192.0.2.10",
        username: "manager",
        password: "secret-value",
        applicationKey: "app-key",
      }),
    });
    assert.equal(config.response.status, 200);
    assert.equal(config.body.connection.password, "***");
    assert.equal(config.body.connection.applicationKey, "***");

    const validation = await json("/api/verifone/validate", {
      method: "POST",
      body: JSON.stringify({ daysRemaining: 8 }),
    });
    assert.equal(validation.response.status, 200);
    assert.equal(validation.body.status, "connected");

    const passwordStatus = await json("/api/password/status");
    assert.equal(passwordStatus.body.state, "expiring");
    assert.equal(passwordStatus.body.daysRemaining, 8);

    const failedReset = await json("/api/password/auto-reset", {
      method: "POST",
      body: JSON.stringify({ forceFailure: true, daysRemaining: 8 }),
    });
    assert.equal(failedReset.response.status, 409);
    assert.equal(failedReset.body.userActionRequired, true);

    const manualUpdate = await json("/api/password/manual-update", {
      method: "POST",
      body: JSON.stringify({ newPassword: "new-secret", daysRemaining: 90 }),
    });
    assert.equal(manualUpdate.response.status, 200);
    assert.equal(manualUpdate.body.state, "valid");

    const queueItem = await json("/api/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        target: "shre",
        entityType: "event",
        entityId: "evt-local-1",
        operation: "send",
        payload: { eventName: "sales_query_asked" },
      }),
    });
    assert.equal(queueItem.response.status, 201);
    assert.equal(queueItem.body.status, "pending");

    const connector = await json("/api/connector/activate", {
      method: "POST",
      body: JSON.stringify({
        connectorId: "verifone-commander",
        connectorName: "Verifone Commander",
        tenantId: "tenant_rapid_001",
        storeId: "store_001",
        app: "verifone_cstoresku",
        cloudRelayEnabled: true,
        relatedConnectors: ["rapidrms-api"],
      }),
    });
    assert.equal(connector.response.status, 200);
    assert.equal(connector.body.status, "activated");
    assert.equal(connector.body.cloudRelayEnabled, true);
    assert.equal(connector.body.registryUrl, "https://connector.aros.live");
    assert.deepEqual(connector.body.relatedConnectors, ["rapidrms-api"]);

    const catalog = await json("/api/connectors/catalog");
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.registryUrl, "https://connector.aros.live");
    assert.deepEqual(catalog.body.connectors.map((item) => item.connectorId), ["rapidrms-api", "verifone-commander"]);

    const manifest = await json("/api/connector/manifest");
    assert.equal(manifest.response.status, 200);
    assert.equal(manifest.body.connectorId, "verifone-commander");
    assert.equal(manifest.body.publisher.name, "Rapid Infosoft LLC");
    assert.equal(manifest.body.runtime.database, "sqlite");
    assert.ok(manifest.body.tools.some((tool) => tool.id === "verifone:sales-query"));
    assert.ok(manifest.body.relatedConnectors.includes("rapidrms-api"));

    const snapshot = await json("/api/sales/snapshot", {
      method: "POST",
      body: JSON.stringify({
        businessDate: "2026-05-09",
        totalSales: 1842.55,
        transactionCount: 91,
        topItems: [{ name: "Regular Coffee", quantity: 38, sales: 76.0 }],
        source: "commander-report-fixture",
      }),
    });
    assert.equal(snapshot.response.status, 201);
    assert.equal(snapshot.body.businessDate, "2026-05-09");
    assert.equal(snapshot.body.totalSales, 1842.55);

    const salesQuery = await json("/api/sales/query", {
      method: "POST",
      body: JSON.stringify({ query: "What were sales today?", businessDate: "2026-05-09" }),
    });
    assert.equal(salesQuery.response.status, 200);
    assert.equal(salesQuery.body.status, "answered");
    assert.match(salesQuery.body.answer, /\$1842\.55/);

    const unsignedInbound = await json("/api/messages/inbound", {
      method: "POST",
      body: JSON.stringify({
        source: "whatsapp",
        tenantId: "tenant_rapid_001",
        storeId: "store_001",
        userId: "operator_1",
        messageId: "msg_001",
        messageText: "What were sales today?",
      }),
    });
    assert.equal(unsignedInbound.response.status, 401);

    const signedInbound = signedBody({
      source: "whatsapp",
      tenantId: "tenant_rapid_001",
      storeId: "store_001",
      userId: "operator_1",
      messageId: "msg_001",
      messageText: "What were sales today?",
    });
    const inbound = await json("/api/messages/inbound", {
      method: "POST",
      ...signedInbound,
    });
    assert.equal(inbound.response.status, 202);
    assert.equal(inbound.body.intent, "sales_query");
    assert.equal(inbound.body.mode, "cloud_relay");
    assert.equal(inbound.body.connectorResponse.status, "answered");
    assert.match(inbound.body.message, /\$1842\.55/);
    assert.ok(inbound.body.queuedOperation);

    const replayedInbound = await json("/api/messages/inbound", {
      method: "POST",
      ...signedInbound,
    });
    assert.equal(replayedInbound.response.status, 401);
    assert.equal(replayedInbound.body.reason, "replayed_nonce");

    const mismatchedInbound = signedBody({
      source: "whatsapp",
      tenantId: "tenant_wrong",
      storeId: "store_001",
      userId: "operator_1",
      messageId: "msg_002",
      messageText: "What were sales today?",
    }, "tenant_wrong");
    const mismatch = await json("/api/messages/inbound", {
      method: "POST",
      ...mismatchedInbound,
    });
    assert.equal(mismatch.response.status, 403);

    const audit = await json("/api/messages/audit");
    assert.equal(audit.response.status, 200);
    assert.equal(audit.body.messages.at(-1).intent, "sales_query");

    const lease = await json("/api/commander/lease/acquire", {
      method: "POST",
      body: JSON.stringify({ owner: "worker-a", ttlSeconds: 60 }),
    });
    assert.equal(lease.response.status, 200);
    assert.equal(lease.body.acquired, true);

    const blockedLease = await json("/api/commander/lease/acquire", {
      method: "POST",
      body: JSON.stringify({ owner: "worker-b", ttlSeconds: 60 }),
    });
    assert.equal(blockedLease.response.status, 423);
    assert.equal(blockedLease.body.acquired, false);
    assert.equal(blockedLease.body.owner, "worker-a");

    const releaseLease = await json("/api/commander/lease/release", {
      method: "POST",
      body: JSON.stringify({ owner: "worker-a" }),
    });
    assert.equal(releaseLease.response.status, 200);
    assert.equal(releaseLease.body.released, true);

    const replay = await json("/api/queue/replay", { method: "POST", body: JSON.stringify({}) });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.items.every((item) => item.status === "completed"), true);

    const bundle = await json("/api/diagnostics/bundle", { method: "POST", body: JSON.stringify({}) });
    assert.equal(bundle.response.status, 201);
    assert.equal(bundle.body.ok, true);
    assert.equal(bundle.body.storage, "sqlite:diagnostic_bundles");
    await access(bundle.body.path);
    assert.ok((await stat(bundle.body.path)).size > 0);

    const activity = await json("/api/activity");
    const names = activity.body.events.map((event) => event.eventName);
    assert.ok(names.includes("profile_saved"));
    assert.ok(names.includes("verifone_connection_validated"));
    assert.ok(names.includes("sales_snapshot_saved"));
    assert.ok(names.includes("sales_query_answered"));
    assert.ok(names.includes("inbound_message_queued"));
    assert.ok(names.includes("offline_queue_replayed"));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
