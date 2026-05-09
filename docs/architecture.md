# Architecture

## Decision

Create a new Phase 2 application: `Verifone-Commander-Shre-Cstoresku`.

Rationale:

- Phase 1 is a stable packaged Verifone sync service.
- Phase 2 needs a browser dashboard, API, local queue, Shre connector, diagnostics, and AI data governance.
- Keeping Phase 2 separate avoids destabilizing the installer-only release.

The Phase 2 app should remain one local application package with separate internal services for Verifone/CStoreSKU and Shre SDK work. See [App Boundary Decision](app-boundary-decision.md).

## Local-First Federation

The store machine owns operational continuity. Remote Shre services are additive.

```text
local store machine
├─ dashboard-api
├─ dashboard-ui
├─ sync-service
├─ queue-worker
├─ diagnostics
├─ shre-connector
└─ local runtime storage

remote
├─ Shre control plane
├─ Shre events plane
├─ MIB/Shre connector registry
│  https://connector.aros.live
├─ message gateways
├─ Shre Cortex/RAG/training services
└─ Rapid Infosoft support/operations
```

If the remote AI service is unavailable:

- Verifone sync should continue where local/SQL connectivity allows.
- Local dashboard should still work.
- Events should queue locally.
- Diagnostics should remain available.

## Service Boundaries

### dashboard-api

Local HTTP API for:

- Onboarding.
- Profile.
- Verifone connection status.
- Password status.
- Queue status.
- Diagnostics.
- Static dashboard hosting.

### dashboard-ui

Browser dashboard for:

- Setup and onboarding.
- User profile.
- Verifone credentials and validation.
- Pull/push command status.
- Offline queue.
- Activity logs.
- Password expiration.
- Diagnostics.
- Shre AI status.

### sync-service

Existing Verifone/CStoreSKU worker from Phase 1.

Phase 2 should either:

- Run the existing container as a sibling service, or
- Import its behavior behind a new queue-aware worker.

### queue-worker

Owns local replay and retry:

- Pending outbound changes.
- Failed attempts.
- Retry backoff.
- Conflict records.
- Replay cursor.

### diagnostics

Collects:

- Host specs.
- Disk/RAM/CPU.
- Docker status.
- Service health.
- Recent logs.
- Diagnostics bundle.

### shre-connector

Owns Shre integration:

- Tenant/app/store context.
- Event capture.
- Redaction/minimization.
- Remote batch send.
- Heartbeat.
- Chat/RAG/training handoff.

### message gateways

External user channels such as WhatsApp, ShreChat, Claude, and Codex should route through the MIB/Shre connector registry before reaching the local connector. Local-only mode can receive messages directly through `POST /api/messages/inbound`.

## Runtime Storage

The current implementation uses SQLite for local-first runtime state.

Current runtime database:

```text
runtime.sqlite
```

SQLite WAL sidecar files may also exist while the dashboard API is running:

```text
runtime.sqlite-wal
runtime.sqlite-shm
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

The `app_state` table stores current profile, onboarding, Verifone connection, Verifone status, password status, and queue replay status as JSON documents. Dedicated tables are used where replay/history matters.

See [Connector Flow](connector-flow.md) for cloud-to-local message routing.

See [Local Database Decision](local-database-decision.md) for why SQLite remains the default local database instead of Postgres.

See [Commander Concurrency](commander-concurrency.md) for how local Commander calls are serialized to reduce device contention.

## Local Ports

Recommended defaults:

- `5480`: dashboard API/UI.
- `5481`: future diagnostics API if split.
- `5482`: future Shre connector API if split.

Keep all APIs bound to localhost by default.

The preferred user-facing loopback alias is:

```text
http://cstoresku:5480
```

This is a hosts-file alias for `127.0.0.1`, not LAN exposure. `cstoresku.local` is optional and may conflict with mDNS. See [Local Alias](local-alias.md).

## Container Strategy

Development and production should support:

- Single installer.
- Multi-container Docker Compose.
- ARM64/aarch64 and AMD64 images.
- Local volume for runtime data.
- Upgrade without deleting runtime storage.

## Security

- Never commit runtime files.
- Never log passwords.
- Store credentials encrypted where platform support exists.
- Treat Shre `bootstrapKey` as a secret.
- Use read-only Shre mode unless the local service must perform remote actions.
- Tenant isolation is mandatory on all Shre requests.
- Cloud relay inbound requests must be signed with timestamp, nonce, tenant ID, agent ID, and HMAC signature.
- Mutating JSON APIs reject non-JSON content types and cross-origin browser origins.
