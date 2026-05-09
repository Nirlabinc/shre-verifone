# Connector Flow

## Short Answer

For production cloud message routing, activate/register `verifone-commander` under the MIB/Shre platform.

Local-only mode does not require cloud activation. Cloud-routed mode does.

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

## Local-First Behavior

The local install remains the system of action.

- Local API receives messages.
- Local SQLite stores message audits.
- Local offline queue stores work.
- Commander/SQL actions run locally.
- Cloud can enrich, route, and learn from approved data, but does not need to be in the critical path for local operations.

## Current Implemented Local APIs

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
  "tenantId": "tenant_rapid_001",
  "storeId": "store_001",
  "app": "verifone_cstoresku",
  "cloudRelayEnabled": true
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

## Current Message Classification

The local API classifies inbound messages into:

- `sales_query`: queued for local sales/query API.
- `sync_command`: queued for Commander/local sync workflow.
- `health_check`: queued for diagnostics.
- `general_question`: queued for Shre/RAG answer flow.

This is intentionally simple for the first E2E milestone. Later, Shre can provide richer intent routing while the local API keeps enforcing policy and audit.

## Security Rules

- Cloud gateway must authenticate to local connector before production exposure.
- Local API should stay bound to localhost unless a secure tunnel/agent is installed.
- Tenant ID and store ID must match local activation.
- Passwords and secrets are never included in message audits.
- Write-capable commands should require explicit operator permission.

## MIB/Shre Platform Registration Fields

Recommended registration fields:

- `connectorId`
- `tenantId`
- `storeId`
- `app`
- `environment`
- `allowedSources`
- `allowedIntents`
- `readOnly`
- `cloudRelayEnabled`
- `localEndpointId`
- `publicKey` or tunnel identity

## Production Routing Recommendation

Use this split:

- Cloud gateway handles channel adapters, identity, tenant routing, and model orchestration.
- Local connector handles POS facts, queueing, sync commands, and final authorization.

That keeps the store operational even if cloud is degraded.
