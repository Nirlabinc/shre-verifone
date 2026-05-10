import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const port = 20_000 + Math.floor(Math.random() * 20_000);
const baseUrl = `http://127.0.0.1:${port}`;
const connectorSecret = "test-connector-secret";
const localAdminToken = "test-local-admin-token";

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
      "x-local-admin-token": localAdminToken,
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
  const backupRoot = await mkdtemp(join(tmpdir(), "verifone-shre-backup-e2e-"));
  const signupRequests = [];
  const commanderRequests = [];
  const commanderServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    commanderRequests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
    if (req.url.includes("cmd=validate")) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><Response><cookie>mock-cookie-001</cookie></Response>`);
      return;
    }
    if (req.url.includes("cmd=uPLUs")) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><Response><Status>Accepted</Status><Message>PLU update accepted</Message></Response>`);
      return;
    }
    if (req.url.includes("cmd=vPLUs")) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><NAXML-PLUConfig><PLU><ItemCode>sku-001</ItemCode><Description>Coffee</Description></PLU></NAXML-PLUConfig>`);
      return;
    }
    if (req.url.includes("cmd=vAppInfo")) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><ApplicationInfo><Version>1.0</Version><Name>Commander</Name></ApplicationInfo>`);
      return;
    }
    res.writeHead(200, { "content-type": "application/xml" });
    if (req.url.includes("tank")) {
      res.end(`<?xml version="1.0"?><NAXML-FuelTankStockReport><BusinessDate>2026-05-09</BusinessDate><TankStockDetail><TankID>1</TankID><TankName>Regular</TankName><GrossVolume>1200.5</GrossVolume><WaterVolume>0.5</WaterVolume></TankStockDetail></NAXML-FuelTankStockReport>`);
      return;
    }
    if (req.url.includes("plu-domain")) {
      res.end(`<?xml version="1.0"?><domain:PLUs page="1" ofPages="1" xmlns:domain="urn:vfi-sapphire:np.domain.2001-07-01"><domain:PLU><upc>00011122233344</upc><upcModifier>000</upcModifier><description>SAMPLE COFFEE</description><department>30</department><price>2.49</price><SellUnit>1.000</SellUnit></domain:PLU></domain:PLUs>`);
      return;
    }
    if (req.url.includes("item-maintenance")) {
      res.end(`<?xml version="1.0"?><NAXML-MaintenanceRequest version="3.4" xmlns="http://www.naxml.org/POSBO/Vocabulary/2003-10-16"><ItemMaintenance><TableAction type="update"/><RecordAction type="addchange"/><ITTDetail><ItemCode><POSCodeFormat format="PLU"/><POSCode>00000000001234</POSCode><POSCodeModifier>000</POSCodeModifier></ItemCode><ITTData><MerchandiseCode>91</MerchandiseCode><RegularSellPrice>3.99</RegularSellPrice><Description>SAMPLE BAG</Description><SellingUnits>1.000</SellingUnits></ITTData></ITTDetail></ItemMaintenance></NAXML-MaintenanceRequest>`);
      return;
    }
    if (req.url.includes("fuelprices")) {
      res.end(`<?xml version="1.0"?><fuel:fuelPrices xmlns:fuel="urn:vfi-sapphire:fuel.2001-10-01"><fuelProducts maxSize="2"><fuelProduct sysid="1" name="REG" NAXMLFuelGradeID="1"><prices><price tier="1" servLevel="1" mop="1">3.469</price></prices></fuelProduct></fuelProducts></fuel:fuelPrices>`);
      return;
    }
    res.end(`<?xml version="1.0"?><NAXML-MovementReport><BusinessDate>2026-05-09</BusinessDate><MerchandiseCodeMovement><MCMDetail><ItemCode>100</ItemCode><ItemDescription>Coffee</ItemDescription><SalesAmount>77.50</SalesAmount><SalesQuantity>31</SalesQuantity></MCMDetail></MerchandiseCodeMovement><TotalSales>1842.55</TotalSales><TransactionCount>74</TransactionCount></NAXML-MovementReport>`);
  });
  const shreAuthServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    signupRequests.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "activated",
      tenantId: "tenant_shre_auth_001",
      workspaceId: "workspace_ops_001",
      storeId: "store_shre_auth_001",
      connectorId: "verifone-commander",
      connectorName: "Verifone Commander",
      registryUrl: "https://connector.aros.live",
      sharedSecret: "mock-shre-auth-secret",
      allowedSources: ["shre-chat", "whatsapp", "claude", "codex"],
      entitlementState: "active",
      billingEndpoint: "https://connector.aros.live/api/usage",
    }));
  });
  await new Promise((resolve) => commanderServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => shreAuthServer.listen(0, "127.0.0.1", resolve));
  const commanderUrl = `http://127.0.0.1:${commanderServer.address().port}`;
  const shreAuthUrl = `http://127.0.0.1:${shreAuthServer.address().port}/signup-activate`;
  const child = spawn(process.execPath, ["dist/apps/dashboard-api/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VERIFONE_SHRE_HOME: runtimeRoot,
      CONNECTOR_REGISTRY_URL: "https://connector.aros.live",
      CONNECTOR_SHARED_SECRET: connectorSecret,
      LOCAL_ADMIN_TOKEN: localAdminToken,
      SHRE_AUTH_SIGNUP_URL: shreAuthUrl,
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
    assert.equal(health.body.version.version, "0.1.0");
    assert.ok(health.body.version.cacheKey);
    assert.equal(health.body.runtimeRoot, runtimeRoot);
    assert.match(health.body.database, /runtime\.sqlite$/);
    assert.equal(health.body.retention.days, 30);
    await access(health.body.database);

    const storagePolicy = await json("/api/storage/policy", {
      method: "POST",
      body: JSON.stringify({
        retentionDays: 45,
        backupEnabled: true,
        backupTarget: "both",
        localBackupPath: backupRoot,
      }),
    });
    assert.equal(storagePolicy.response.status, 200);
    assert.equal(storagePolicy.body.retentionDays, 45);
    assert.equal(storagePolicy.body.shrePlatformSynologyEnabled, true);

    const storageAnalysis = await json("/api/storage/analysis");
    assert.equal(storageAnalysis.response.status, 200);
    assert.equal(storageAnalysis.body.policy.retentionDays, 45);
    assert.equal(storageAnalysis.body.analysis.risk.length > 0, true);

    const backup = await json("/api/storage/backup", {
      method: "POST",
      body: JSON.stringify({ localBackupPath: backupRoot }),
    });
    assert.equal(backup.response.status, 201);
    assert.equal(backup.body.ok, true);
    await access(join(backup.body.path, "runtime.sqlite"));
    await access(join(backup.body.path, ".install-secret"));

    const retention = await json("/api/storage/retention/apply", { method: "POST", body: JSON.stringify({}) });
    assert.equal(retention.response.status, 200);
    assert.equal(retention.body.retentionDays, 45);

    const version = await json("/api/version");
    assert.equal(version.response.status, 200);
    assert.equal(version.body.app, "verifone-commander-shre-cstoresku");
    assert.equal(version.body.buildChannel, "local");

    const authInitial = await json("/api/auth/status");
    assert.equal(authInitial.response.status, 200);
    assert.equal(authInitial.body.configured, false);

    const authSetup = await json("/api/setup/first-run", {
      method: "POST",
      body: JSON.stringify({
        loginSecret: "store-local-login-secret",
        workspaceName: "Rapid Workspace",
        corporateName: "Rapid Infosoft LLC",
        dba: "Rapid Main Store",
        storeId: "store_001",
        address: "123 Main St",
        phone: "555-0100",
        email: "owner@example.com",
        contactName: "Nirav Patel",
        timezone: "America/New_York",
      }),
    });
    assert.equal(authSetup.response.status, 200);
    assert.equal(authSetup.body.ok, true);
    assert.ok(authSetup.body.session.token);
    assert.equal(authSetup.body.profile.dba, "Rapid Main Store");
    assert.equal(authSetup.body.emailVerification.state, "verified");

    const authLogin = await json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ loginSecret: "store-local-login-secret" }),
    });
    assert.equal(authLogin.response.status, 200);
    assert.equal(authLogin.body.ok, true);

    const shreSignup = await json("/api/shre/signup-activate", {
      method: "POST",
      body: JSON.stringify({
        email: "owner@example.com",
        password: "shre-login-password",
        company: "Rapid Infosoft LLC",
        workspaceName: "Operations",
        storeName: "Store 001",
        storeCode: "store_001",
      }),
    });
    assert.equal(shreSignup.response.status, 200);
    assert.equal(shreSignup.body.ok, true);
    assert.equal(shreSignup.body.simulated, false);
    assert.equal(shreSignup.body.tenantId, "tenant_shre_auth_001");
    assert.equal(shreSignup.body.workspaceId, "workspace_ops_001");
    assert.equal(shreSignup.body.storeId, "store_shre_auth_001");
    assert.equal(shreSignup.body.cloudRelayEnabled, true);
    assert.equal(signupRequests.length, 1);
    assert.equal(signupRequests[0].workspaceName, "Operations");

    const onboarding = await json("/api/onboarding", {
      method: "POST",
      body: JSON.stringify({ completedSteps: ["profile"], currentStep: "verifone" }),
    });
    assert.equal(onboarding.response.status, 200);
    assert.equal(onboarding.body.currentStep, "verifone");

    const profile = await json("/api/profile", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: "Rapid Workspace",
        corporateName: "Rapid Infosoft LLC",
        dba: "Rapid Main Store",
        storeId: "store_001",
        address: "123 Main St",
        phone: "555-0100",
        email: "info@rapidinfosoft.com",
        contactName: "Nirav Patel",
        timezone: "America/New_York",
      }),
    });
    assert.equal(profile.response.status, 200);
    assert.equal(profile.body.ok, true);

    const config = await json("/api/verifone/config", {
      method: "POST",
      body: JSON.stringify({
        commanderUrl,
        username: "manager",
        password: "secret-value",
        applicationKey: "app-key",
        salesEndpoint: "/reports/sales",
      }),
    });
    assert.equal(config.response.status, 200);
    assert.equal(config.body.connection.password, "***");
    assert.equal(config.body.connection.applicationKey, "***");
    assert.equal(config.body.sync.localPull.enabled, true);
    assert.equal(config.body.sync.localPull.status, "scheduled");

    const cstoreskuKey = await json("/api/cstoresku/key", {
      method: "POST",
      body: JSON.stringify({ applicationKey: "updated-cstoresku-key" }),
    });
    assert.equal(cstoreskuKey.response.status, 200);
    assert.equal(cstoreskuKey.body.cstoreskuKeyConfigured, true);
    assert.equal(cstoreskuKey.body.connection.applicationKey, "***");
    assert.equal(cstoreskuKey.body.sync.cstoresku.linked, true);

    const verifoneStatus = await json("/api/verifone/status");
    assert.equal(verifoneStatus.response.status, 200);
    assert.equal(verifoneStatus.body.cstoreskuKeyConfigured, true);

    const ping = await json("/api/verifone/ping", {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(ping.response.status, 200);
    assert.equal(ping.body.status, "reachable");

    const heartbeatWorker = await json("/api/heartbeat/worker", {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(heartbeatWorker.response.status, 200);
    assert.equal(heartbeatWorker.body.enabled, true);
    assert.equal(heartbeatWorker.body.checked, true);

    const shreActivationToken = await json("/api/shre/activation-token", {
      method: "POST",
      body: JSON.stringify({ activationToken: "marketplace-token-001" }),
    });
    assert.equal(shreActivationToken.response.status, 200);
    assert.equal(shreActivationToken.body.status, "activated");
    assert.equal(shreActivationToken.body.workspaceId, "workspace_rapid_workspace");

    const validation = await json("/api/verifone/validate", {
      method: "POST",
      body: JSON.stringify({ daysRemaining: 8 }),
    });
    assert.equal(validation.response.status, 200);
    assert.equal(validation.body.status, "connected");

    const heartbeat = await json("/api/verifone/heartbeat", {
      method: "POST",
      body: JSON.stringify({ force: true, daysRemaining: 8 }),
    });
    assert.equal(heartbeat.response.status, 200);
    assert.equal(heartbeat.body.sync.heartbeat.status, "connected");
    assert.equal(heartbeat.body.sync.localPull.status, "scheduled");

    const livePull = await json("/api/verifone/pull-sales", {
      method: "POST",
      body: JSON.stringify({ businessDate: "2026-05-09" }),
    });
    assert.equal(livePull.response.status, 200);
    assert.equal(livePull.body.status, "completed");
    assert.equal(livePull.body.report.reportType, "sales");
    assert.equal(livePull.body.snapshot.totalSales, 1842.55);
    assert.equal(commanderRequests.some((request) => request.url.startsWith("/reports/sales")), true);

    const tankPull = await json("/api/verifone/pull-report", {
      method: "POST",
      body: JSON.stringify({ reportType: "tank", endpoint: "/reports/tank", businessDate: "2026-05-09" }),
    });
    assert.equal(tankPull.response.status, 200);
    assert.equal(tankPull.body.report.reportType, "tank");

    const commanderReports = await json("/api/verifone/reports");
    assert.equal(commanderReports.response.status, 200);
    assert.equal(commanderReports.body.summary.total >= 2, true);
    assert.equal(commanderReports.body.summary.entities.total >= 2, true);

    const commanderEntities = await json("/api/verifone/entities?reportType=tank");
    assert.equal(commanderEntities.response.status, 200);
    assert.equal(commanderEntities.body.entities.some((item) => item.reportType === "tank" && item.entityKey === "1"), true);

    const domainPluPull = await json("/api/verifone/pull-report", {
      method: "POST",
      body: JSON.stringify({ reportType: "plu", endpoint: "/reports/plu-domain", businessDate: "2026-05-09" }),
    });
    assert.equal(domainPluPull.response.status, 200);
    assert.equal(domainPluPull.body.report.reportType, "plu");
    assert.equal(domainPluPull.body.report.normalized.totals.itemCount >= 1, true);

    const itemMaintenancePull = await json("/api/verifone/pull-report", {
      method: "POST",
      body: JSON.stringify({ reportType: "maintenance", endpoint: "/reports/item-maintenance", businessDate: "2026-05-09" }),
    });
    assert.equal(itemMaintenancePull.response.status, 200);
    assert.equal(itemMaintenancePull.body.report.reportType, "plu");

    const fuelPricesPull = await json("/api/verifone/pull-report", {
      method: "POST",
      body: JSON.stringify({ reportType: "fuel", endpoint: "/reports/fuelprices", businessDate: "2026-05-09" }),
    });
    assert.equal(fuelPricesPull.response.status, 200);
    assert.equal(fuelPricesPull.body.report.reportType, "fuel");
    assert.equal(fuelPricesPull.body.report.normalized.totals.fuelProductCount, 1);
    assert.equal(fuelPricesPull.body.report.normalized.totals.priceCount, 1);

    const sampleEntities = await json("/api/verifone/entities?reportType=plu");
    assert.equal(sampleEntities.body.entities.some((item) => item.entityKey === "00011122233344" && item.price === 2.49), true);
    assert.equal(sampleEntities.body.entities.some((item) => item.entityKey === "00000000001234" && item.price === 3.99), true);

    const pdkCatalog = await json("/api/verifone/pdk/commands");
    assert.equal(pdkCatalog.response.status, 200);
    assert.equal(pdkCatalog.body.commands.some((item) => item.id === "vAppInfo"), true);
    assert.equal(pdkCatalog.body.commands.some((item) => item.id === "vrubyrept.summary.filename"), true);

    const pdkInfo = await json("/api/verifone/pdk/execute", {
      method: "POST",
      body: JSON.stringify({ commandId: "vAppInfo", params: {} }),
    });
    assert.equal(pdkInfo.response.status, 200);
    assert.equal(pdkInfo.body.ok, true);
    assert.equal(pdkInfo.body.report.reportType, "information");

    const pdkPlu = await json("/api/verifone/pdk/execute", {
      method: "POST",
      body: JSON.stringify({ commandId: "vPLUs", params: {} }),
    });
    assert.equal(pdkPlu.response.status, 200);
    assert.equal(pdkPlu.body.report.reportType, "plu");
    const pluEntities = await json("/api/verifone/entities?reportType=plu");
    assert.equal(pluEntities.body.entities.some((item) => item.entityKey === "sku-001"), true);
    assert.equal(commanderRequests.some((request) => request.url.includes("cmd=validate")), true);
    assert.equal(commanderRequests.some((request) => request.url.includes("cmd=vAppInfo") && request.url.includes("cookie=mock-cookie-001")), true);

    const blockedPdkUpdate = await json("/api/verifone/pdk/execute", {
      method: "POST",
      body: JSON.stringify({ commandId: "ufuelcfg", params: {} }),
    });
    assert.equal(blockedPdkUpdate.response.status, 403);
    assert.equal(blockedPdkUpdate.body.status, "blocked");

    const syncStatus = await json("/api/sync/status");
    assert.equal(syncStatus.response.status, 200);
    assert.equal(syncStatus.body.cstoresku.linked, true);
    assert.equal(syncStatus.body.commanderWriteBack.status, "blocked_by_access_mode");

    const notificationsAfterActivation = await json("/api/notifications");
    assert.equal(notificationsAfterActivation.response.status, 200);
    const notificationIds = notificationsAfterActivation.body.items.map((item) => item.id);
    assert.equal(notificationIds.includes("connector_not_activated"), false);

    const passwordStatus = await json("/api/password/status");
    assert.equal(passwordStatus.body.state, "expiring");
    assert.equal(passwordStatus.body.daysRemaining, 8);

    const notifications = await json("/api/notifications");
    assert.equal(notifications.response.status, 200);
    assert.equal(notifications.body.highestSeverity, "warning");
    assert.ok(notifications.body.items.some((item) => item.id === "password_expiring"));

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

    const initialAccessMode = await json("/api/access-mode");
    assert.equal(initialAccessMode.response.status, 200);
    assert.equal(initialAccessMode.body.mode, "read_only");

    const blockedCommanderWrite = await json("/api/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        target: "commander",
        entityType: "inventory",
        entityId: "sku-001",
        operation: "update_inventory",
        payload: { sku: "sku-001", quantity: 12 },
      }),
    });
    assert.equal(blockedCommanderWrite.response.status, 403);
    assert.equal(blockedCommanderWrite.body.accessMode, "read_only");

    const writeMode = await json("/api/access-mode", {
      method: "POST",
      body: JSON.stringify({ mode: "read_write" }),
    });
    assert.equal(writeMode.response.status, 200);
    assert.equal(writeMode.body.mode, "read_write");

    const allowedCommanderWrite = await json("/api/queue/enqueue", {
      method: "POST",
      body: JSON.stringify({
        target: "commander",
        entityType: "inventory",
        entityId: "sku-001",
        operation: "update_inventory",
        payload: { sku: "sku-001", quantity: 12 },
      }),
    });
    assert.equal(allowedCommanderWrite.response.status, 201);

    const writeOnlyMode = await json("/api/access-mode", {
      method: "POST",
      body: JSON.stringify({ mode: "write_only" }),
    });
    assert.equal(writeOnlyMode.body.mode, "write_only");

    const commanderWriteBack = await json("/api/commander/writeback", {
      method: "POST",
      body: JSON.stringify({
        commandId: "uPLUs",
        entityType: "inventory",
        entityId: "sku-001",
        xml: `<?xml version="1.0"?><NAXML-PLUMaintenance><PLU><ItemCode>sku-001</ItemCode><Description>Coffee</Description></PLU></NAXML-PLUMaintenance>`,
        verification: {
          commandId: "vPLUs",
          expectedReadContains: "sku-001",
        },
      }),
    });
    assert.equal(commanderWriteBack.response.status, 200);
    assert.equal(commanderWriteBack.body.status, "completed");
    assert.equal(commanderWriteBack.body.queueItem.status, "completed");
    assert.equal(commanderRequests.some((item) => item.url.includes("cmd=uPLUs") && item.method === "POST" && item.body.includes("NAXML-PLUMaintenance")), true);
    assert.equal(commanderRequests.some((item) => item.url.includes("cmd=vPLUs") && item.url.includes("cookie=mock-cookie-001")), true);

    const commanderWriteBackDefaultVerify = await json("/api/commander/writeback", {
      method: "POST",
      body: JSON.stringify({
        commandId: "uPLUs",
        entityType: "inventory",
        entityId: "sku-001",
        xml: `<?xml version="1.0"?><NAXML-PLUMaintenance><PLU><ItemCode>sku-001</ItemCode><Description>Coffee</Description></PLU></NAXML-PLUMaintenance>`,
      }),
    });
    assert.equal(commanderWriteBackDefaultVerify.response.status, 200);
    assert.equal(commanderWriteBackDefaultVerify.body.status, "completed");
    assert.equal(commanderWriteBackDefaultVerify.body.verification.status, "readback_verified");

    const connector = await json("/api/connector/activate", {
      method: "POST",
      body: JSON.stringify({
        connectorId: "verifone-commander",
        connectorName: "Verifone Commander",
        tenantId: "tenant_rapid_001",
        workspaceId: "workspace_ops_001",
        storeId: "store_001",
        app: "verifone_cstoresku",
        cloudRelayEnabled: true,
        relatedConnectors: ["rapidrms-api"],
      }),
    });
    assert.equal(connector.response.status, 200);
    assert.equal(connector.body.status, "activated");
    assert.equal(connector.body.cloudRelayEnabled, true);
    assert.equal(connector.body.workspaceId, "workspace_ops_001");
    assert.equal(connector.body.registryUrl, "https://connector.aros.live");
    assert.deepEqual(connector.body.relatedConnectors, ["rapidrms-api"]);

    const readiness = await json("/api/readiness");
    assert.equal(readiness.response.status, 200);
    assert.equal(readiness.body.checks.some((check) => check.id === "workspace_id" && check.ok === true), true);

    const catalog = await json("/api/connectors/catalog");
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.registryUrl, "https://connector.aros.live");
    assert.deepEqual(catalog.body.connectors.map((item) => item.connectorId), ["rapidrms-api", "verifone-commander", "verifone-fcc", "verifone-loyalty"]);
    assert.equal(catalog.body.connectors.find((item) => item.connectorId === "verifone-fcc").installState, "available_add_on");
    assert.equal(catalog.body.connectors.find((item) => item.connectorId === "verifone-loyalty").bundled, false);

    const addons = await json("/api/addons");
    assert.equal(addons.response.status, 200);
    assert.equal(addons.body.addOns.find((addon) => addon.id === "verifone-fcc").status, "available");

    const fccActivation = await json("/api/addons/activate", {
      method: "POST",
      body: JSON.stringify({ id: "verifone-fcc", enabled: true }),
    });
    assert.equal(fccActivation.response.status, 200);
    assert.equal(fccActivation.body.enabled, true);

    const fccStatus = await json("/api/addons/fcc/status");
    assert.equal(fccStatus.body.status, "enabled");

    const loyaltyStatus = await json("/api/addons/loyalty/status");
    assert.equal(loyaltyStatus.body.status, "available");

    const adapters = await json("/api/adapters");
    assert.equal(adapters.response.status, 200);
    assert.ok(adapters.body.adapters.some((adapter) => adapter.id === "mcp" && adapter.status === "contract_available"));

    const remoteAccess = await json("/api/remote-access", {
      method: "POST",
      body: JSON.stringify({ provider: "cloudflare", enabled: true, publicUrl: "https://edge.example.test", tunnelId: "tunnel-001" }),
    });
    assert.equal(remoteAccess.response.status, 200);
    assert.equal(remoteAccess.body.ready, true);

    const mcpTools = await json("/api/mcp/tools");
    assert.equal(mcpTools.response.status, 200);
    assert.ok(mcpTools.body.tools.some((tool) => tool.name === "verifone.fcc.status"));

    const manifest = await json("/api/connector/manifest");
    assert.equal(manifest.response.status, 200);
    assert.equal(manifest.body.connectorId, "verifone-commander");
    assert.equal(manifest.body.publisher.name, "Rapid Infosoft LLC");
    assert.equal(manifest.body.runtime.database, "sqlite");
    assert.ok(manifest.body.tools.some((tool) => tool.id === "verifone:sales-query"));
    assert.ok(manifest.body.addOns.some((addon) => addon.id === "verifone-fcc" && addon.enabledByDefault === false));
    assert.ok(manifest.body.addOns.some((addon) => addon.id === "verifone-loyalty" && addon.enabledByDefault === false));
    assert.ok(manifest.body.relatedConnectors.includes("rapidrms-api"));

    const messageContract = await json("/api/messages/contract");
    assert.equal(messageContract.response.status, 200);
    assert.ok(messageContract.body.supportedSources.includes("claude"));
    assert.ok(messageContract.body.acceptedPayloads.some((payload) => payload.shape === "assistant"));

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
    assert.equal(salesQuery.response.status, 403);

    await json("/api/access-mode", {
      method: "POST",
      body: JSON.stringify({ mode: "read_write" }),
    });

    const allowedSalesQuery = await json("/api/sales/query", {
      method: "POST",
      body: JSON.stringify({ query: "What were sales today?", businessDate: "2026-05-09" }),
    });
    assert.equal(allowedSalesQuery.response.status, 200);
    assert.equal(allowedSalesQuery.body.status, "answered");
    assert.match(allowedSalesQuery.body.answer, /\$1842\.55/);

    const unsignedInbound = await json("/api/messages/inbound", {
      method: "POST",
      body: JSON.stringify({
        source: "whatsapp",
        tenantId: "tenant_rapid_001",
        workspaceId: "workspace_ops_001",
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
    assert.equal(inbound.body.gatewayResponse.status, "answered");
    assert.equal(inbound.body.gatewayResponse.source, "whatsapp");
    assert.equal(inbound.body.gatewayResponse.workspaceId, "workspace_ops_001");

    const claudeInbound = signedBody({
      provider: "anthropic",
      tenantId: "tenant_rapid_001",
      workspaceId: "workspace_ops_001",
      storeId: "store_001",
      message: { id: "msg_claude_001" },
      messages: [{ role: "user", content: "Show sales today" }],
      context: { businessDate: "2026-05-09" },
    });
    const claude = await json("/api/messages/inbound", {
      method: "POST",
      ...claudeInbound,
    });
    assert.equal(claude.response.status, 202);
    assert.equal(claude.body.source, "claude");
    assert.equal(claude.body.intent, "sales_query");
    assert.match(claude.body.gatewayResponse.text, /\$1842\.55/);

    const usage = await json("/api/usage/summary");
    assert.equal(usage.response.status, 200);
    assert.ok(usage.body.inputTokens > 0);
    assert.ok(usage.body.outputTokens > 0);
    assert.ok(usage.body.events.length >= 1);
    assert.ok(usage.body.pendingReport >= 2);

    const localChat = await json("/api/chat/local", {
      method: "POST",
      body: JSON.stringify({ messageText: "What were sales today?", businessDate: "2026-05-09" }),
    });
    assert.equal(localChat.response.status, 200);
    assert.equal(localChat.body.intent, "sales_query");
    assert.match(localChat.body.message, /\$1842\.55/);

    const usageReplay = await json("/api/usage/replay", { method: "POST", body: JSON.stringify({}) });
    assert.equal(usageReplay.response.status, 200);
    assert.equal(usageReplay.body.usage.pendingReport, 0);
    assert.ok(usageReplay.body.usage.reported >= 3);

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

    const db = new Database(health.body.database, { readonly: true });
    try {
      const appState = db.prepare("select value_json from app_state where scope = 'connections' and key = 'verifone'").get();
      assert.match(appState.value_json, /^encjson:v1:/);
      const chatRow = db.prepare("select message_text, response_json from chat_audit_log limit 1").get();
      assert.match(chatRow.message_text, /^encjson:v1:/);
      assert.match(chatRow.response_json, /^encjson:v1:/);
      const authRow = db.prepare("select value_json from app_state where scope = 'auth' and key = 'local-login'").get();
      assert.match(authRow.value_json, /^encjson:v1:/);
      const usageRow = db.prepare("select metadata_json from usage_events limit 1").get();
      assert.match(usageRow.metadata_json, /^encjson:v1:/);
      const commanderReport = db.prepare("select xml_json, normalized_json from commander_reports limit 1").get();
      assert.match(commanderReport.xml_json, /^encjson:v1:/);
      assert.match(commanderReport.normalized_json, /^encjson:v1:/);
    } finally {
      db.close();
    }

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

    const recordedError = await json("/api/errors", {
      method: "POST",
      body: JSON.stringify({
        severity: "critical",
        source: "e2e",
        operation: "manual-check",
        entityId: "entity-001",
        message: "Synthetic support error password=secret",
        details: { password: "secret", url: "http://commander/cgi-bin/CGILink?cmd=vAppInfo&cookie=secret-cookie" },
        correlationId: "corr-001",
      }),
    });
    assert.equal(recordedError.response.status, 201);
    assert.equal(recordedError.body.severity, "critical");
    assert.equal(recordedError.body.details.password, "***");
    assert.equal(recordedError.body.details.url.includes("cookie=***"), true);

    const errorLog = await json("/api/errors");
    assert.equal(errorLog.response.status, 200);
    assert.equal(errorLog.body.summary.highestOpenSeverity, "critical");
    assert.ok(errorLog.body.errors.some((item) => item.id === recordedError.body.id));

    const errorNotifications = await json("/api/notifications");
    assert.ok(errorNotifications.body.items.some((item) => item.id === "error_log_open"));

    const resolvedError = await json("/api/errors/resolve", {
      method: "POST",
      body: JSON.stringify({ id: recordedError.body.id, resolution: { note: "resolved in e2e" } }),
    });
    assert.equal(resolvedError.response.status, 200);
    assert.equal(resolvedError.body.status, "resolved");

    const bundle = await json("/api/diagnostics/bundle", { method: "POST", body: JSON.stringify({}) });
    assert.equal(bundle.response.status, 201);
    assert.equal(bundle.body.ok, true);
    assert.equal(bundle.body.storage, "sqlite:diagnostic_bundles");
    await access(bundle.body.path);
    assert.ok((await stat(bundle.body.path)).size > 0);

    const activity = await json("/api/activity");
    const names = activity.body.events.map((event) => event.eventName);
    assert.ok(names.includes("api_request_completed"));
    assert.ok(names.includes("access_mode_updated"));
    assert.ok(names.includes("addon_activated"));
    assert.ok(names.includes("remote_access_updated"));
    assert.ok(names.includes("shre_auth_signup_activated"));
    assert.ok(names.includes("profile_saved"));
    assert.ok(names.includes("verifone_connection_pinged"));
    assert.ok(names.includes("heartbeat_worker_checked"));
    assert.ok(names.includes("verifone_connection_validated"));
    assert.ok(names.includes("commander_report_pull_completed"));
    assert.ok(names.includes("verifone_pdk_command_executed"));
    assert.ok(names.includes("sales_snapshot_saved"));
    assert.ok(names.includes("sales_query_answered"));
    assert.ok(names.includes("inbound_message_queued"));
    assert.ok(names.includes("usage_reports_replayed"));
    assert.ok(names.includes("offline_queue_replayed"));
    assert.ok(names.includes("error_log_recorded"));
    assert.ok(names.includes("error_log_resolved"));
    assert.ok(names.includes("storage_policy_updated"));
    assert.ok(names.includes("runtime_backup_created"));
    assert.ok(names.includes("storage_retention_applied"));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => shreAuthServer.close(resolve));
    await new Promise((resolve) => commanderServer.close(resolve));
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
  }
});
