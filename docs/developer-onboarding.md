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

## Run Local API

```powershell
npm run build
npm run start:api
```

Open:

```text
http://localhost:5480
```

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
SHRE_ENDPOINT=https://apiauth.shre.ai
SHRE_EVENTS_ENDPOINT=https://events.shre.ai
SHRE_TENANT_ID=
SHRE_APP=verifone_cstoresku
SHRE_MODE=read_only
SHRE_BOOTSTRAP_KEY=
```

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
- Chat audit.
- Commander lease contention.
- Queue replay.
- Diagnostics bundle.
- Activity log.
