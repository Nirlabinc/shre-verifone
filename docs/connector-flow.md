# Connector Flow

## Short Answer

For production cloud message routing, activate/register `verifone-commander` under the MIB/Shre platform at:

```text
https://connector.aros.live
```

Local-only mode does not require cloud activation. Cloud-routed mode does.

`https://connector.aros.live/health` was reachable during implementation and returned HTTP `200`.

## End-To-End Flow

```text
user
  -> message gateway
     WhatsApp / ShreChat / Claude / Codex / other
  -> connector registry
     tenant + store + connector mapping
  -> optional cloud relay
     auth, policy, audit, routing
  -> local Verifone-Commander-Shre-Cstoresku
     dashboard-api + runtime.sqlite + offline queue
  -> Commander POS / CStoreSKU / SQL
```

## Why Activate The Connector

Activation tells the platform:

- Which tenant owns the local install.
- Which store the local install represents.
- Which connector ID handles requests.
- Whether cloud relay is allowed.
- Which channels can route messages to this connector.
- Which actions are read-only vs command-capable.

Recommended connector ID:

```text
verifone-commander
```

Recommended app slug:

```text
verifone_cstoresku
```

## Connector Relationship

You already have a RapidRMS API connector. The Verifone Commander connector should be added as a second connector, not as a replacement.

```text
rapidrms-api
  -> backoffice/cloud API, CStoreSKU/RapidRMS data, management APIs

verifone-commander
  -> store-local Commander POS access, local sync commands, password status,
     diagnostics, offline queue, local sales/chat context
```

The two connectors can be linked by tenant ID and store ID. The cloud can decide which connector to call based on the user request:

- Sales/reporting question: usually local `verifone-commander` first, with RapidRMS API as an enrichment source if needed.
- Backoffice management request: `rapidrms-api`.
- POS sync or Commander command: `verifone-commander`.
- Health/diagnostics: `verifone-commander`.

## Local-First Behavior

The local install remains the system of action.

- Local API receives messages.
- Local SQLite stores message audits.
- Local offline queue stores work.
- Commander/SQL actions run locally.
- Cloud can enrich, route, and learn from approved data, but does not need to be in the critical path for local operations.

## Current Implemented Local APIs

Connector marketplace manifest:

```http
GET /api/connector/manifest
```

Connector catalog:

```http
GET /api/connectors/catalog
```

Connector status:

```http
GET /api/connector/status
```

Activate/register connector locally:

```http
POST /api/connector/activate
```

Example:

```json
{
  "connectorId": "verifone-commander",
  "connectorName": "Verifone Commander",
  "tenantId": "tenant_rapid_001",
  "storeId": "store_001",
  "app": "verifone_cstoresku",
  "cloudRelayEnabled": true,
  "registryUrl": "https://connector.aros.live",
  "relatedConnectors": ["rapidrms-api"]
}
```

Inbound message:

```http
POST /api/messages/inbound
```

Example:

```json
{
  "source": "whatsapp",
  "tenantId": "tenant_rapid_001",
  "storeId": "store_001",
  "userId": "operator_1",
  "messageId": "msg_001",
  "messageText": "What were sales today?"
}
```

Message audit:

```http
GET /api/messages/audit
```

Sales snapshot ingest:

```http
POST /api/sales/snapshot
```

Sales query:

```http
POST /api/sales/query
```

Example:

```json
{
  "query": "What were sales today?",
  "businessDate": "2026-05-09"
}
```

When a local sales snapshot exists, the API returns an immediate answer from `runtime.sqlite`. If no snapshot exists yet, it returns `202` with `requiresDataSource: true` and the inbound message remains queued.

## Current Message Classification

The local API classifies inbound messages into:

- `sales_query`: queued for local sales/query API.
- `sync_command`: queued for Commander/local sync workflow.
- `health_check`: queued for diagnostics.
- `general_question`: queued for Shre/RAG answer flow.

This is intentionally simple for the first E2E milestone. Later, Shre can provide richer intent routing while the local API keeps enforcing policy and audit.

## Security Rules

- Cloud gateway must authenticate to local connector before production exposure.
- Local API should stay bound to loopback unless a secure tunnel/agent is installed.
- `cstoresku` is a loopback hosts-file alias, not LAN/cloud exposure.
- Cloud relay inbound requests must include timestamp, nonce, tenant ID, agent ID, and HMAC signature.
- Tenant ID and store ID must match local activation.
- Passwords and secrets are never included in message audits.
- Write-capable commands should require explicit operator permission.

## MIB/Shre Platform Registration Fields

Recommended registration fields:

- `connectorId`
- `connectorName`
- `tenantId`
- `storeId`
- `app`
- `registryUrl`
- `environment`
- `allowedSources`
- `allowedIntents`
- `readOnly`
- `cloudRelayEnabled`
- `relatedConnectors`
- `localEndpointId`
- `publicKey` or tunnel identity

See [Shre Marketplace Registration](shre-marketplace-registration.md) for the static manifest, runtime manifest, registration steps, and public-release gaps.

## Production Routing Recommendation

Use this split:

- Cloud gateway handles channel adapters, identity, tenant routing, and model orchestration.
- Local connector handles POS facts, queueing, sync commands, and final authorization.

That keeps the store operational even if cloud is degraded.
