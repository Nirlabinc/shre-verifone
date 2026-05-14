// AROS event SDK transport — port of Shreai/sdk-python:shreai.py wire protocol.
// Spec: aros-developer-portal/sdks/SHARED-SDK-SPEC.md
// Endpoints: POST {endpoint}/v1/sdk/session  (bootstrap)
//            GET  {endpoint}/v1/sdk/config   (kill-switch + disabled events)
//            POST {events_endpoint}/v1/events/batch
//            POST {events_endpoint}/v1/sdk/heartbeat

import type { Logger } from "@shreai/sdk/logger";

export const SDK_VERSION = "verifone-shre-connector/0.1.0";
const APP_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const BACKOFF_S = [5, 15, 30, 60, 300];

export interface ArosConfig {
  endpoint: string;
  eventsEndpoint: string;
  tenantId: string;
  app: string;
  mode: "read_only" | "read_write";
  storeId?: string;
  userId?: string;
  role?: string;
  bootstrapKey?: string;
  /** Stable per-install UUID — survives hostname/PID changes. */
  deviceId?: string;
  /** User-supplied friendly name like "Front Counter Register". */
  deviceAlias?: string;
  sdkVersion?: string;
  timeoutMs?: number;
  log: Logger;
}

export interface ArosEvent {
  eventId: string;
  eventName: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  entityType?: string;
  entityId?: string;
}

export interface FlushResult {
  accepted: number;
  rejected: number;
  nextFlushSeconds?: number;
  error?: string;
}

export class ArosClient {
  private sdkToken: string | null = null;
  private sessionId: string | null = null;
  private tokenExpiresAt = 0;
  private trackingEnabled = true;
  private disabledEvents = new Set<string>();
  private retryAttempt = 0;
  private nextRetryAt = 0;

  constructor(private readonly cfg: ArosConfig) {
    if (!APP_PATTERN.test(cfg.app)) {
      throw new Error(`app must match ${APP_PATTERN.source}: '${cfg.app}'`);
    }
    if (cfg.mode === "read_write" && !cfg.bootstrapKey) {
      throw new Error("read_write mode requires bootstrapKey");
    }
    this.cfg.endpoint = cfg.endpoint.replace(/\/$/, "");
    this.cfg.eventsEndpoint = cfg.eventsEndpoint.replace(/\/$/, "");
    this.cfg.sdkVersion = cfg.sdkVersion ?? SDK_VERSION;
    this.cfg.timeoutMs = cfg.timeoutMs ?? 20_000;
  }

  get isTrackingEnabled(): boolean { return this.trackingEnabled; }
  get inBackoff(): boolean { return Date.now() < this.nextRetryAt; }
  isEventDisabled(name: string): boolean { return this.disabledEvents.has(name); }

  async bootstrap(): Promise<void> {
    const body: Record<string, unknown> = {
      tenantId: this.cfg.tenantId,
      app: this.cfg.app,
      mode: this.cfg.mode,
      sdkVersion: this.cfg.sdkVersion,
    };
    if (this.cfg.storeId) body.storeId = this.cfg.storeId;
    if (this.cfg.userId) body.userId = this.cfg.userId;
    if (this.cfg.role) body.role = this.cfg.role;
    if (this.cfg.bootstrapKey) body.bootstrapKey = this.cfg.bootstrapKey;
    if (this.cfg.deviceId) body.deviceId = this.cfg.deviceId;
    if (this.cfg.deviceAlias) body.deviceAlias = this.cfg.deviceAlias;
    const data = await this.http("POST", `${this.cfg.endpoint}/v1/sdk/session`, body);
    this.sdkToken = (data.sdkToken as string) ?? null;
    this.sessionId = (data.sessionId as string) ?? null;
    this.trackingEnabled = data.trackingEnabled !== false;
    const exp = data.expiresIn;
    if (typeof exp === "number") this.tokenExpiresAt = Date.now() + exp * 1000;
    this.cfg.log.info("aros bootstrap ok", {
      sessionId: this.sessionId, trackingEnabled: this.trackingEnabled, expiresIn: exp,
    });
  }

  async refreshConfig(): Promise<void> {
    try {
      const data = await this.http("GET", `${this.cfg.endpoint}/v1/sdk/config`);
      if (typeof data.trackingEnabled === "boolean") this.trackingEnabled = data.trackingEnabled;
      if (Array.isArray(data.disabledEvents)) {
        this.disabledEvents = new Set(data.disabledEvents.filter((s): s is string => typeof s === "string"));
      }
    } catch (err) {
      this.cfg.log.warn("aros config refresh failed", { error: (err as Error).message });
    }
  }

