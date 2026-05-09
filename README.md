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
http://localhost:5480
```

Build:

```powershell
npm run build
```

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
profile.json
connections/verifone.json
connections/shre.json
queue/events.jsonl
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

This repo is ready for initial API/dashboard implementation. The next implementation step is replacing JSON file stores with SQLite and wiring the Shre connector to the production tenant.
