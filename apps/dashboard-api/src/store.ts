import Database from "better-sqlite3";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

interface KeyValueRow {
  value_json: string;
}

interface ActivityRow {
  id: string;
  event_name: string;
  metadata_json: string;
  created_at: string;
}

interface QueueRow {
  id: string;
  target: string;
  entity_type: string;
  entity_id: string | null;
  operation: string;
  payload_json: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatAuditRow {
  id: string;
  source: string;
  tenant_id: string | null;
  store_id: string | null;
  user_id: string | null;
  message_text: string;
  intent: string;
  status: string;
  response_json: string;
  created_at: string;
}

interface CommanderLockRow {
  resource: string;
  owner: string;
  expires_at: string;
  updated_at: string;
}

interface SalesSnapshotRow {
  id: string;
  business_date: string;
  total_sales: number;
  transaction_count: number;
  top_items_json: string;
  source: string;
  created_at: string;
}

interface CommanderReportRow {
  id: string;
  report_type: string;
  business_date: string | null;
  source: string;
  root_name: string | null;
  xml_json: string;
  normalized_json: string;
  created_at: string;
}

interface NonceRow {
  nonce: string;
  expires_at: string;
}

interface UsageRow {
  id: string;
  source: string;
  tenant_id: string | null;
  store_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  metadata_json: string;
  status: string;
  created_at: string;
}

export interface RuntimeStoreOptions {
  connectorRegistryUrl: string;
}

export class RuntimeStore {
  private readonly db: Database.Database;
  private readonly key: Buffer;

