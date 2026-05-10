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
- `error_log`
- `outbound_queue`
- `sync_attempts`
- `conflicts`
- `diagnostic_bundles`
- `chat_audit_log`
- `commander_locks`
- `sales_snapshots`
- `commander_reports`
- `commander_report_entities`
- `connector_nonces`
- `usage_events`
- storage policy and backup status in encrypted app state

Activity logging records `api_request_completed` for API request/response visibility. Business events such as queue replay, connector activation, inbound messages, diagnostics bundle creation, and sales queries are recorded separately. The dedicated `error_log` table stores unresolved/resolved operational failures with severity, source, operation, entity ID, redacted details, correlation ID, and resolution status.

Runtime JSON content is encrypted at rest with AES-256-GCM. The SQLite table names remain visible, but app state, queue payloads, chat audit content, activity metadata, diagnostics bundles, and sales item details are stored as encrypted JSON blobs.

Storage retention and backup APIs are documented in [Storage, Retention, And Backup](storage-retention-backup.md). The dashboard exposes retention choices from 7 days to 1 year, forecasts required disk space, creates encrypted local SQLite backups, and preserves pending queue items during retention cleanup.

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
POST /api/verifone/pull-sales
POST /api/sales/snapshot
POST /api/sales/query
POST /api/commander/data-query
POST /api/messages/inbound
GET  /api/messages/contract
```

`POST /api/verifone/pull-sales` is a compatibility wrapper around the live Commander ingest adapter. `POST /api/verifone/pull-report` is the general XML ingest path for `sales`, `batch`, `fuel`, `tank`, `journal`, `plu`, `department`, `category`, `tax`, `payment`, and selected Commander configuration exports. It uses the stored Commander URL, username, and password, acquires the Commander lease, tries the configured endpoint first, then fallback candidates, and stores encrypted raw XML plus normalized JSON in SQLite.

The local mapping is Conexxus/NAXML-aligned: raw Commander XML remains the source of record, then the adapter classifies report family from NAXML roots/elements and maps totals/records into normalized JSON. The parser recognizes NAXML movement reports, NAXML item maintenance exports (`ItemMaintenance` / `ITTDetail` / `POSCode`), Sapphire PLU exports (`domain:PLUs` with `upc`, `description`, `department`, `price`), and Sapphire fuel price exports (`fuel:fuelPrices` with `fuelProduct` / `price`). Normalized records are also projected into `commander_report_entities` for faster local queries by report type, entity type, entity key, amount, quantity, price, and payload metadata such as department or modifier. Exact XSD validation remains pluggable because full Conexxus schemas are licensed/member-controlled.

Set `COMMANDER_SALES_ENDPOINTS` to a comma-separated list of endpoint paths when a site-specific Commander report/API path is known. The dashboard also exposes `Sales Pull Path` in Verifone setup. Pending writes are not involved; this is read-only ingest and obeys Commander access mode.

`/api/messages/inbound` classifies sales questions and returns an immediate local SQLite answer when a matching snapshot exists. If no local sales data exists, it queues the request and returns `requiresDataSource: true`.

`/api/commander/data-query` is the generic local database query surface for normalized Commander data such as PLU/item, fuel price, tank, batch, payment, tax, department, and category records. It reads `commander_report_entities` only; it does not expose raw encrypted Commander XML.

Inbound messages are normalized from canonical local payloads and common gateway payloads. Supported source aliases include ShreChat, message gateway, WhatsApp, Claude/Anthropic, Codex/OpenAI, and Shre CLI. Every accepted message returns `gatewayResponse` for connector.aros.live or a future relay to send back to the user. The intended routing split is:

- CStoreSKU sync uses native Commander XML from `commander_reports` for TLog/config/read-write interchange.
- Shre Chat and model tools use local SQLite summaries/entities through connector tools such as `/api/sales/query` and `/api/commander/data-query`.
- Raw XML is not sent to chat/model flows unless a future entitlement and redaction policy explicitly allows it.

## Verifone Heartbeat

```http
POST /api/verifone/ping
POST /api/verifone/validate
GET  /api/verifone/heartbeat
POST /api/verifone/heartbeat
GET  /api/heartbeat/worker
POST /api/heartbeat/worker
GET  /api/verifone/pdk/commands
POST /api/verifone/pdk/execute
POST /api/commander/writeback
GET  /api/verifone/entities
GET  /api/sync/status
```

`POST /api/verifone/ping` is an immediate reachability check and does not change the heartbeat schedule. Validation and heartbeat update the stored connection state. The heartbeat worker runs in the local dashboard API process by default and checks Commander only when the stored heartbeat `nextCheckAt` is due, so repeated failures back off instead of overloading Commander.

The PDK executor and CStoreSKU XML write-back lifecycle are documented in [Verifone PDK Command Catalog](verifone-pdk-command-catalog.md). Agent/worker behavior rules for reads, parsing, writes, retries, and lockup avoidance are documented in [Commander PDK Agent Rules](commander-pdk-agent-rules.md).

Set `DISABLE_HEARTBEAT_WORKER=true` to disable automatic reconnect for controlled test runs. Set `HEARTBEAT_WORKER_INTERVAL_MS` to change how often the worker wakes up to check whether a heartbeat is due.

## Notifications

```http
GET /api/notifications
GET /api/readiness
GET /api/errors
POST /api/errors
POST /api/errors/resolve
```

Notifications are computed from current local state. They flag disconnected Verifone status, password action, failed/pending queue work, missing marketplace activation, and missing local sales data.

The error log is the support-facing failure ledger. Commander pull failures, PDK faults, write-back verification failures, heartbeat worker failures, queue replay failures, and unexpected API exceptions are recorded there. Open errors also appear in `/api/notifications`; resolved errors are retained until retention cleanup.

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
GET  /api/learning/examples
POST /api/learning/approve
```

