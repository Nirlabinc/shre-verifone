# Architecture

## Decision

Create a new Phase 2 application: `Verifone-Commander-Shre-Cstoresku`.

Rationale:

- Phase 1 is a stable packaged Verifone sync service.
- Phase 2 needs a browser dashboard, API, local queue, Shre connector, diagnostics, and AI data governance.
- Keeping Phase 2 separate avoids destabilizing the installer-only release.

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

## Runtime Storage

The current implementation uses local JSON/JSONL files so the local-first API can be tested end to end immediately. Production should move the same contracts onto SQLite.

Current runtime files:

```text
profile.json
onboarding.json
connections/verifone.json
connections/verifone-status.json
connections/password-status.json
queue/items.json
queue/status.json
logs/activity.jsonl
diagnostics/bundle-*.json
```

Recommended SQLite database:

```text
runtime.sqlite
```

Tables:

- `profile`
- `connections`
- `password_status`
- `sync_commands`
- `sync_jobs`
- `sync_attempts`
- `outbound_queue`
- `inbound_snapshots`
- `entity_versions`
- `conflicts`
- `diagnostic_events`
- `shre_events`
- `shre_exports`
- `chat_audit_log`

## Local Ports

Recommended defaults:

- `5480`: dashboard API/UI.
- `5481`: future diagnostics API if split.
- `5482`: future Shre connector API if split.

Keep all APIs bound to localhost by default.

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
