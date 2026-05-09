# Shre Marketplace Registration

## Positioning

Register this as a Shre platform connector package, not as a core Shre agent.

The Shre SDK has four connector types:

- `node`: external/local system endpoint.
- `tool`: callable operation exposed to agents or message gateway.
- `app`: UI/application integration point.
- `pipe`: data flow between systems.

For this product:

- Node connector: `verifone-commander`.
- App connector: `verifone-commander-dashboard`.
- Tools: sales query, queue sync, health check, password status.
- Pipe: local Verifone sales summaries to Shre learning/RAG after tenant approval.

## Marketplace Manifest

Static manifest:

```text
marketplace/verifone-commander.connector.json
```

Runtime manifest:

```http
GET /api/connector/manifest
```

The runtime manifest is preferred during activation because it includes the active local base URL. If the user opens `http://cstoresku:5480`, the runtime manifest emits `cstoresku` endpoints unless `LOCAL_BASE_URL` is configured.

## Registration Flow

1. Install the local app at the store.
2. Complete user profile and Verifone connection setup.
3. Activate the connector locally:

```http
POST /api/connector/activate
```

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

4. Submit `GET /api/connector/manifest` to `connector.aros.live`.
5. Bind the connector to tenant ID, store ID, allowed message sources, and data scopes.
6. Grant read-only tools first: `verifone:sales-query`, `verifone:health-check`, `verifone:password-status`.
7. Enable mutating tools only after operator authorization policy is configured.

## Message Gateway Flow

```text
ShreChat / WhatsApp / Claude / Codex
  -> message gateway
  -> connector.aros.live tenant/store router
  -> Verifone Commander Connector
  -> local /api/messages/inbound
  -> runtime.sqlite sales snapshots, queue, audit
  -> response returned to user
```

For sales questions, the connector should call:

```http
POST /api/sales/query
```

The local API responds immediately when a matching local sales snapshot exists. If the store has not configured sales ingest yet, it returns `202` with `requiresDataSource: true` and queues the request.

## Relationship To RapidRMS API Connector

Keep `rapidrms-api` and `verifone-commander` as separate connectors.

- `rapidrms-api`: cloud/backoffice CStoreSKU and RapidRMS data.
- `verifone-commander`: store-local POS data, local Commander command queue, diagnostics, password state, and offline mode.

Link them by tenant ID and store ID so Shre can choose the right tool for each question.

## Required Platform Gaps Before Public Release

- Secure local relay: the cloud gateway cannot call a store-local `localhost` URL directly. Use an outbound agent, tunnel, or polling relay.
- Request signing: enforce `x-shre-signature`, timestamp, nonce, tenant ID, and agent ID on local inbound requests.
- Data permissions: register `sales.read`, `diagnostics.read`, `credentials.status.read`, and `sync.write` in platform permissions.
- Commander sales ingest: wire live Commander report/API/SQL import into `sales_snapshots`.
- Tenant mapping: connector registry must map tenant ID, store ID, and local endpoint identity.
- User authorization: mutating commands must require explicit store/operator approval.
- Training boundary: send only approved summaries/examples to Shre. Keep raw POS/customer/payment-adjacent data local by default.
- Gateway E2E: add a mocked message gateway test that signs a request, routes through the connector, and validates the response contract.

## Current Implemented Contract

- `GET /api/connector/manifest`
- `POST /api/connector/activate`
- `GET /api/connector/status`
- `GET /api/connectors/catalog`
- `POST /api/messages/inbound`
- `GET /api/messages/audit`
- `POST /api/sales/snapshot`
- `POST /api/sales/query`

The E2E test seeds a local sales snapshot and verifies that a WhatsApp-style inbound message receives a sales answer from SQLite.
