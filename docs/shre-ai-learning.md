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