  constructor(private readonly runtimeRoot: string, private readonly options: RuntimeStoreOptions) {
    mkdirSync(runtimeRoot, { recursive: true });
    securePath(runtimeRoot, 0o700);
    this.key = loadEncryptionKey(runtimeRoot);
    this.db = new Database(join(runtimeRoot, "runtime.sqlite"));
    securePath(join(runtimeRoot, "runtime.sqlite"), 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  path(): string {
    return join(this.runtimeRoot, "runtime.sqlite");
  }

  getJson<T extends JsonValue>(scope: string, key: string, fallback: T): T {
    const row = this.db.prepare("select value_json from app_state where scope = ? and key = ?").get(scope, key) as KeyValueRow | undefined;
    if (!row) return fallback;
    return this.parseJson(row.value_json) as T;
  }

  setJson(scope: string, key: string, value: JsonValue): void {
    this.db.prepare(`
      insert into app_state (scope, key, value_json, updated_at)
      values (?, ?, ?, ?)
      on conflict(scope, key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(scope, key, this.stringifyJson(value), new Date().toISOString());
  }

  appendActivity(eventName: string, metadata: JsonObject = {}): void {
    this.db.prepare(`
      insert into activity_log (id, event_name, metadata_json, created_at)
      values (?, ?, ?, ?)
    `).run(randomUUID(), eventName, this.stringifyJson(metadata), new Date().toISOString());
  }

  activity(limit = 100): JsonValue[] {
    const rows = this.db.prepare(`
      select id, event_name, metadata_json, created_at
      from activity_log
      order by created_at desc, rowid desc
      limit ?
    `).all(limit) as ActivityRow[];
    return rows.reverse().map((row) => ({
      id: row.id,
      eventName: row.event_name,
      metadata: this.parseJson(row.metadata_json) as JsonObject,
      timestamp: row.created_at,
    }));
  }

  activitySummary(): JsonObject {
    const rows = this.db.prepare(`
      select event_name, count(*) as count
      from activity_log
      group by event_name
      order by count desc, event_name asc
    `).all() as Array<{ event_name: string; count: number }>;
    return {
      total: rows.reduce((sum, row) => sum + row.count, 0),
      byEvent: rows.map((row) => ({ eventName: row.event_name, count: row.count })),
    };
  }

  storageAnalysis(retentionDays: number, runtimeBytes: number, freeBytes: number | null): JsonObject {
    const tables = [
      { name: "activity_log", countSql: "select count(*) as count from activity_log", bytesSql: "select coalesce(sum(length(metadata_json)), 0) as bytes from activity_log", dateSql: "select min(created_at) as oldest, max(created_at) as newest from activity_log" },
      { name: "outbound_queue", countSql: "select count(*) as count from outbound_queue", bytesSql: "select coalesce(sum(length(payload_json)), 0) as bytes from outbound_queue", dateSql: "select min(created_at) as oldest, max(created_at) as newest from outbound_queue" },
      { name: "diagnostic_bundles", countSql: "select count(*) as count from diagnostic_bundles", bytesSql: "select coalesce(sum(length(bundle_json)), 0) as bytes from diagnostic_bundles", dateSql: "select min(created_at) as oldest, max(created_at) as newest from diagnostic_bundles" },
      { name: "chat_audit_log", countSql: "select count(*) as count from chat_audit_log", bytesSql: "select coalesce(sum(length(message_text) + length(response_json)), 0) as bytes from chat_audit_log", dateSql: "select min(created_at) as oldest, max(created_at) as newest from chat_audit_log" },
      { name: "sales_snapshots", countSql: "select count(*) as count from sales_snapshots", bytesSql: "select coalesce(sum(length(top_items_json)), 0) as bytes from sales_snapshots", dateSql: "select min(created_at) as oldest, max(created_at) as newest from sales_snapshots" },
      { name: "usage_events", countSql: "select count(*) as count from usage_events", bytesSql: "select coalesce(sum(length(metadata_json)), 0) as bytes from usage_events", dateSql: "select min(created_at) as oldest, max(created_at) as newest from usage_events" },
    ];
    const observedDates = tables.flatMap((table) => {
      const row = this.db.prepare(table.dateSql).get() as { oldest: string | null; newest: string | null };
      return [row.oldest, row.newest].filter((value): value is string => Boolean(value));
    });
    const observedDays = observedDates.length
      ? Math.max(1, Math.ceil((Math.max(...observedDates.map((value) => Date.parse(value))) - Math.min(...observedDates.map((value) => Date.parse(value)))) / 86_400_000) + 1)
      : 1;
    const tableStats = tables.map((table) => {
      const count = this.db.prepare(table.countSql).get() as { count: number };
      const bytes = this.db.prepare(table.bytesSql).get() as { bytes: number };
      const dates = this.db.prepare(table.dateSql).get() as { oldest: string | null; newest: string | null };
      return {
        table: table.name,
        rows: count.count,
        encryptedPayloadBytes: bytes.bytes,
        averageRowsPerDay: Number((count.count / observedDays).toFixed(2)),
        oldestAt: dates.oldest,
        newestAt: dates.newest,
      };
    });
    const projectedRuntimeBytes = Math.ceil((runtimeBytes / observedDays) * Math.max(retentionDays, 1));
    const reserveBytes = 2 * 1024 * 1024 * 1024;
    const recommendedMinimumFreeBytes = Math.max(reserveBytes, projectedRuntimeBytes * 3);
    const risk = freeBytes == null
      ? "unknown"
      : freeBytes < recommendedMinimumFreeBytes
        ? "high"
        : freeBytes < recommendedMinimumFreeBytes * 1.5
          ? "medium"
          : "low";
    return {
      observedDays,
      currentRuntimeBytes: runtimeBytes,
      projectedRuntimeBytes,
      recommendedMinimumFreeBytes,
      freeBytes,
      risk,
      tables: tableStats,
      notes: [
        "Projection uses current encrypted runtime size divided by observed data days.",
        "Keep at least 2 GB free, or three times projected retained runtime size, whichever is larger.",
        "Remote Shre Platform/Synology backup should be used for long-term archive once the cloud target is enabled.",
      ],
    };
  }

  async backupRuntime(backupRoot: string): Promise<JsonObject> {
    const createdAt = new Date().toISOString();
    const safeStamp = createdAt.replace(/[:.]/g, "-");
    const target = resolve(backupRoot, `verifone-commander-backup-${safeStamp}`);
    mkdirSync(target, { recursive: true });
    securePath(target, 0o700);
    const databasePath = join(target, basename(this.path()));
    await this.db.backup(databasePath);
    securePath(databasePath, 0o600);
    const secretPath = join(this.runtimeRoot, ".install-secret");
    const copied: string[] = [databasePath];
    if (existsSync(secretPath)) {
      const targetSecret = join(target, ".install-secret");
      copyFileSync(secretPath, targetSecret);
      securePath(targetSecret, 0o600);
      copied.push(targetSecret);
    }
    const manifest = {
      createdAt,
      app: "verifone-commander-shre-cstoresku",
      sourceRuntimeRoot: this.runtimeRoot,
      files: copied.map((file) => basename(file)),
      encrypted: true,
      restoreNote: "Restore runtime.sqlite and .install-secret together. Without .install-secret, encrypted JSON state cannot be decrypted.",
    };
    const manifestPath = join(target, "backup-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
    copied.push(manifestPath);
    return { ok: true, createdAt, path: target, files: copied };
  }

  applyRetention(retentionDays: number): JsonObject {
    const cutoff = new Date(Date.now() - Math.max(retentionDays, 1) * 86_400_000).toISOString();
    const deletions = [
      ["activity_log", this.db.prepare("delete from activity_log where created_at < ?").run(cutoff).changes],
      ["diagnostic_bundles", this.db.prepare("delete from diagnostic_bundles where created_at < ?").run(cutoff).changes],
      ["chat_audit_log", this.db.prepare("delete from chat_audit_log where created_at < ?").run(cutoff).changes],
      ["usage_events", this.db.prepare("delete from usage_events where created_at < ? and status in ('reported', 'report_failed')").run(cutoff).changes],
      ["outbound_queue", this.db.prepare("delete from outbound_queue where updated_at < ? and status in ('completed', 'failed')").run(cutoff).changes],
      ["sales_snapshots", this.db.prepare("delete from sales_snapshots where created_at < ?").run(cutoff).changes],
    ].map(([table, deleted]) => ({ table, deleted }));
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.pragma("optimize");
    return { ok: true, cutoff, retentionDays, deletions };
  }

  enqueue(item: {
    target: string;
    entityType: string;
    entityId?: string;
    operation: string;
    payload: JsonObject;
  }): JsonObject {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      insert into outbound_queue (
        id, target, entity_type, entity_id, operation, payload_json,
        status, attempt_count, last_error, created_at, updated_at
      )
      values (?, ?, ?, ?, ?, ?, 'pending', 0, null, ?, ?)
    `).run(id, item.target, item.entityType, item.entityId || null, item.operation, this.stringifyJson(item.payload), now, now);
    return this.queueItem(id)!;
  }

  queueSummary(): JsonObject {
    const items = this.queueItems();
    const replay = this.getJson<JsonObject>("queue", "status", {});
    return {
      pending: items.filter((item) => item.status === "pending").length,
      failed: items.filter((item) => item.status === "failed").length,
      completed: items.filter((item) => item.status === "completed").length,
      lastReplayAt: replay.lastReplayAt || null,
      lastError: replay.lastError || null,
      items,
    };
  }

  replayQueue(forceFailure: boolean): JsonObject {
    const now = new Date().toISOString();
    const status = forceFailure ? "failed" : "completed";
    const error = forceFailure ? "Replay forced to fail by test/operator request" : null;
    this.db.prepare(`
      update outbound_queue
      set status = ?, attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
      where status = 'pending'
    `).run(status, error, now);
    if (!forceFailure) {
      this.db.prepare(`
        update usage_events
        set status = 'reported'
        where id in (
          select entity_id
          from outbound_queue
          where target = 'shre-cost'
            and entity_type = 'usage_event'
            and operation = 'report_usage'
            and status = 'completed'
            and entity_id is not null
        )
      `).run();
    }
    const failed = this.db.prepare("select count(*) as count from outbound_queue where status = 'failed'").get() as { count: number };
    const queueStatus: JsonObject = {
      lastReplayAt: now,
      lastError: failed.count > 0 ? "One or more queue items failed replay" : null,
    };
    this.setJson("queue", "status", queueStatus);
    return {
      ...queueStatus,
      items: this.queueItems(),
    };
  }

  replayUsageReports(forceFailure: boolean): JsonObject {
    const now = new Date().toISOString();
    const status = forceFailure ? "failed" : "completed";
    const error = forceFailure ? "Usage report replay forced to fail by test/operator request" : null;
    this.db.prepare(`
      update outbound_queue
      set status = ?, attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
      where status = 'pending'
        and target = 'shre-cost'
        and entity_type = 'usage_event'
        and operation = 'report_usage'
    `).run(status, error, now);
    if (!forceFailure) {
      this.db.prepare(`
        update usage_events
        set status = 'reported'
        where id in (
          select entity_id
          from outbound_queue
          where target = 'shre-cost'
            and entity_type = 'usage_event'
            and operation = 'report_usage'
            and status = 'completed'
            and entity_id is not null
        )
      `).run();
    } else {
      this.db.prepare(`
        update usage_events
        set status = 'report_failed'
        where id in (
          select entity_id
          from outbound_queue
          where target = 'shre-cost'
            and entity_type = 'usage_event'
            and operation = 'report_usage'
            and status = 'failed'
            and entity_id is not null
        )
      `).run();
    }
    const usage = this.usageSummary(100);
    this.setJson("usage", "replay-status", {
      lastReplayAt: now,
      lastError: forceFailure ? error : null,
    });
    return {
      lastReplayAt: now,
      lastError: forceFailure ? error : null,
      usage,
      items: this.queueItems().filter((item) => item.target === "shre-cost" && item.entityType === "usage_event"),
    };
  }

  saveDiagnosticBundle(bundle: JsonObject): JsonObject {
    const id = String(bundle.id || randomUUID());
    this.db.prepare(`
      insert into diagnostic_bundles (id, bundle_json, created_at)
      values (?, ?, ?)
    `).run(id, this.stringifyJson(bundle), String(bundle.createdAt || new Date().toISOString()));
    return { ok: true, id, path: this.path(), storage: "sqlite:diagnostic_bundles" };
  }

  diagnosticBundles(): JsonValue[] {
    const rows = this.db.prepare("select id, bundle_json, created_at from diagnostic_bundles order by created_at desc").all() as Array<{ id: string; bundle_json: string; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      bundle: this.parseJson(row.bundle_json) as JsonObject,
    }));
  }

