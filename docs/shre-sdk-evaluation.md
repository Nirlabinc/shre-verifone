# Shre SDK Evaluation

## Repositories Reviewed

Local evaluation folder:

```text
C:\Users\NiravPatel\OneDrive - RapidRMS\Desktop\Projects\shre-sdk-eval
```

Repos:

- `Shreai/shre-sdk`: private TypeScript platform SDK.
- `Shreai/sdk-swift`: public Swift/iOS/macOS SDK.
- `Shreai/sdk-dotnet`: public .NET SDK.
- `Shreai/sdk-python`: public Python SDK.

The user mentioned `nirlab`; the authenticated GitHub account currently sees Shre SDK repositories under the `Shreai` organization. The private `Shreai/shre-sdk` repo is accessible with the current token.

## Production Contract

The language SDKs use a consistent event SDK contract:

- Control plane: `https://apiauth.shre.ai`
- Events plane: `https://events.shre.ai`
- Start/session: `POST /v1/sdk/session`
- Config: `GET /v1/sdk/config`
- Event batch: `POST /v1/events/batch`
- Heartbeat: `POST /v1/sdk/heartbeat`

Required configuration:

- `tenantId`
- `app`

Optional context:

- `storeId`
- `userId`
- `role`

Modes:

- `read_only`: default analytics/event mode.
- `read_write`: requires `bootstrapKey`.

## SDK Behavior To Match

Phase 2 should follow these production behaviors:

- Fire-and-forget event capture.
- Local bounded queue.
- Batch flush.
- Retry/backoff for network, `429`, and `5xx`.
- Re-bootstrap on `401`.
- Kill-switch on `403`.
- Remote config refresh.
- Heartbeat.
- Idempotency through `eventId`.
- No UI blocking.

## Header/Context Pattern

SDKs send tenant/app context as headers:

- `X-Shre-Tenant`
- `X-Shre-App`
- `X-Shre-SDK-Version`
- `X-Shre-Store` when store context exists.
- `Authorization: Bearer <sdkToken>` after bootstrap.

The private TypeScript platform SDK also includes tenant context helpers, logging, Cortex, RAG, events, training, PII redaction, audit, and service identity modules. Phase 2 should use the TypeScript SDK for cloud-facing connector work because it includes the richest AI/platform surface.

## Recommended Usage In This Product

Use two Shre integration levels:

1. Event SDK behavior for local store telemetry and approved business events.
2. Private platform SDK modules for RAG/training/query workflows.

Event names should be domain-specific:

- `verifone_connection_validated`
- `sync_cycle_started`
- `sync_cycle_completed`
- `sync_cycle_failed`
- `item_pulled`
- `item_pushed`
- `password_expiring`
- `password_auto_reset_failed`
- `offline_queue_replayed`
- `diagnostics_bundle_created`
- `sales_query_asked`

## Open Items

- Confirm tenant ID for this CStoreSKU/Verifone integration.
- Confirm whether app slug should be `verifone_cstoresku`, `rapid_bos`, or a new Shre app.
- Confirm whether this connector should use `read_only` only or needs `read_write`.
- Confirm remote destination for approved model training examples.
- Confirm whether the private TypeScript SDK is published to npm or should be consumed through GitHub package access.