Local login works offline from an encrypted local hash. Once configured, sensitive local APIs require either a valid local login session or `LOCAL_ADMIN_TOKEN`. Remote validation is best-effort and retries in the background when `SHRE_AUTH_VALIDATE_URL` is configured. `POST /api/shre/signup-activate` is the preferred first-run cloud setup path: it uses Shre Auth signup/login details to create or find tenant/workspace/store records, activate the connector, store the returned signing secret locally, and avoid manual tenant/secret entry. Usage events are stored locally and queued to `shre-cost` for billing. `POST /api/usage/replay` backfills pending usage reports and marks local usage rows as `reported` when replay succeeds.

The first chat implementation uses local tools only. Sales questions use the local SQLite sales snapshot/query tool. Commander data questions use normalized local entity rows. Future model calls should be routed through the same usage metering path. Every local chat or signed gateway message also creates an encrypted, redacted learning candidate in `learning_examples`; candidates require approval before Shre AI RAG or fine-tuning export.

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

The default comes from `COMMANDER_ACCESS_MODE`, falling back to `SHRE_MODE`, then `read_only`. Inventory updates and Commander write commands must go through `outbound_queue` and the Commander lease. Direct writes to Commander are not allowed from chat or gateway handlers. CStoreSKU write mode sends XML to `/api/commander/writeback`; the local service submits it to Commander and runs a read-back verification command before the queue item is marked complete. Default verification mappings cover `uPLUs -> vPLUs`, `ufuelprices/cfuelprices -> vfuelprices`, and common `u*cfg -> v*cfg` commands. Writes without an explicit or inferred verification rule stay visible as verification failures instead of success.

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

FCC and Loyalty are marketplace add-ons. They are disabled by default and depend on `verifone-commander`. `/api/adapters` reports core/add-on/future adapter readiness for the edge device. `/api/remote-access` stores Cloudflare or equivalent tunnel metadata. `/api/mcp/tools` exposes the local HTTP and stdio tool contract. The stdio MCP server runs with `npm run start:mcp` and wraps the same local APIs.

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
