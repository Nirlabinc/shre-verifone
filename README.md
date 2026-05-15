# Verifone Commander Shre CStoreSKU

Local-first Phase 2 platform for Verifone Commander, CStoreSKU/RapidRMS sync operations, Shre AI event learning, browser dashboard/API, offline queue, password-expiration workflow, and diagnostics.

Author: Nirav Patel, Rapid Infosoft LLC, `info@rapidinfosoft.com`

## Purpose

Phase 1 packaged the existing Verifone Commander sync worker as a single container with cross-platform installers.

Phase 2 turns that install into a local platform:

- Browser dashboard and local API.
- Local data chat backed by tool calls.
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
apps/chat-ui            standalone store operator messenger
apps/access-portal      Cloudflare Access app chooser
apps/product-landing    marketing page with lead capture
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
- [Installation Data Map](docs/installation-data-map.md)
- [Credential Acquisition](docs/credential-acquisition.md)
- [Environment Promotion](docs/environment-promotion.md)
- [Local Alias](docs/local-alias.md)
- [Customer Onboarding](docs/customer-onboarding.md)
- [Developer Onboarding](docs/developer-onboarding.md)
- [Support Runbook](docs/support-runbook.md)
- [Connectivity Rules](docs/connectivity-rules.md)
- [Commander PDK Agent Rules](docs/commander-pdk-agent-rules.md)
- [Storage, Retention, And Backup](docs/storage-retention-backup.md)
- [Production Update And Restart](docs/production-update.md)
- [Pilot Installation Guide](docs/pilot-installation-guide.md)
- [Pilot Production Readiness](docs/pilot-production-readiness.md)
- [Cloudflare Remote Access](docs/cloudflare-remote-access.md)
- [One-Click Installer](docs/one-click-installer.md)
- [Verifone PDK Command Catalog](docs/verifone-pdk-command-catalog.md)
- [Technical Specs](docs/technical-specs.md)
- [Commander Concurrency](docs/commander-concurrency.md)
- [App Boundary Decision](docs/app-boundary-decision.md)
- [Add-on Architecture](docs/addon-architecture.md)
- [FCC Connector Add-on](docs/fcc-connector.md)
- [MCP Server](docs/mcp-server.md)
- [Shre AI Learning And Fine-Tuning](docs/shre-ai-learning.md)
- [Local AI / Ollama Option](docs/local-ai-ollama.md)
- [Security Hardening](docs/security-hardening.md)
- [Local Login And Billing](docs/login-billing.md)

## Shre SDK Findings

The existing Shre SDK family uses the same wire contract across Swift, .NET, Python, and the private platform SDK:

- Control plane: `https://shre-auth.shre.ai` for dev/QA and `https://shre-auth.aros.live` for beta/prod
- Events plane: `https://events.shre.ai`
- Session endpoint: `/v1/sdk/session`
- Config endpoint: `/v1/sdk/config`
- Events endpoint: `/v1/events/batch`
- Heartbeat endpoint: `/v1/sdk/heartbeat`
- Required context: `tenantId`, `app`
- Optional context: `workspaceId`, `storeId`, `userId`, `role`
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
http://localhost:5480/landing
http://localhost:5480/portal
http://localhost:5480/chat
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

Run pilot preflight:

