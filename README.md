# Verifone Commander Shre CStoreSKU

Local-first Phase 2 platform for Verifone Commander, CStoreSKU/RapidRMS sync operations, Shre AI event learning, browser dashboard/API, offline queue, password-expiration workflow, and diagnostics.

Author: Nirav Patel, Rapid Infosoft LLC, `info@rapidinfosoft.com`

## Purpose

Phase 1 packaged the existing Verifone Commander sync worker as a single container with cross-platform installers.

Phase 2 turns that install into a local platform:

- Browser dashboard and local API.
- Setup/onboarding and user profile.
- Verifone connection validation.
- Pull/push command visibility.
- Local offline queue and replay tracking.
- Password expiration and reset workflow.
- Diagnostics and host health monitoring.
- Shre AI tenant/event integration.
- Federated data model: local-first storage, approved remote learning.

## Current Shape

This repo is the Phase 2 scaffold. It is intentionally separate from `Verifone-Commander-cstoresku` so Phase 1 stays stable while Phase 2 grows into a multi-service product.

```text
apps/dashboard-api      local HTTP API and static dashboard host
apps/dashboard-ui       browser dashboard shell
services/shre-connector Shre SDK/event bridge
services/queue-worker   offline queue/replay worker boundary
services/diagnostics    diagnostics service boundary
docs                    architecture, SDK evaluation, data governance
infra                   Docker Compose and runtime layout
scripts                 local developer/operator helpers
```

## Architecture

Local services run on the store machine. Remote Shre services receive only approved tenant-scoped events, summaries, embeddings, or training examples.

```text
Verifone Commander
       |
sync-service / imported Phase 1 worker
       |
local runtime database + offline queue
       |
dashboard-api <-> dashboard-ui
       |
shre-connector -> Shre control plane / events / RAG / training
```

See [docs/architecture.md](docs/architecture.md).

Message gateway and connector routing are documented in [docs/connector-flow.md](docs/connector-flow.md).

Shre marketplace registration is documented in [docs/shre-marketplace-registration.md](docs/shre-marketplace-registration.md). The repo includes a static connector manifest at [marketplace/verifone-commander.connector.json](marketplace/verifone-commander.connector.json), and the running local API exposes the active manifest at `GET /api/connector/manifest`.

Local database choice is documented in [docs/local-database-decision.md](docs/local-database-decision.md). The current default is SQLite, not Postgres.

Setup, onboarding, support, and specs:

- [Setup Tree](docs/setup-tree.md)
- [Local Alias](docs/local-alias.md)
- [Customer Onboarding](docs/customer-onboarding.md)
- [Developer Onboarding](docs/developer-onboarding.md)
- [Support Runbook](docs/support-runbook.md)
- [Technical Specs](docs/technical-specs.md)
- [Commander Concurrency](docs/commander-concurrency.md)
- [App Boundary Decision](docs/app-boundary-decision.md)
- [Local AI / Ollama Option](docs/local-ai-ollama.md)
- [Security Hardening](docs/security-hardening.md)
- [Local Login And Billing](docs/login-billing.md)

## Shre SDK Findings

The existing Shre SDK family uses the same wire contract across Swift, .NET, Python, and the private platform SDK:

- Control plane: `https://apiauth.shre.ai`
- Events plane: `https://events.shre.ai`
- Session endpoint: `/v1/sdk/session`
- Config endpoint: `/v1/sdk/config`
- Events endpoint: `/v1/events/batch`
- Heartbeat endpoint: `/v1/sdk/heartbeat`
- Required context: `tenantId`, `app`
- Optional context: `storeId`, `userId`, `role`
- Events are idempotent by `eventId`
- Local queue with retry/backoff is expected
- Read-only mode is the default for analytics
- Read-write mode requires `bootstrapKey`

See [docs/shre-sdk-evaluation.md](docs/shre-sdk-evaluation.md).

## Quick Start

Install dependencies:

```powershell
npm install
```

Run the local dashboard/API:

```powershell
npm run dev:api
```

Open:

```text
http://cstoresku:5480
http://localhost:5480
```

To enable the `cstoresku` loopback alias, see [docs/local-alias.md](docs/local-alias.md). The alias maps to the same local machine and does not expose the service to the LAN.

Build:

```powershell
npm run build
```

Run the current local-first E2E flow:

```powershell
npm run test:e2e
```

Run the download/setup/message simulation E2E:

```powershell
npm run test:e2e:download
```

Send a signed Shre CLI-style message to a running local connector:

```powershell
$env:CONNECTOR_SHARED_SECRET="your-shared-secret"
npm run shre:message -- --base-url http://127.0.0.1:5480 --tenant tenant_rapid_001 --store store_001 --message "What were sales today?"
```

The E2E test starts the dashboard API against a temporary runtime folder and verifies:

- Health endpoint.
- Onboarding state.
- User/store profile save.
- Verifone connection config save with password redaction.
- Local Verifone validation status.
- Password expiration/failure/manual-update workflow.
- Offline queue enqueue/replay.
- Shre connector manifest.
- Local sales snapshot ingest and sales query response.
- Chat/message gateway answer from local SQLite when sales data exists.
- Diagnostics bundle generation.
- Activity log events.

## Docker

```powershell
docker compose -f infra/docker-compose.yml up --build
```

## Configuration

Runtime files live under:

```text
%USERPROFILE%\.verifone-shre-cstoresku
~/.verifone-shre-cstoresku
```

Expected future configuration:

```text
runtime.sqlite
logs/
diagnostics/
```

## Data Policy

Do not send raw POS/customer/payment-adjacent data to model training by default.

Use this order:

1. Store raw operational data locally.
2. Normalize into a local database.
3. Redact and minimize.
4. Send approved events/summaries to Shre.
5. Use RAG/query tools for sales questions.
6. Use fine-tuning only for approved examples, terminology, and workflows.

See [docs/data-governance.md](docs/data-governance.md).

## CI/CD

GitHub Actions validates TypeScript build and documentation presence.

## Phase 2 Status

Implemented now:

- Local dashboard API.
- Browser dashboard shell.
- Local runtime folders.
- Onboarding/profile endpoints.
- Verifone config/status endpoints.
- Password expiration status, failed auto-reset state, and manual update endpoint.
- Offline queue enqueue/replay endpoints.
- Diagnostics bundle endpoint.
- Activity log endpoint.
- API request/response activity events.
- E2E API test for the local-first flow.
- SQLite-backed runtime store with migrations.
- Connector activation/status endpoints.
- Shre marketplace connector manifest endpoint.
- Static marketplace manifest for `connector.aros.live` registration.
- Inbound message gateway endpoint.
- Chat/message audit log.
- Local sales snapshot and sales query endpoints.
- Connector catalog for existing `rapidrms-api` and new `verifone-commander`.
- Commander lease endpoints to prevent this local app from competing with itself against Commander.

Next implementation step: wire live Commander/Shre tenant integrations behind the existing API contracts, then add secure cloud relay authentication and local command authorization.