  saveConnectorRegistration(registration: JsonObject): JsonObject {
    const current = {
      connectorId: registration.connectorId || "verifone-commander",
      connectorName: registration.connectorName || "Verifone Commander",
      tenantId: registration.tenantId || "",
      workspaceId: registration.workspaceId || "",
      storeId: registration.storeId || "",
      app: registration.app || "verifone_cstoresku",
      mode: registration.mode || "local_first",
      cloudRelayEnabled: registration.cloudRelayEnabled === true,
      registryUrl: registration.registryUrl || this.options.connectorRegistryUrl,
      relatedConnectors: Array.isArray(registration.relatedConnectors) ? registration.relatedConnectors : ["rapidrms-api"],
      activatedAt: new Date().toISOString(),
      status: registration.tenantId ? "activated" : "local_only",
    };
    this.setJson("connector", "registration", current);
    return current;
  }

  connectorStatus(): JsonObject {
    const registration = this.getJson<JsonObject>("connector", "registration", {
      connectorId: "verifone-commander",
      connectorName: "Verifone Commander",
      tenantId: "",
      workspaceId: "",
      storeId: "",
      app: "verifone_cstoresku",
      mode: "local_first",
      cloudRelayEnabled: false,
      registryUrl: this.options.connectorRegistryUrl,
      relatedConnectors: ["rapidrms-api"],
      activatedAt: null,
      status: "local_only",
    });
    return {
      ...registration,
      localDatabase: this.path(),
      inboundEndpoint: "/api/messages/inbound",
      registryUrl: registration.registryUrl || this.options.connectorRegistryUrl,
      cloudActivationRequiredForGatewayRouting: true,
    };
  }