```powershell
npm run pilot:preflight
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
- Gateway-shaped inbound messages from future Claude/Codex/WhatsApp/ShreChat routes.
- Usage tracking and billing backfill through the dedicated usage replay path.
- Diagnostics bundle generation.
- Activity log events.

## Pilot install on a real store device

For deploying to an actual store (mac or windows), use the per-store installer instead of the dev quick-start above. Pick the path that fits the operator:

### 1. Browser download → double-click (no CLI knowledge required)

1. Open the release page in a browser (public — no GitHub login needed):
   <https://github.com/Nirlabinc/shre-verifone/releases/latest>
2. Download **Source code (zip)** and unzip it anywhere (Desktop, Downloads).
3. Double-click the installer for the OS:
   - **macOS:** `scripts/setup.command` — right-click → Open the first time (Gatekeeper).
   - **Windows:** `scripts/setup.cmd` — accept the UAC prompt to elevate.
4. The setup script asks for the **Shre tenant ID** (from the customer's marketplace signup) and a **device alias** (e.g. "Front Counter Register"), then installs and starts the service.

### 2. Command line (one-shot, for ops folks)

```bash
# macOS / Linux, in any shell with git + node 20+
gh release download pilot-v0.1.3 -R Nirlabinc/shre-verifone -A zip
unzip shre-verifone-pilot-v0.1.3.zip
cd shre-verifone-pilot-v0.1.3
./scripts/setup.sh --tenant-id <id> --device-alias "Front Counter"
```

```powershell
# Windows, in an Administrator PowerShell with git + node 20+
gh release download pilot-v0.1.3 -R Nirlabinc/shre-verifone -A zip
Expand-Archive shre-verifone-pilot-v0.1.3.zip
cd shre-verifone-pilot-v0.1.3
.\scripts\setup.ps1 -TenantId <id> -DeviceAlias "Front Counter"
```

### 3. Git clone (for developers / dev installs)

```bash
git clone --branch pilot-v0.1.3 https://github.com/Nirlabinc/shre-verifone.git
cd shre-verifone
./scripts/setup.sh --tenant-id <id> --device-alias "Front Counter"
```

The setup script:
1. Checks for Node 20+, git
2. Runs `npm install && npm run build`
3. Calls `scripts/install-shre-connector.sh` (mac/linux) or `.ps1` (windows) which writes `aros-config.json`, generates the service unit (launchd / systemd / Scheduled Task), and starts it.

Idempotent — re-running updates the config and restarts the service. To remove, run `./scripts/install-shre-connector.sh --uninstall` (or the `.ps1` equivalent).

For credential rotation, on-disk file inventory, and incident response, see [`SECURITY.md`](SECURITY.md).

## Docker

## One-Click Pilot Install

Windows support-led install:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-oneclick.ps1 `
  -TunnelName store001-verifone-commander `
  -PortalHostname store001-portal.example.com `
  -DashboardHostname store001-dashboard.example.com `
  -ChatHostname store001-chat.example.com `
  -VerifoneHostname store001-verifone.example.com `
  -TunnelToken "<cloudflare-tunnel-token>" `
  -ConfigureCloudflareAccess `
  -InstallDashboardService `
  -InstallCloudflareService
```

Linux/macOS support-led install:

```bash
DASHBOARD_HOSTNAME=store001-dashboard.example.com \
PORTAL_HOSTNAME=store001-portal.example.com \
CHAT_HOSTNAME=store001-chat.example.com \
VERIFONE_HOSTNAME=store001-verifone.example.com \
TUNNEL_TOKEN='<cloudflare-tunnel-token>' \
INSTALL_CLOUDFLARE_SERVICE=true \
INSTALL_DASHBOARD_SERVICE=true \
bash scripts/install-oneclick.sh
```

Use `scripts/install-oneclick-aarch64.sh` for ARM64 edge devices and `scripts/install-oneclick-android-termux.sh` for Android/Termux pilots. Details are in [docs/one-click-installer.md](docs/one-click-installer.md).

```powershell
docker compose -f infra/docker-compose.yml up --build
```

Product landing page:

```text
http://localhost:5480/landing
```

Remote access portal:

```text
http://localhost:5480/portal
```

Run with the legacy CStoreSKU/Varifone sidecar:

```powershell
$env:CSTORESKU_LEGACY_IMAGE="varifone-service:latest"
$env:CSTORESKU_LEGACY_PLATFORM="linux/amd64"
docker compose -f infra/docker-compose.yml --profile cstoresku up --build
```

This sidecar profile requires Docker Compose v2 with named-volume `subpath` support.
Use `HOST_PORT=5594` when testing beside an already-running local dashboard on port `5480`.

The sidecar shares the protected runtime volume and receives the original CStoreSKU mount shape:

```text
/app/DataSource -> /runtime/cstoresku-runtime/DataSource
/app/xml        -> /runtime/cstoresku-runtime/xml
/app/logs       -> /runtime/cstoresku-runtime/logs
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
cstoresku-runtime/
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
