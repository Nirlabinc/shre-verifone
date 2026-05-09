import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 5580 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
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

test("local-first onboarding, password, queue, and diagnostics flow", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "verifone-shre-e2e-"));
  const child = spawn(process.execPath, ["dist/apps/dashboard-api/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      VERIFONE_SHRE_HOME: runtimeRoot,
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth();

    const health = await json("/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.runtimeRoot, runtimeRoot);

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

    const replay = await json("/api/queue/replay", { method: "POST", body: JSON.stringify({}) });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.items[0].status, "completed");

    const bundle = await json("/api/diagnostics/bundle", { method: "POST", body: JSON.stringify({}) });
    assert.equal(bundle.response.status, 201);
    assert.equal(bundle.body.ok, true);
    await access(bundle.body.path);

    const activity = await json("/api/activity");
    const names = activity.body.events.map((event) => event.eventName);
    assert.ok(names.includes("profile_saved"));
    assert.ok(names.includes("verifone_connection_validated"));
    assert.ok(names.includes("offline_queue_replayed"));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
