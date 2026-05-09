import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

export interface RuntimeStoreOptions {
  connectorRegistryUrl: string;
}

export class RuntimeStore {
  private readonly db: Database.Database;

  constructor(private readonly runtimeRoot: string, private readonly options: RuntimeStoreOptions) {
    mkdirSync(runtimeRoot, { recursive: true });
    this.db = new Database(join(runtimeRoot, "runtime.sqlite"));
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
    return JSON.parse(row.value_json) as T;
  }

  setJson(scope: string, key: string, value: JsonValue): void {
    this.db.prepare(`
      insert into app_state (scope, key, value_json, updated_at)
      values (?, ?, ?, ?)
      on conflict(scope, key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(scope, key, JSON.stringify(value), new Date().toISOString());
  }

  appendActivity(eventName: string, metadata: JsonObject = {}): void {
    this.db.prepare(`
      insert into activity_log (id, event_name, metadata_json, created_at)
      values (?, ?, ?, ?)
    `).run(randomUUID(), eventName, JSON.stringify(metadata), new Date().toISOString());
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
      metadata: JSON.parse(row.metadata_json) as JsonObject,
      timestamp: row.created_at,
    }));
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
    `).run(id, item.target, item.entityType, item.entityId || null, item.operation, JSON.stringify(item.payload), now, now);
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

  saveDiagnosticBundle(bundle: JsonObject): JsonObject {
    const id = String(bundle.id || randomUUID());
    this.db.prepare(`
      insert into diagnostic_bundles (id, bundle_json, created_at)
      values (?, ?, ?)
    `).run(id, JSON.stringify(bundle), String(bundle.createdAt || new Date().toISOString()));
    return { ok: true, id, path: this.path(), storage: "sqlite:diagnostic_bundles" };
  }

  diagnosticBundles(): JsonValue[] {
    const rows = this.db.prepare("select id, bundle_json, created_at from diagnostic_bundles order by created_at desc").all() as Array<{ id: string; bundle_json: string; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      bundle: JSON.parse(row.bundle_json) as JsonObject,
    }));
  }

  saveConnectorRegistration(registration: JsonObject): JsonObject {
    const current = {
      connectorId: registration.connectorId || "verifone-commander",
      connectorName: registration.connectorName || "Verifone Commander",
      tenantId: registration.tenantId || "",
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
          name: "Verifone Commander",
          category: "pos",
          authType: "local-credential",
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
      ],
      dataScopes: [
        "tenant",
        "store",
        "sales_summary",
        "item_sales_summary",
        "sync_status",
        "diagnostics",
      ],
      inbound: {
        endpoint: `${localBaseUrl}/api/messages/inbound`,
        supportedSources: ["shre-chat", "message-gateway", "whatsapp", "claude", "codex"],
        responseModes: ["immediate-local", "queued-local", "cloud-relay"],
      },
      relatedConnectors: ["rapidrms-api"],
      security: {
        requiredHeaders: ["x-shre-tenant-id", "x-shre-agent-id", "x-shre-signature"],
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
    `).run(id, businessDate, totalSales, transactionCount, JSON.stringify(topItems), source, now);
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
      topItems: JSON.parse(row.top_items_json) as JsonValue[],
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

  saveChatAudit(entry: {
    source: string;
    tenantId?: string;
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
      entry.messageText,
      entry.intent,
      entry.status,
      JSON.stringify(entry.response),
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
      messageText: row.message_text,
      intent: row.intent,
      status: row.status,
      response: JSON.parse(row.response_json) as JsonObject,
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
      payload: JSON.parse(row.payload_json) as JsonObject,
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
      payload: JSON.parse(row.payload_json) as JsonObject,
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

      insert or ignore into schema_migrations (version, applied_at)
      values (1, datetime('now'));
    `);
  }
}
