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
GET /api/readiness
```

Notifications are computed from current local state. They flag disconnected Verifone status, password action, failed/pending queue work, missing marketplace activation, and missing local sales data.

Readiness is a machine-readable go-live checklist. It reports critical blockers, warnings, and per-check status for local login, Shre Auth configuration, tenant/workspace/store activation, connector signing secret, entitlement, Verifone validation, sales data, queue health, and usage billing configuration.

## Local Login And Usage

```http
GET  /api/auth/status
POST /api/auth/setup
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/validate
POST /api/shre/signup-activate
GET  /api/usage/summary
POST /api/usage/record
POST /api/usage/replay
POST /api/chat/local
```

Local login works offline from an encrypted local hash. Remote validation is best-effort and retries in the background when `SHRE_AUTH_VALIDATE_URL` is configured. `POST /api/shre/signup-activate` is the preferred first-run cloud setup path: it uses Shre Auth signup/login details to create or find tenant/workspace/store records, activate the connector, store the returned signing secret locally, and avoid manual tenant/secret entry. Usage events are stored locally and queued to `shre-cost` for billing. `POST /api/usage/replay` backfills pending usage reports and marks local usage rows as `reported` when replay succeeds.

The first chat implementation uses local tools only. Sales questions use the local SQLite sales snapshot/query tool. Future model calls should be routed through the same usage metering path.

## Commander Concurrency

## Commander Access Mode

Commander access is controlled separately from Shre entitlement:

```http
GET  /api/access-mode
POST /api/access-mode
```

Supported modes:

- `read_only`: default. Allows local capture/query of Commander data and blocks Commander/inventory writes.
- `read_write`: allows both read capture and queued inventory/write commands.
- `write_only`: blocks local sales/read queries and allows queued Commander/inventory writes.

The default comes from `COMMANDER_ACCESS_MODE`, falling back to `SHRE_MODE`, then `read_only`. Inventory updates and Commander write commands must go through `outbound_queue` and the Commander lease. Direct writes to Commander are not allowed from chat or gateway handlers.

## Add-ons, Remote Access, And MCP Contract

```http
GET  /api/addons
POST /api/addons/activate
GET  /api/addons/fcc/status
GET  /api/addons/loyalty/status
GET  /api/adapters
GET  /api/remote-access
POST /api/remote-access
GET  /api/mcp/tools
```

FCC and Loyalty are marketplace add-ons. They are disabled by default and depend on `verifone-commander`. `/api/adapters` reports core/add-on/future adapter readiness for the edge device. `/api/remote-access` stores Cloudflare or equivalent tunnel metadata. `/api/mcp/tools` exposes the local HTTP tool contract for future MCP gateways; it is a contract endpoint, not a full MCP server yet.

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
