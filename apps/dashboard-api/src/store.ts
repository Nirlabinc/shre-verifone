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

      insert or ignore into schema_migrations (version, applied_at)
      values (1, datetime('now'));
    `);
  }
}