  connectorCatalog(): JsonObject {
    return {
      registryUrl: this.options.connectorRegistryUrl,
      connectors: [
        {
          connectorId: "rapidrms-api",
          connectorName: "RapidRMS API",
          role: "Backoffice/cloud API connector for CStoreSKU/RapidRMS data and management APIs.",
          existing: true,
        },
        {
          connectorId: "verifone-commander",
          connectorName: "Verifone Commander",
          role: "Store-local connector for Commander POS communication, sync commands, password status, diagnostics, and local queue actions.",
          existing: false,
          bundled: true,
          installState: "core",
        },
        {
          connectorId: "verifone-fcc",
          connectorName: "Verifone FCC",
          role: "Optional marketplace add-on for FCC-specific data capture, settlement/status visibility, and approved FCC workflows.",
          existing: false,
          bundled: false,
          installState: "available_add_on",
          dependsOn: ["verifone-commander"],
        },
        {
          connectorId: "verifone-loyalty",
          connectorName: "Verifone Loyalty",
          role: "Optional marketplace add-on for loyalty enrollment/status/events and approved loyalty read/write workflows.",
          existing: false,
          bundled: false,
          installState: "available_add_on",
          dependsOn: ["verifone-commander"],
        },
      ],
    };
  }

  connectorManifest(localBaseUrl = "http://localhost:5480"): JsonObject {
    return {
      schemaVersion: "2026-05-09",
      connectorId: "verifone-commander",
      connectorName: "Verifone Commander Connector",
      publisher: {
        name: "Rapid Infosoft LLC",
        author: "Nirav Patel",
        email: "info@rapidinfosoft.com",
      },
      category: "pos",
      app: "verifone_cstoresku",
      registryUrl: this.options.connectorRegistryUrl,
      runtime: {
        deployment: "local_first",
        database: "sqlite",
        requiresLocalInstall: true,
        supportedPlatforms: ["windows-x64", "linux-x64", "linux-aarch64", "macos-arm64", "macos-x64"],
      },
      connectors: [
        {
          type: "node",
          id: "verifone-commander",
          name: "Verifone Commander POS/BOS",
          category: "pos",
          authType: "local-credential",
        },
        {
          type: "node",
          id: "verifone-fcc",
          name: "Verifone FCC Add-on",
          category: "payments",
          authType: "marketplace-addon",
          optional: true,
          bundled: false,
          dependsOn: ["verifone-commander"],
        },
        {
          type: "node",
          id: "verifone-loyalty",
          name: "Verifone Loyalty Add-on",
          category: "loyalty",
          authType: "marketplace-addon",
          optional: true,
          bundled: false,
          dependsOn: ["verifone-commander"],
        },
        {
          type: "app",
          id: "verifone-commander-dashboard",
          name: "Verifone Commander Local Dashboard",
          toolIds: [
            "verifone:sales-query",
            "verifone:queue-sync",
            "verifone:health-check",
            "verifone:password-status",
            "verifone:fcc-status",
            "verifone:loyalty-status",
          ],
        },
        {
          type: "pipe",
          id: "verifone-local-sales-to-shre",
          name: "Local Sales Snapshot to Shre Learning",
          sourceNodeId: "verifone-commander",
          targetNodeId: "shre-rag",
          direction: "one-way",
          transport: "local",
        },
      ],
      tools: [
        {
          id: "verifone:sales-query",
          name: "Query local Verifone sales",
          mutating: false,
          endpoint: `${localBaseUrl}/api/sales/query`,
          scopes: ["sales.read", "sales.summary.read"],
        },
        {
          id: "verifone:queue-sync",
          name: "Queue or replay Commander sync",
          mutating: true,
          endpoint: `${localBaseUrl}/api/queue/enqueue`,
          scopes: ["sync.write"],
        },
        {
          id: "verifone:health-check",
          name: "Read local connector health",
          mutating: false,
          endpoint: `${localBaseUrl}/api/diagnostics`,
          scopes: ["diagnostics.read"],
        },
        {
          id: "verifone:password-status",
          name: "Read Commander password status",
          mutating: false,
          endpoint: `${localBaseUrl}/api/password/status`,
          scopes: ["credentials.status.read"],
        },
        {
          id: "verifone:fcc-status",
          name: "Read FCC add-on status",
          mutating: false,
          endpoint: `${localBaseUrl}/api/addons/fcc/status`,
          scopes: ["fcc.status.read"],
          optionalAddOn: true,
          enabledByDefault: false,
        },
        {
          id: "verifone:fcc-sync",
          name: "Queue FCC add-on sync",
          mutating: true,
          endpoint: `${localBaseUrl}/api/queue/enqueue`,
          scopes: ["fcc.sync.write"],
          optionalAddOn: true,
          enabledByDefault: false,
        },
        {
          id: "verifone:loyalty-status",
          name: "Read Loyalty add-on status",
          mutating: false,
          endpoint: `${localBaseUrl}/api/addons/loyalty/status`,
          scopes: ["loyalty.status.read"],
          optionalAddOn: true,
          enabledByDefault: false,
        },
        {
          id: "verifone:loyalty-sync",
          name: "Queue Loyalty add-on sync",
          mutating: true,
          endpoint: `${localBaseUrl}/api/queue/enqueue`,
          scopes: ["loyalty.sync.write"],
          optionalAddOn: true,
          enabledByDefault: false,
        },
      ],
      addOns: [
        {
          id: "verifone-fcc",
          name: "FCC",
          bundled: false,
          enabledByDefault: false,
          installSource: "marketplace",
          scopes: ["fcc.status.read", "fcc.sync.write"],
        },
        {
          id: "verifone-loyalty",
          name: "Loyalty",
          bundled: false,
          enabledByDefault: false,
          installSource: "marketplace",
          scopes: ["loyalty.status.read", "loyalty.sync.write"],
        },
      ],
      dataScopes: [
        "tenant",
        "store",
        "sales_summary",
        "item_sales_summary",
        "sync_status",
        "diagnostics",
        "fcc_status",
        "loyalty_status",
      ],
      inbound: {
        endpoint: `${localBaseUrl}/api/messages/inbound`,
        supportedSources: ["shre-chat", "message-gateway", "whatsapp", "claude", "codex", "shre-cli"],
        responseModes: ["immediate-local", "queued-local", "cloud-relay"],
      },
      relatedConnectors: ["rapidrms-api"],
      security: {
        requiredHeaders: ["x-shre-tenant-id", "x-shre-agent-id", "x-shre-timestamp", "x-shre-nonce", "x-shre-signature"],
        signature: "hmac-sha256(timestamp.nonce.tenantId.agentId.rawBody)",
        localCredentialStorage: "encrypted-local-secret",
        writesRequireCommanderLease: true,
      },
    };
  }

