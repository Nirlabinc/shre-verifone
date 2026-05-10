# Pilot Installation Guide

This guide is for the first store pilot of Verifone Commander Shre CStoreSKU.

## 1. Confirm Store PC

Run preflight before installing:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\pilot-preflight.ps1 -RequireDocker -RequireCStoreSkuImage
```

Pass criteria:

- Node.js 20+ and npm are available.
- Runtime drive has at least 5 GB free.
- Runtime folder is writable.
- Docker and Docker Compose are available for CStoreSKU sidecar mode.
- `varifone-service:latest` or the configured CStoreSKU image is available.

## 2. Install Dependencies

```powershell
npm install
npm run build
npm run check
```

## 3. Protect Runtime

```powershell
npm run runtime:protect
```

Default runtime:

```text
%USERPROFILE%\.verifone-shre-cstoresku
```

Do not delete this folder during updates. It contains the local database, encrypted setup state, queue, logs, and CStoreSKU runtime folder.

## 4. Start Dashboard

```powershell
$env:PORT="5480"
$env:HOST="127.0.0.1"
npm run start:api
```

Open:

```text
http://localhost:5480
```

Optional local alias:

```powershell
npm run alias:install
```

Then open:

```text
http://cstoresku:5480
```

## 5. First Login And Store Profile

In the dashboard:

1. Create the local login secret.
2. Enter workspace name.
3. Enter corporate name.
4. Enter DBA.
5. Enter store ID.
6. Enter address, phone, email, and contact name.

Use the same workspace name for additional locations that should be grouped together.

## 6. Shre Activation

Preferred flow:

1. Open Marketplace.
2. Use Shre Auth signup and activation.
3. Confirm tenant ID, workspace ID, and store ID are populated.

Support fallback:

1. Enter Shre activation token.
2. Enter optional tenant/workspace/store override only if support provides it.

## 7. Verifone Commander Setup

In Verifone setup:

1. Enter Commander URL.
2. Enter Commander username.
3. Enter Commander password.
4. Enter optional sales pull path if the site uses a custom endpoint.
5. Save connection.
6. Validate connection.
7. Confirm heartbeat shows connected.

## 8. CStoreSKU Key And Runtime

1. Enter CStoreSKU application key.
2. Click `Export Config XML`.
3. Confirm CStoreSKU runtime shows config exported.
4. Pull a report from Commander.
5. Click `Stage Latest XML`.
6. Confirm XML file count increases.

Generated config:

```text
<runtime>\cstoresku-runtime\DataSource\DatabaseServers.xml
```

Staged XML:

```text
<runtime>\cstoresku-runtime\xml\<reportType>\*.xml
```

## 9. Start CStoreSKU Sidecar

Use Docker sidecar mode for Linux/macOS and pilot parity:

```powershell
$env:CSTORESKU_LEGACY_IMAGE="varifone-service:latest"
$env:CSTORESKU_LEGACY_PLATFORM="linux/amd64"
docker compose -f infra/docker-compose.yml --profile cstoresku up --build
```

If the native dashboard already uses port `5480`, test compose on another host port:

```powershell
$env:HOST_PORT="5594"
docker compose -f infra/docker-compose.yml --profile cstoresku up --build
```

## 10. Readiness And Go-Live

Check:

```http
GET /api/readiness
GET /api/cstoresku/runtime
GET /api/diagnostics
```

Dashboard checks:

- No critical notifications.
- Verifone heartbeat connected.
- CStoreSKU config exported.
- XML files staged.
- Queue has no failed items.
- Storage risk is low.
- Usage/billing endpoint configured for production.

## 11. Messenger Usage

Open `Chat`.

Supported pilot questions:

- `What were sales today?`
- `Show item price for UPC 00011122233344`
- `Show fuel prices`
- `Show tank status`
- `Is Commander connected?`

The local dashboard uses `/api/chat/local`. Future Shre Chat, Claude, Codex, WhatsApp, and gateway messages use `/api/messages/inbound` with tenant/workspace/store scope and connector signatures.

## 12. Support Bundle

Open `Health & Logs`, then click `Create Diagnostics Bundle`.

Share only the generated bundle with support. Do not paste passwords, activation tokens, connector signing secrets, or raw customer data into tickets.
