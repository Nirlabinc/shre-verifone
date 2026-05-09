# Phase 2 Roadmap

## Milestone 1: Local Platform Skeleton

- New repo.
- Dashboard API.
- Dashboard UI shell.
- Runtime folder.
- Service boundaries.
- Docker Compose.
- CI.
- Documentation.

Status: complete.

## Milestone 1.5: Local-First API Flow

- Onboarding endpoint.
- Profile endpoint.
- Verifone config/status endpoint.
- Password status, auto-reset failure, and manual update endpoints.
- Offline queue enqueue/replay endpoints.
- Diagnostics bundle endpoint.
- Activity log endpoint.
- E2E API test.

Status: complete.

## Milestone 2: SQLite Runtime Store

- Add SQLite.
- Add migrations.
- Replace JSON file status.
- Add queue tables.
- Add diagnostics tables.
- Add profile/config tables.

## Milestone 3: Verifone Workflow

- Import Phase 1 config logic.
- Validate Commander connection.
- Show password status.
- Add manual password update.
- Add sync command visibility.

## Milestone 4: Offline Queue

- Queue outbound operations.
- Replay worker.
- Retry/backoff.
- Conflict records.
- Dashboard queue controls.

## Milestone 5: Shre Connector

- Configure tenant/app/store.
- Integrate Shre SDK.
- Send approved events.
- Heartbeat.
- Remote config/kill switch.
- Audit exports.

## Milestone 6: Chat With Sales Data

- Local query API.
- Data permission layer.
- RAG context builder.
- Shre chat integration.
- Chat audit log.

## Milestone 7: Installer And Release

- One-command installer.
- Docker Compose release.
- Windows/macOS/Linux.
- AMD64 and ARM64/aarch64.
- GitHub Releases.
- GHCR images.
