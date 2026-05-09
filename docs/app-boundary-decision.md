# App Boundary Decision

## Decision

Keep `Verifone-Commander-Shre-Cstoresku` as one local application package with separate internal modules/services.

Do not split the CStoreSKU/Verifone connector flow and the Shre SDK bridge into two separate installable apps right now.

## Recommended Shape

```text
Verifone-Commander-Shre-Cstoresku
├─ dashboard-api
├─ dashboard-ui
├─ sync-service
│  └─ Verifone Commander / CStoreSKU local sync
├─ shre-connector
│  └─ Shre SDK events, heartbeat, RAG/training handoff
├─ queue-worker
├─ diagnostics
└─ runtime.sqlite
```

## Why One App Is Better Now

- One installer for the store.
- One runtime folder.
- One local database.
- One dashboard.
- One support workflow.
- One diagnostics bundle.
- One local queue and Commander lease.
- Less chance that Shre events and POS sync state drift apart.

The store operator should not need to understand two products.

## Internal Separation Still Matters

The implementation should keep clear boundaries:

```text
Commander/CStoreSKU domain
  -> POS connection, sync, password state, Commander lease

Shre domain
  -> tenant context, event export, heartbeat, model/RAG/training handoff

Dashboard/API domain
  -> onboarding, support, diagnostics, message gateway ingress

Queue domain
  -> local durability, retries, replay, conflict records
```

This gives us clean code ownership without creating multiple apps for the customer.

## When To Split Later

Split into separate apps only if one of these becomes true:

- Shre connector must be reused across many non-Verifone products.
- Different teams need independent releases.
- Shre event processing needs its own scaling/runtime.
- Security rules require the AI bridge to run isolated from POS access.
- A customer wants the Verifone connector without any Shre features.

Even then, keep the default store install bundled.

## Release Recommendation

Current release model:

```text
one repo
one installer
one Docker Compose stack
multiple services
one local SQLite database
```

Future enterprise model:

```text
shared shre-connector package
product-specific local apps
optional external Postgres
optional cloud relay agent
```