  /** Ship a batch. Returns acceptance counts. On 401 re-bootstraps; on 403 kill-switches;
   *  on 429/5xx schedules backoff. Caller decides whether to keep, drop, or re-queue. */
  async ship(events: ArosEvent[]): Promise<FlushResult> {
    if (!this.trackingEnabled) return { accepted: 0, rejected: events.length, error: "tracking disabled" };
    if (events.length === 0) return { accepted: 0, rejected: 0 };
    if (this.cfg.mode === "read_write" && this.tokenExpiresAt - Date.now() < 60_000) {
      try { await this.bootstrap(); } catch (err) {
        this.scheduleBackoff();
        return { accepted: 0, rejected: events.length, error: (err as Error).message };
      }
    }
    try {
      const data = await this.http("POST", `${this.cfg.eventsEndpoint}/v1/events/batch`, { events });
      this.retryAttempt = 0;
      this.nextRetryAt = 0;
      // Server response shape varies — support both number counts and id arrays.
      const acceptedN = countOrLen(data.accepted);
      const rejectedN = countOrLen(data.rejected);
      // If neither is set, assume server accepted everything implicitly.
      const accepted = acceptedN > 0 || rejectedN > 0 ? acceptedN : events.length;
      this.cfg.log.debug("aros ship response", { accepted, rejected: rejectedN, raw: data });
      return {
        accepted,
        rejected: rejectedN,
        nextFlushSeconds: typeof data.nextFlushSeconds === "number" ? data.nextFlushSeconds : undefined,
      };
    } catch (err) {
      const status = (err as HttpError).status ?? 0;
      if (status === 401) {
        try { await this.bootstrap(); } catch (boot) {
          this.cfg.log.warn("aros re-bootstrap failed", { error: (boot as Error).message });
        }
      } else if (status === 403) {
        this.trackingEnabled = false;
        this.cfg.log.warn("aros kill-switch (403) — tracking disabled");
      } else if (status === 429 || status >= 500) {
        this.scheduleBackoff();
      } else if (status === 0) {
        this.scheduleBackoff();
      }
      return { accepted: 0, rejected: events.length, error: (err as Error).message };
    }
  }

  async heartbeat(eventsQueued: number, deviceIdOverride?: string): Promise<void> {
    const body: Record<string, unknown> = {
      tenantId: this.cfg.tenantId,
      app: this.cfg.app,
      sdkVersion: this.cfg.sdkVersion,
      eventsQueued,
    };
    if (this.cfg.storeId) body.storeId = this.cfg.storeId;
    const deviceId = deviceIdOverride ?? this.cfg.deviceId;
    if (deviceId) body.deviceId = deviceId;
    if (this.cfg.deviceAlias) body.deviceAlias = this.cfg.deviceAlias;
    try {
      await this.http("POST", `${this.cfg.eventsEndpoint}/v1/sdk/heartbeat`, body);
    } catch (err) {
      this.cfg.log.debug("aros heartbeat failed (will retry)", { error: (err as Error).message });
    }
  }

  private scheduleBackoff(): void {
    const idx = Math.min(this.retryAttempt, BACKOFF_S.length - 1);
    const delayMs = BACKOFF_S[idx]! * 1000;
    this.retryAttempt += 1;
    this.nextRetryAt = Date.now() + delayMs;
    this.cfg.log.info("aros backoff scheduled", { attempt: this.retryAttempt, delayMs });
  }

  private async http(method: "GET" | "POST", url: string, body?: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": `shreai-sdk/${this.cfg.sdkVersion}`,
      "X-Shre-Tenant": this.cfg.tenantId,
      "X-Shre-App": this.cfg.app,
      "X-Shre-SDK-Version": this.cfg.sdkVersion!,
    };
    if (this.cfg.storeId) headers["X-Shre-Store"] = this.cfg.storeId;
    if (this.sdkToken) headers["Authorization"] = `Bearer ${this.sdkToken}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(t);
      const e = err as Error & { code?: string };
      const wrapped: HttpError = new Error(`${method} ${url} failed: ${e.message}`) as HttpError;
      wrapped.status = 0;
      wrapped.cause = e;
      throw wrapped;
    }
    clearTimeout(t);
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const e: HttpError = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`) as HttpError;
      e.status = res.status;
      throw e;
    }
    if (!text) return {};
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { return {}; }
  }
}

interface HttpError extends Error {
  status: number;
  cause?: unknown;
}

/** AROS may return accepted/rejected as numbers OR as id arrays. Normalize. */
function countOrLen(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.length;
  return 0;
}
