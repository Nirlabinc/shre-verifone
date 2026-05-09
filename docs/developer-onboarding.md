# Developer Onboarding

## Prerequisites

- Node.js 24 recommended.
- npm.
- Git.
- Docker Desktop for container testing.
- GitHub access to `Nirpat3/Verifone-Commander-Shre-Cstoresku`.

## Install

```powershell
npm install
```

## Build

```powershell
npm run build
```

## Run E2E

```powershell
npm run test:e2e
```

## Download/Setup/Shre CLI E2E

This clones or copies the app into a temporary folder, installs dependencies, starts the API, performs setup/registration, seeds local sales data, and sends a signed Shre CLI-style message.

Remote clone:

```powershell
npm run test:e2e:download
```

Current working tree copy:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\e2e-download-setup-shrecli.ps1 -SourcePath .
```

Manual Shre CLI-style message:

```powershell
$env:CONNECTOR_SHARED_SECRET="your-shared-secret"
npm run shre:message -- --base-url http://127.0.0.1:5480 --tenant tenant_rapid_001 --store store_001 --message "What were sales today?"
```

## Run Local API

```powershell
npm run build
npm run start:api
```

Open:

```text
http://cstoresku:5480
http://localhost:5480
```

## Local Alias

Windows:

```powershell
npm run alias:check
Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -File scripts\configure-local-alias.ps1 -Install'
```

macOS/Linux:

```bash
./scripts/configure-local-alias.sh check
sudo ./scripts/configure-local-alias.sh install
```

See [Local Alias](local-alias.md).

## Runtime Folder

Default:

```text
%USERPROFILE%\.verifone-shre-cstoresku
```

Override:

```powershell
$env:VERIFONE_SHRE_HOME="C:\temp\verifone-shre"
```

## Important Environment Variables

```text
PORT=5480
VERIFONE_SHRE_HOME=
CONNECTOR_REGISTRY_URL=https://connector.aros.live
CONNECTOR_SHARED_SECRET=
HOST=127.0.0.1
LOCAL_BASE_URL=http://cstoresku:5480
SHRE_ENDPOINT=https://shre-auth.aros.live
SHRE_EVENTS_ENDPOINT=https://events.shre.ai
SHRE_TENANT_ID=
SHRE_APP=verifone_cstoresku
SHRE_MODE=read_only
SHRE_BOOTSTRAP_KEY=
SHRE_AUTH_SIGNUP_URL=https://shre-auth.aros.live/api/connectors/verifone-commander/signup-activate
```

Installer/onboarding field ownership is tracked in [Installation Data Map](installation-data-map.md). Use that document when adding installer prompts, first-run setup fields, activation-token exchange, or support scripts.

## Development Rules

- Keep local-first behavior working without cloud.
- Do not log secrets.
- Do not send raw POS/payment/customer data to remote model training.
- Add or update E2E tests for every milestone.
- Keep docs aligned with implemented behavior.
- All Commander-facing operations must go through the queue and Commander lease.

## Current E2E Coverage

The E2E test starts the API against a temporary runtime folder and verifies:

- Health.
- Onboarding.
- Profile.
- Verifone config/status.
- Password workflow.
- Connector activation and catalog.
- Connector marketplace manifest.
- Local sales snapshot and sales query response.
- Inbound message routing.
- Signed Shre CLI-style message flow.
- API request/response activity events.
- Chat audit.
- Commander lease contention.
- Queue replay.
- Diagnostics bundle.
- Activity log.
