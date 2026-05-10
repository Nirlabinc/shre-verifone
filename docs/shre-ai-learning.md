# Shre AI Learning And Fine-Tuning

The local connector does not fine-tune a model directly on the store PC. It creates redacted, tenant-scoped learning candidates that Shre AI can later approve for RAG, routing improvement, or fine-tuning.

## Local Flow

```text
chat/gateway message
-> local intent classification
-> local tool call
-> local answer
-> usage event
-> learning candidate
-> optional approval
-> Shre AI RAG/fine-tune pipeline
```

Implemented local endpoints:

```http
GET  /api/learning/policy
POST /api/learning/policy
GET  /api/learning/examples
POST /api/learning/approve
```

Every local chat or signed inbound gateway message stores a candidate example with:

- source
- tenant/store context
- intent
- tool name
- redacted input text
- redacted output text
- metadata
- approval status

The local database encrypts candidate input/output text at rest.

When Shre Auth returns or implies `trainingConsent=granted`, the edge app enables policy-driven auto export. New chat/tool examples are stored as approved, converted into Shre training-record shape, queued for `shre-training`, and marked `exported`. If consent is denied or unknown, examples remain local candidates until manually approved and exported.

## What Can Be Learned

Good training/RAG examples:

- Which tool was selected for a user request.
- How sales, PLU, fuel, tank, and diagnostics questions should be routed.
- Successful answer formats.
- Store-specific terminology after redaction and approval.
- Failed routing cases corrected by support.

Do not fine-tune on:

- raw Commander XML
- Verifone credentials
- connector signing secrets
- cardholder/payment-adjacent data
- unapproved customer/store data

## Recommended Shre AI Production Pipeline

1. Collect candidate examples locally.
2. Redact and classify sensitivity locally.
3. Show approval queue in dashboard or Shre portal.
4. Export approved examples only.
5. Use approved examples first for RAG/tool-routing evaluation.
6. Fine-tune only on stable, reviewed examples that improve routing or answer style.
7. Keep model answers grounded in local tools; do not let fine-tuned memory override SQLite/Commander facts.

This keeps the edge app local-first while allowing Shre AI to improve routing and language quality across tenants with explicit governance.

## ShreAI Mesh Alignment

The Shre SDK repo uses three relevant contracts:

- `mesh`: nodes have role, services, health, and failover metadata.
- `tool-memory`: successful tool selections are learned as intent/domain/tool patterns.
- `training`: approved conversation records use `{ source, agentId, messages, quality, model, tenantId, taskType, domain, conversationType, meta }`.

This app exposes matching edge-compute endpoints:

```http
GET  /api/shre/mesh/node
POST /api/shre/mesh/register
GET  /api/learning/export
POST /api/learning/export
```

`POST /api/shre/mesh/register` stores the local edge node identity and queues a `mesh.edge.registered` event for Shre events ingestion. `POST /api/learning/export` converts approved local learning examples into Shre training-record shape and queues them for Shre training ingestion.

Each deployed store PC should therefore be treated as a Shre edge node:

```text
edge node
-> Commander XML ingest/writeback
-> local SQLite facts
-> MCP tools
-> learning candidates
-> approved Shre training/RAG/tool-memory export
```

Raw XML remains local. Approved export records include `meta.rawXmlIncluded=false`.

## Install And Plugin Flow

Recommended production flow:

```text
install app
-> open local dashboard
-> sign up / login with Shre Auth
-> Shre Auth activates tenant/workspace/store and learning policy
-> edge node registers into ShreAI mesh
-> connect Verifone Commander
-> enable CStoreSKU XML and/or TLog plugins
-> enable message/model connector plugin for Claude, Codex, Gemini, Voice, Shre Chat, WhatsApp
```

Plugin catalog:

```http
GET /api/plugins
```
