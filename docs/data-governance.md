# Data Governance

## Principle

The store installation is local-first. Remote learning is opt-in, tenant-scoped, minimized, and auditable.

## Data Classes

### Local Operational Data

Examples:

- Verifone connection config.
- Sync jobs and attempts.
- Pull/push status.
- Local queue entries.
- Diagnostics.
- Activity logs.

Default: local only.

### Approved Analytics Events

Examples:

- Sync completed.
- Item count pulled.
- Queue replay completed.
- Password expiration warning.
- Sales query asked.

Default: can be sent to Shre if tenant is configured.

### Sensitive Data

Examples:

- Raw passwords.
- Payment data.
- Customer PII.
- Employee PII.
- Full transaction payloads.
- Secrets/API keys.

Default: never send to Shre training or event streams.

## AI Pattern

Use RAG/query tools first. Do not fine-tune directly on raw store data.

Recommended flow:

```text
raw store data
→ local normalized DB
→ policy/redaction layer
→ approved summaries/events
→ Shre event/RAG/training services
→ chat answer with audit trail
```

Fine-tuning is appropriate for:

- Domain vocabulary.
- Query intent examples.
- Support workflows.
- Synthetic examples.
- Approved anonymized examples.

Fine-tuning is not appropriate for:

- Raw transactions.
- Passwords.
- Payment-adjacent fields.
- Customer/employee records.
- Store secrets.

## Audit Requirements

Every remote export should record:

- Tenant ID.
- Store ID.
- Export type.
- Data class.
- Row/event count.
- Redaction policy version.
- Destination.
- Timestamp.
- Success/failure.
- Operator/user when applicable.

## Chat Requirements

Chat should use a permissioned query API:

- User asks a sales question.
- API determines allowed data scope.
- Local SQL/RAG context is queried.
- Remote model receives only needed context.
- Answer and source query metadata are logged.

All chat actions should be tenant-scoped and auditable.
