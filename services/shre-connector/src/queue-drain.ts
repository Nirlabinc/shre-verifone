// Drains the dashboard-api's outbound_queue (sqlite) into the AROS event SDK.
// Idempotent: each row's `id` becomes the AROS `eventId` (deduped server-side).
// Schema: id text PK, target text, entity_type text, entity_id text,
//         operation text, payload_json text, status text, attempt_count int,
//         last_error text, created_at text, updated_at text

import Database from "better-sqlite3";
import type { Logger } from "@shreai/sdk/logger";
import { ArosClient, ArosEvent } from "./aros-client.js";
import { decryptText } from "./crypto.js";

const ALLOWED_TARGETS = new Set(["shre", "shre-events", "shre-cost", "shre-leads"]);
const SHRE_PREFIX = "shre";

/** Map sqlite `target` (kebab) to AROS-style namespace (snake), e.g. `shre-cost` → `shre_cost`. */
function normalizeNamespace(target: string): string {
  return target.replace(/-/g, "_");
}

export interface DrainConfig {
  dbPath: string;
  log: Logger;
  client: ArosClient;
  encryptionKey: Buffer;
  batchSize?: number;
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
  created_at: string;
}

export class QueueDrain {
  private db: Database.Database;
  private readonly batchSize: number;
  private readonly log: Logger;
  private readonly client: ArosClient;
  private readonly encryptionKey: Buffer;

  constructor(cfg: DrainConfig) {
    this.log = cfg.log;
    this.client = cfg.client;
    this.encryptionKey = cfg.encryptionKey;
    this.batchSize = cfg.batchSize ?? 50;
    this.db = new Database(cfg.dbPath, { fileMustExist: false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
  }

  /** True when dashboard-api has created the schema. Re-checked each tick because the
   *  worker may start before the dashboard-api initializes. */
  private tableExists(): boolean {
    const row = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='outbound_queue'",
    ).get() as { name?: string } | undefined;
    return Boolean(row?.name);
  }

  /** One drain pass. Returns counts. Caller schedules the loop. */
  async drainOnce(): Promise<{ shipped: number; failed: number; pending: number }> {
    if (!this.tableExists()) return { shipped: 0, failed: 0, pending: 0 };
    if (!this.client.isTrackingEnabled) return { shipped: 0, failed: 0, pending: this.countPending() };
    if (this.client.inBackoff) return { shipped: 0, failed: 0, pending: this.countPending() };

    const rows = this.selectPending(this.batchSize);
    if (rows.length === 0) return { shipped: 0, failed: 0, pending: 0 };

    const events: ArosEvent[] = [];
    const valid: QueueRow[] = [];
    for (const row of rows) {
      if (!ALLOWED_TARGETS.has(row.target) && !row.target.startsWith(SHRE_PREFIX)) {
        continue;  // only drain shre-targeted rows
      }
      if (this.client.isEventDisabled(`${row.target}.${row.operation}`)) {
        continue;  // server kill-switched this specific event
      }
      let metadata: Record<string, unknown>;
      try {
        const plaintext = decryptText(row.payload_json, this.encryptionKey);
        metadata = JSON.parse(plaintext) as Record<string, unknown>;
      } catch (err) {
        this.log.warn("queue row decrypt/parse failed — marking failed", {
          rowId: row.id, error: (err as Error).message,
        });
        this.markFailed(row.id, `payload decrypt/parse: ${(err as Error).message}`);
        continue;
      }
      const event: ArosEvent = {
        eventId: row.id,
        eventName: `${normalizeNamespace(row.target)}.${row.operation}`,
        metadata: { ...metadata, _source_target: row.target },
        timestamp: row.created_at || new Date().toISOString(),
      };
      if (row.entity_type) event.entityType = row.entity_type;
      if (row.entity_id) event.entityId = row.entity_id;
      events.push(event);
      valid.push(row);
    }

    if (events.length === 0) return { shipped: 0, failed: 0, pending: this.countPending() };

    const result = await this.client.ship(events);
    if (result.accepted === events.length && result.rejected === 0) {
      // success — mark all shipped
      const ids = valid.map(r => r.id);
      this.markShipped(ids);
      this.log.info("queue drain shipped batch", { count: events.length });
      return { shipped: events.length, failed: 0, pending: this.countPending() };
    }
    if (result.accepted > 0 && !result.error) {
      // partial — server returned counts but no error; we can't tell which were rejected
      const ids = valid.map(r => r.id);
      this.markShipped(ids);  // optimistic: dedupe server-side will catch any double
      this.log.warn("queue drain partial accept (treating as shipped to avoid duplication)", {
        accepted: result.accepted, rejected: result.rejected,
      });
      return { shipped: events.length, failed: 0, pending: this.countPending() };
    }
    // failure — bump attempt_count, keep status='pending', record last_error
    const errMsg = result.error ?? `accepted=${result.accepted} rejected=${result.rejected} (no error)`;
    for (const row of valid) this.bumpAttempt(row.id, errMsg);
    this.log.warn("queue drain batch failed — will retry", {
      count: events.length, accepted: result.accepted, rejected: result.rejected, error: errMsg,
    });
    return { shipped: 0, failed: events.length, pending: this.countPending() };
  }

  countPending(): number {
    if (!this.tableExists()) return 0;
    const targetClause = `(target IN ('${[...ALLOWED_TARGETS].join("','")}') OR target LIKE '${SHRE_PREFIX}%')`;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM outbound_queue WHERE status = 'pending' AND ${targetClause}`,
    ).get() as { n: number };
    return row.n;
  }

  close(): void { this.db.close(); }

  private selectPending(limit: number): QueueRow[] {
    const targetClause = `(target IN ('${[...ALLOWED_TARGETS].join("','")}') OR target LIKE '${SHRE_PREFIX}%')`;
    return this.db.prepare(
      `SELECT id, target, entity_type, entity_id, operation, payload_json,
              status, attempt_count, created_at
       FROM outbound_queue
       WHERE status = 'pending' AND ${targetClause}
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(limit) as QueueRow[];
  }

  private markShipped(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(
      `UPDATE outbound_queue SET status = 'shipped', updated_at = ?, last_error = NULL WHERE id IN (${placeholders})`,
    ).run(now, ...ids);
  }

  private markFailed(id: string, err: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE outbound_queue SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
    ).run(err.slice(0, 500), now, id);
  }

  private bumpAttempt(id: string, err: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE outbound_queue SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ? WHERE id = ?`,
    ).run(err.slice(0, 500), now, id);
  }
}
