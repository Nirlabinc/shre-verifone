# Local Login And Billing

## Local Login

After initial setup, the dashboard creates a local login secret. The secret itself is not stored. A salted `scrypt` hash is stored inside encrypted runtime state.

Flow:

1. First launch opens the local login setup panel.
2. User creates a store-local login secret.
3. The app creates a 12-hour local session.
4. Future starts require login unless `LOCAL_ADMIN_TOKEN` is supplied by an installer/service profile.

Offline behavior:

- Local login works offline.
- Remote validation is best-effort.
- If Shre validation is unavailable, login continues and the status becomes `offline_pending`.
- Background validation retries every 5 minutes while the API is running.
- If the server returns `suspended`, `deactivated`, or `rejected`, the dashboard shows a critical notification and blocks metered chat/cloud relay actions.
- If validation later returns `active`, the app updates the entitlement/key metadata and resumes metered operations.

Remote validation endpoint:

```text
SHRE_AUTH_VALIDATE_URL=
```

When configured, the app POSTs tenant/store/app identity to this endpoint at startup, login, manual validation, and background retry.

Manual entitlement/key refresh:

```http
POST /api/auth/refresh-key
```

The validation response can include:

```json
{
  "status": "active",
  "entitlementState": "active",
  "keyVersion": "2026-05"
}
```

## Usage And Billing

The local connector records token/cost usage events for message responses and queues them for `shre-cost` reporting.

Endpoints:

```http
GET /api/usage/summary
POST /api/usage/record
POST /api/usage/replay
```

Reporting target:

```text
SHRE_COST_ENDPOINT=
```

If the cost endpoint is unavailable or not configured, events remain stored locally and are queued as `shre-cost` work. This prevents silent free use while still allowing offline store operation.

Current token estimates use a deterministic local estimate of approximately 4 characters per token. When a cloud model is added, provider-reported token counts should replace this estimate.

`POST /api/usage/replay` is the dedicated backfill path. It replays only pending `shre-cost` usage queue items and changes usage rows from `pending_report` to `reported` when successful. The generic queue replay still exists for all queued work, but support should use the usage replay endpoint when resolving billing backfill.

## Suspended Or Deactivated Accounts

Local data capture should continue while an account is suspended. The store should not lose POS continuity because of a billing outage.

Allowed while suspended:

- Local Verifone/Commander setup and validation.
- Local sales ingest/snapshots.
- Local diagnostics and support data.
- Local queue/backlog storage.

Blocked while suspended:

- Local chat.
- Cloud relay inbound messages.
- Metered Shre/model/tool actions.

Backfill:

- Local snapshots and queue entries remain stored.
- `usage_events` remain stored.
- `shre-cost` queue items remain pending.
- When the account is active again, `POST /api/usage/replay` reports missed usage and the generic queue replay can sync pending cloud events.

This protects store operations while still preventing suspended accounts from continuing billable AI/chat services without reactivation.

## Limits

This layer discourages unreported usage and supports billing reconciliation, but it cannot fully prevent offline tampering by an administrator with filesystem and process access. Production installers should pair this with code signing, secure service configuration, and periodic server-side entitlement checks.
