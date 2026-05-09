# Setup Tree

## Complete System Tree

```text
Customer / Store Operator
└─ Message Gateway
   ├─ WhatsApp
   ├─ ShreChat
   ├─ Claude
   ├─ Codex
   └─ Other approved channels

Cloud / MIB / Shre
└─ connector.aros.live
   ├─ tenant registry
   ├─ store registry
   ├─ connector catalog
   │  ├─ rapidrms-api
   │  └─ verifone-commander
   ├─ routing policy
   ├─ auth / relay identity
   ├─ audit
   └─ optional model orchestration

Store PC / Local Install
└─ Verifone-Commander-Shre-Cstoresku
   ├─ dashboard-ui
   │  └─ browser interface on localhost
   ├─ dashboard-api
   │  ├─ onboarding API
   │  ├─ profile API
   │  ├─ Verifone connection API
   │  ├─ password workflow API
   │  ├─ connector activation API
   │  ├─ inbound message API
   │  ├─ Commander lease API
   │  ├─ queue API
   │  └─ diagnostics API
   ├─ runtime.sqlite
   │  ├─ app_state
   │  ├─ activity_log
   │  ├─ outbound_queue
   │  ├─ chat_audit_log
   │  ├─ diagnostic_bundles
   │  ├─ commander_locks
   │  ├─ sync_attempts
   │  └─ conflicts
   ├─ queue-worker
   │  └─ replays local queued work
   ├─ shre-connector
   │  └─ sends approved events / heartbeat / future RAG handoff
   ├─ diagnostics
   │  └─ host and service health snapshots
   └─ sync-service
      └─ Commander and CStoreSKU/RapidRMS sync worker

Store Network
├─ Verifone Commander POS
├─ CStoreSKU / RapidRMS SQL
└─ Other POS/register clients
```

## Local API Tree

```text
GET  /api/health
GET  /api/onboarding
POST /api/onboarding
GET  /api/profile
POST /api/profile
GET  /api/verifone/status
POST /api/verifone/config
POST /api/verifone/validate
GET  /api/password/status
POST /api/password/auto-reset
POST /api/password/manual-update
GET  /api/connectors/catalog
GET  /api/connector/status
POST /api/connector/activate
POST /api/messages/inbound
GET  /api/messages/audit
GET  /api/commander/lease/status
POST /api/commander/lease/acquire
POST /api/commander/lease/release
GET  /api/queue
POST /api/queue/enqueue
POST /api/queue/replay
GET  /api/diagnostics
POST /api/diagnostics/bundle
GET  /api/activity
```

## Connector Decision Tree

```text
User asks a question or sends a command
├─ Backoffice / RapidRMS management?
│  └─ route to rapidrms-api
├─ Commander POS / sync / diagnostics?
│  └─ route to verifone-commander
├─ Sales/reporting question?
│  ├─ query local verifone-commander first
│  └─ enrich with rapidrms-api when needed
└─ General AI/help question?
   └─ route to Shre/RAG with approved local context
```