  saveSalesSnapshot(snapshot: JsonObject): JsonObject {
    const now = new Date().toISOString();
    const id = randomUUID();
    const businessDate = typeof snapshot.businessDate === "string" && snapshot.businessDate
      ? snapshot.businessDate
      : now.slice(0, 10);
    const totalSales = typeof snapshot.totalSales === "number" ? snapshot.totalSales : 0;
    const transactionCount = typeof snapshot.transactionCount === "number" ? snapshot.transactionCount : 0;
    const topItems = Array.isArray(snapshot.topItems) ? snapshot.topItems : [];
    const source = typeof snapshot.source === "string" && snapshot.source ? snapshot.source : "local-ingest";
    this.db.prepare(`
      insert into sales_snapshots (
        id, business_date, total_sales, transaction_count,
        top_items_json, source, created_at
      )
      values (?, ?, ?, ?, ?, ?, ?)
    `).run(id, businessDate, totalSales, transactionCount, this.stringifyJson(topItems as JsonValue[]), source, now);
    return {
      id,
      businessDate,
      totalSales,
      transactionCount,
      topItems: topItems as JsonValue[],
      source,
      createdAt: now,
    };
  }

  saveCommanderReport(report: {
    reportType: string;
    businessDate?: string;
    source: string;
    rootName?: string;
    xml: string;
    normalized: JsonObject;
  }): JsonObject {
    const now = new Date().toISOString();
    const id = randomUUID();
    const businessDate = report.businessDate || now.slice(0, 10);
    this.db.prepare(`
      insert into commander_reports (
        id, report_type, business_date, source, root_name,
        xml_json, normalized_json, created_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      report.reportType,
      businessDate,
      report.source,
      report.rootName || null,
      this.stringifyJson(report.xml),
      this.stringifyJson(report.normalized),
      now,
    );
    return {
      id,
      reportType: report.reportType,
      businessDate,
      source: report.source,
      rootName: report.rootName || null,
      normalized: report.normalized,
      createdAt: now,
    };
  }

  commanderReports(limit = 50, reportType = ""): JsonValue[] {
    const rows = reportType
      ? this.db.prepare(`
          select id, report_type, business_date, source, root_name, xml_json, normalized_json, created_at
          from commander_reports
          where report_type = ?
          order by created_at desc, rowid desc
          limit ?
        `).all(reportType, limit) as CommanderReportRow[]
      : this.db.prepare(`
          select id, report_type, business_date, source, root_name, xml_json, normalized_json, created_at
          from commander_reports
          order by created_at desc, rowid desc
          limit ?
        `).all(limit) as CommanderReportRow[];
    return rows.map((row) => ({
      id: row.id,
      reportType: row.report_type,
      businessDate: row.business_date,
      source: row.source,
      rootName: row.root_name,
      normalized: this.parseJson(row.normalized_json) as JsonObject,
      createdAt: row.created_at,
      xmlStored: Boolean(row.xml_json),
    }));
  }

  commanderReportSummary(): JsonObject {
    const rows = this.db.prepare(`
      select report_type, count(*) as count, max(created_at) as newest
      from commander_reports
      group by report_type
      order by report_type asc
    `).all() as Array<{ report_type: string; count: number; newest: string }>;
    return {
      total: rows.reduce((sum, row) => sum + row.count, 0),
      byType: rows.map((row) => ({ reportType: row.report_type, count: row.count, newestAt: row.newest })),
    };
  }

  latestSalesSnapshot(businessDate?: string): JsonObject | null {
    const row = businessDate
      ? this.db.prepare(`
          select id, business_date, total_sales, transaction_count, top_items_json, source, created_at
          from sales_snapshots
          where business_date = ?
          order by created_at desc, rowid desc
          limit 1
        `).get(businessDate) as SalesSnapshotRow | undefined
      : this.db.prepare(`
          select id, business_date, total_sales, transaction_count, top_items_json, source, created_at
          from sales_snapshots
          order by business_date desc, created_at desc, rowid desc
          limit 1
        `).get() as SalesSnapshotRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      businessDate: row.business_date,
      totalSales: row.total_sales,
      transactionCount: row.transaction_count,
      topItems: this.parseJson(row.top_items_json) as JsonValue[],
      source: row.source,
      createdAt: row.created_at,
    };
  }

  answerSalesQuery(query: string, businessDate?: string): JsonObject {
    const snapshot = this.latestSalesSnapshot(businessDate);
    if (!snapshot) {
      return {
        status: "queued",
        requiresDataSource: true,
        answer: "Sales data is not available in the local database yet. The connector queued the request until the Commander sales ingest is configured.",
        query,
        businessDate: businessDate || null,
        data: null,
      };
    }
    const topItems = Array.isArray(snapshot.topItems) ? snapshot.topItems : [];
    const topItem = topItems.length > 0 && typeof topItems[0] === "object" && topItems[0] !== null && !Array.isArray(topItems[0])
      ? topItems[0] as JsonObject
      : null;
    const topItemText = topItem && typeof topItem.name === "string"
      ? ` Top item: ${topItem.name}${typeof topItem.quantity === "number" ? ` (${topItem.quantity} sold)` : ""}.`
      : "";
    return {
      status: "answered",
      requiresDataSource: false,
      answer: `Sales for ${snapshot.businessDate}: $${Number(snapshot.totalSales).toFixed(2)} across ${snapshot.transactionCount} transactions.${topItemText}`,
      query,
      businessDate: String(snapshot.businessDate),
      data: snapshot,
    };
  }

  consumeConnectorNonce(nonce: string, ttlSeconds = 300): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    this.db.prepare("delete from connector_nonces where expires_at <= ?").run(nowIso);
    const existing = this.db.prepare("select nonce, expires_at from connector_nonces where nonce = ?").get(nonce) as NonceRow | undefined;
    if (existing) return false;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    this.db.prepare("insert into connector_nonces (nonce, expires_at, created_at) values (?, ?, ?)").run(nonce, expiresAt, nowIso);
    return true;
  }

  recordUsageEvent(event: JsonObject): JsonObject {
    const id = randomUUID();
    const now = new Date().toISOString();
    const inputTokens = typeof event.inputTokens === "number" ? event.inputTokens : 0;
    const outputTokens = typeof event.outputTokens === "number" ? event.outputTokens : 0;
    const estimatedCostUsd = typeof event.estimatedCostUsd === "number" ? event.estimatedCostUsd : 0;
    const record: JsonObject = {
      id,
      source: typeof event.source === "string" ? event.source : "local",
      tenantId: typeof event.tenantId === "string" ? event.tenantId : "",
      storeId: typeof event.storeId === "string" ? event.storeId : "",
      model: typeof event.model === "string" ? event.model : "local-routing",
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      metadata: asJsonObject(event.metadata),
      status: typeof event.status === "string" ? event.status : "pending_report",
      createdAt: now,
    };
    this.db.prepare(`
      insert into usage_events (
        id, source, tenant_id, store_id, model, input_tokens, output_tokens,
        estimated_cost_usd, metadata_json, status, created_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.source,
      record.tenantId || null,
      record.storeId || null,
      record.model,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      this.stringifyJson(record.metadata as JsonObject),
      record.status,
      now,
    );
    return record;
  }

  usageSummary(limit = 100): JsonObject {
    const rows = this.db.prepare(`
      select id, source, tenant_id, store_id, model, input_tokens, output_tokens,
             estimated_cost_usd, metadata_json, status, created_at
      from usage_events
      order by created_at desc, rowid desc
      limit ?
    `).all(limit) as UsageRow[];
    const events = rows.reverse().map((row) => ({
      id: row.id,
      source: row.source,
      tenantId: row.tenant_id || "",
      storeId: row.store_id || "",
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCostUsd: row.estimated_cost_usd,
      metadata: this.parseJson(row.metadata_json) as JsonObject,
      status: row.status,
      createdAt: row.created_at,
    }));
    return {
      inputTokens: events.reduce((sum, event) => sum + Number(asJsonObject(event).inputTokens || 0), 0),
      outputTokens: events.reduce((sum, event) => sum + Number(asJsonObject(event).outputTokens || 0), 0),
      estimatedCostUsd: events.reduce((sum, event) => sum + Number(asJsonObject(event).estimatedCostUsd || 0), 0),
      pendingReport: events.filter((event) => event.status === "pending_report").length,
      reported: events.filter((event) => event.status === "reported").length,
      failedReport: events.filter((event) => event.status === "report_failed").length,
      lastReplay: this.getJson<JsonObject>("usage", "replay-status", {}),
      events,
    };
  }

  saveChatAudit(entry: {
    source: string;
    tenantId?: string;
    workspaceId?: string;
    storeId?: string;
    userId?: string;
    messageText: string;
    intent: string;
    status: string;
    response: JsonObject;
  }): JsonObject {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      insert into chat_audit_log (
        id, source, tenant_id, store_id, user_id, message_text,
        intent, status, response_json, created_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.source,
      entry.tenantId || null,
      entry.storeId || null,
      entry.userId || null,
      encryptText(entry.messageText, this.key),
      entry.intent,
      entry.status,
      this.stringifyJson(entry.response),
      createdAt,
    );
    return {
      id,
      source: entry.source,
      tenantId: entry.tenantId || "",
      storeId: entry.storeId || "",
      userId: entry.userId || "",
      messageText: entry.messageText,
      intent: entry.intent,
      status: entry.status,
      response: entry.response,
      createdAt,
    };
  }

  chatAudit(limit = 100): JsonObject[] {
    const rows = this.db.prepare(`
      select id, source, tenant_id, store_id, user_id, message_text,
             intent, status, response_json, created_at
      from chat_audit_log
      order by created_at desc, rowid desc
      limit ?
    `).all(limit) as ChatAuditRow[];
    return rows.reverse().map((row) => ({
      id: row.id,
      source: row.source,
      tenantId: row.tenant_id || "",
      storeId: row.store_id || "",
      userId: row.user_id || "",
      messageText: decryptText(row.message_text, this.key),
      intent: row.intent,
      status: row.status,
      response: this.parseJson(row.response_json) as JsonObject,
      createdAt: row.created_at,
    }));
  }

  acquireCommanderLease(owner: string, ttlSeconds: number): JsonObject {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + Math.max(5, ttlSeconds) * 1000).toISOString();
    const existing = this.db.prepare("select resource, owner, expires_at, updated_at from commander_locks where resource = 'commander'").get() as CommanderLockRow | undefined;
    if (existing && existing.expires_at > nowIso && existing.owner !== owner) {
      return {
        acquired: false,
        resource: existing.resource,
        owner: existing.owner,
        expiresAt: existing.expires_at,
        updatedAt: existing.updated_at,
      };
    }
    this.db.prepare(`
      insert into commander_locks (resource, owner, expires_at, updated_at)
      values ('commander', ?, ?, ?)
      on conflict(resource) do update set owner = excluded.owner, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    `).run(owner, expiresAt, nowIso);
    return {
      acquired: true,
      resource: "commander",
      owner,
      expiresAt,
      updatedAt: nowIso,
    };
  }

