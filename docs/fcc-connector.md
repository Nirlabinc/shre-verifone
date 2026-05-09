# FCC Connector Add-on

FCC is an optional marketplace add-on. It is not part of the default POS/BOS package.

## Current Implementation

The repo now includes a containerized FCC add-on service:

```text
services/fcc-connector
```

Start locally after build:

```powershell
npm run build
npm run start:fcc
```

Docker Compose profile:

```powershell
docker compose -f infra/docker-compose.yml --profile fcc up --build
```

Default local port:

```text
http://127.0.0.1:5483
```

## API

```http
GET  /health
GET  /version
GET  /recommendations
POST /message
```

Example message:

```json
{
  "messageText": "fcc health"
}
```

The service can currently report:

- FCC connector health.
- Missing configuration.
- Troubleshooting suggestions.
- Message-driven help responses.

Live FCC protocol operations will be added when the full FCC specs are mapped.

## Environment

```text
FCC_ENDPOINT=
FCC_MODE=diagnostic_only
FCC_PORT=5483
FCC_HOST=127.0.0.1
APP_VERSION=0.1.0
BUILD_CHANNEL=dev
BUILD_SHA=
```

Modes:

- `diagnostic_only`: health, errors, suggestions, and troubleshooting only.
- `read_only`: future FCC read/capture operations.
- `read_write`: future approved FCC actions.

## Message Gateway Use

For external message gateways, FCC messages should route through the main edge app first:

```text
message gateway
-> signed /api/messages/inbound
-> local adapter routing
-> FCC connector /message or /health
-> response back through gateway
```

This keeps tenant/workspace/store validation, signing, audit, and usage reporting centralized at the edge app.

## Versioning

The FCC connector exposes:

```http
GET /version
```

The main dashboard exposes:

```http
GET /api/version
```

Use `APP_VERSION`, `BUILD_CHANNEL`, and `BUILD_SHA` for dev/QA/beta/prod. The dashboard returns a `cacheKey` built from these values so clients can detect version changes and clear cache.

## Next Mapping Work

When FCC specs are available, map:

- FCC health/status commands.
- FCC error codes.
- FCC recovery actions.
- FCC network/transport checks.
- Safe read commands.
- Any approved write commands.
- Required credentials and secret storage.
- Queue targets and retry policy.
