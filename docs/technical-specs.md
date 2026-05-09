# Technical Specs

## Runtime

- Node.js 24 recommended.
- TypeScript.
- SQLite with WAL.
- Local HTTP API on port `5480`.
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