  releaseCommanderLease(owner: string): JsonObject {
    const existing = this.commanderLeaseStatus();
    if (existing.owner && existing.owner !== owner && existing.active === true) {
      return { released: false, reason: "lease_owned_by_another_worker", ...existing };
    }
    this.db.prepare("delete from commander_locks where resource = 'commander'").run();
    return { released: true, resource: "commander", owner };
  }

  commanderLeaseStatus(): JsonObject {
    const row = this.db.prepare("select resource, owner, expires_at, updated_at from commander_locks where resource = 'commander'").get() as CommanderLockRow | undefined;
    if (!row) {
      return { active: false, resource: "commander", owner: "", expiresAt: null, updatedAt: null };
    }
    return {
      active: row.expires_at > new Date().toISOString(),
      resource: row.resource,
      owner: row.owner,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    };
  }

  private queueItems(): JsonObject[] {
    const rows = this.db.prepare(`
      select id, target, entity_type, entity_id, operation, payload_json,
             status, attempt_count, last_error, created_at, updated_at
      from outbound_queue
      order by created_at asc, rowid asc
    `).all() as QueueRow[];
    return rows.map((row) => ({
      id: row.id,
      target: row.target,
      entityType: row.entity_type,
      entityId: row.entity_id || "",
      operation: row.operation,
      payload: this.parseJson(row.payload_json) as JsonObject,
      status: row.status,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private queueItem(id: string): JsonObject | null {
    const row = this.db.prepare(`
      select id, target, entity_type, entity_id, operation, payload_json,
             status, attempt_count, last_error, created_at, updated_at
      from outbound_queue
      where id = ?
    `).get(id) as QueueRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      target: row.target,
      entityType: row.entity_type,
      entityId: row.entity_id || "",
      operation: row.operation,
      payload: this.parseJson(row.payload_json) as JsonObject,
      status: row.status,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        applied_at text not null
      );

      create table if not exists app_state (
        scope text not null,
        key text not null,
        value_json text not null,
        updated_at text not null,
        primary key (scope, key)
      );

      create table if not exists activity_log (
        id text primary key,
        event_name text not null,
        metadata_json text not null,
        created_at text not null
      );

      create table if not exists outbound_queue (
        id text primary key,
        target text not null,
        entity_type text not null,
        entity_id text,
        operation text not null,
        payload_json text not null,
        status text not null,
        attempt_count integer not null default 0,
        last_error text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists sync_attempts (
        id text primary key,
        queue_id text,
        target text not null,
        started_at text not null,
        finished_at text,
        status text not null,
        error text,
        foreign key(queue_id) references outbound_queue(id)
      );

      create table if not exists conflicts (
        id text primary key,
        entity_type text not null,
        entity_id text not null,
        local_payload_json text,
        remote_payload_json text,
        resolution text,
        created_at text not null,
        resolved_at text
      );

      create table if not exists diagnostic_bundles (
        id text primary key,
        bundle_json text not null,
        created_at text not null
      );

      create table if not exists chat_audit_log (
        id text primary key,
        source text not null,
        tenant_id text,
        store_id text,
        user_id text,
        message_text text not null,
        intent text not null,
        status text not null,
        response_json text not null,
        created_at text not null
      );

      create table if not exists commander_locks (
        resource text primary key,
        owner text not null,
        expires_at text not null,
        updated_at text not null
      );

      create table if not exists sales_snapshots (
        id text primary key,
        business_date text not null,
        total_sales real not null default 0,
        transaction_count integer not null default 0,
        top_items_json text not null,
        source text not null,
        created_at text not null
      );

      create index if not exists idx_sales_snapshots_business_date
      on sales_snapshots (business_date, created_at);

      create table if not exists commander_reports (
        id text primary key,
        report_type text not null,
        business_date text,
        source text not null,
        root_name text,
        xml_json text not null,
        normalized_json text not null,
        created_at text not null
      );

      create index if not exists idx_commander_reports_type_date
      on commander_reports (report_type, business_date, created_at);

      create table if not exists connector_nonces (
        nonce text primary key,
        expires_at text not null,
        created_at text not null
      );

      create table if not exists usage_events (
        id text primary key,
        source text not null,
        tenant_id text,
        store_id text,
        model text not null,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        estimated_cost_usd real not null default 0,
        metadata_json text not null,
        status text not null,
        created_at text not null
      );

      insert or ignore into schema_migrations (version, applied_at)
      values (1, datetime('now'));
    `);
  }

  private stringifyJson(value: JsonValue): string {
    return encryptText(JSON.stringify(value), this.key);
  }

  private parseJson(value: string): JsonValue {
    return JSON.parse(decryptText(value, this.key)) as JsonValue;
  }
}

function asJsonObject(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function securePath(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort on Windows and locked files.
  }
}

function loadEncryptionKey(runtimeRoot: string): Buffer {
  if (process.env.VERIFONE_SHRE_SECRET) {
    return createHash("sha256").update(process.env.VERIFONE_SHRE_SECRET).digest();
  }
  const secretPath = join(runtimeRoot, ".install-secret");
  if (!existsSync(secretPath)) {
    writeFileSync(secretPath, randomBytes(32).toString("hex"), { encoding: "utf8", mode: 0o600 });
  }
  securePath(secretPath, 0o600);
  return createHash("sha256").update(readFileSync(secretPath, "utf8").trim()).digest();
}

function encryptText(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `encjson:v1:${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

function decryptText(value: string, key: Buffer): string {
  if (!value.startsWith("encjson:v1:")) return value;
  const raw = Buffer.from(value.slice("encjson:v1:".length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
