# Technical Specs

## Runtime

- Node.js 24 recommended.
- TypeScript.
- SQLite with WAL.
- Local HTTP API on port `5480`.
- Default host bind: `127.0.0.1`.
- Supported loopback aliases: `cstoresku`, optional `cstoresku.local`.
- Docker Compose support.

## Local Storage

Database:

```text
runtime.sqlite
```

Tables:

- `schema_migrations`
- `app_state`
- `activity_log`
- `outbound_queue`
- `sync_attempts`
- `conflicts`
- `diagnostic_bundles`
- `chat_audit_log`
- `commander_locks`
- `sales_snapshots`
- `connector_nonces`
- `usage_events`

Activity logging records `api_request_completed` for API request/response visibility. Business events such as queue replay, connector activation, inbound messages, diagnostics bundle creation, and sales queries are recorded separately.

Runtime JSON content is encrypted at rest with AES-256-GCM. The SQLite table names remain visible, but app state, queue payloads, chat audit content, activity metadata, diagnostics bundles, and sales item details are stored as encrypted JSON blobs.

## Connector Registry

Default:

```text
https://connector.aros.live
```

Health endpoint verified:

```text
https://connector.aros.live/health
```

## Connectors

```text
rapidrms-api
  Existing connector for RapidRMS/CStoreSKU cloud/backoffice API.

verifone-commander
  New store-local connector for Commander POS, sync, diagnostics, queue, and local sales context.
```

Marketplace manifest:

```http
GET /api/connector/manifest
```

Static manifest:

```text
marketplace/verifone-commander.connector.json
```

## Local Sales Query Contract

Sales ingest stores normalized summary rows in `sales_snapshots`.

API:

```http
POST /api/sales/snapshot
POST /api/sales/query
POST /api/messages/inbound
GET  /api/messages/contract
```

`/api/messages/inbound` classifies sales questions and returns an immediate local SQLite answer when a matching snapshot exists. If no local sales data exists, it queues the request and returns `requiresDataSource: true`.

Inbound messages are normalized from canonical local payloads and common gateway payloads. Supported source aliases include ShreChat, message gateway, WhatsApp, Claude/Anthropic, Codex/OpenAI, and Shre CLI. Every accepted message returns `gatewayResponse` for connector.aros.live or a future relay to send back to the user.

## Notifications

```http
GET /api/notifications
```

Notifications are computed from current local state. They flag disconnected Verifone status, password action, failed/pending queue work, missing marketplace activation, and missing local sales data.

## Local Login And Usage

```http
GET  /api/auth/status
POST /api/auth/setup
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/validate
GET  /api/usage/summary
POST /api/usage/record
POST /api/usage/replay
POST /api/chat/local
```

Local login works offline from an encrypted local hash. Remote validation is best-effort and retries in the background when `SHRE_AUTH_VALIDATE_URL` is configured. Usage events are stored locally and queued to `shre-cost` for billing. `POST /api/usage/replay` backfills pending usage reports and marks local usage rows as `reported` when replay succeeds.

The first chat implementation uses local tools only. Sales questions use the local SQLite sales snapshot/query tool. Future model calls should be routed through the same usage metering path.

## Commander Concurrency

All local Commander-facing work should be:

1. Queued in `outbound_queue`.
2. Processed by one worker.
3. Protected by `commander_locks`.
4. Released when the operation finishes or expires by TTL.

API:

```http
GET  /api/commander/lease/status
POST /api/commander/lease/acquire
POST /api/commander/lease/release
```

If a second worker tries to acquire the Commander lease while active, the API returns:

```text
423 Locked
```

## Recommended Defaults

- Commander lease TTL: 120 seconds.
- Short Commander requests: under 30 seconds.
- Heavy sync pulls: scheduled and serialized.
- Retry/backoff on timeout.
- No parallel full pulls against Commander from this local app.
