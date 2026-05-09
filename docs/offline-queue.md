# Offline Queue

## Goal

Make sync resilient when Commander, SQL, or Shre remote services are temporarily unavailable.

## Queue Types

- Verifone outbound changes.
- CStoreSKU/RapidRMS outbound updates.
- Shre events.
- Diagnostics exports.
- Chat audit records.

## Recommended SQLite Tables

```sql
create table outbound_queue (
  id text primary key,
  tenant_id text not null,
  store_id text,
  target text not null,
  entity_type text not null,
  entity_id text,
  operation text not null,
  payload_json text not null,
  status text not null,
  attempt_count integer not null default 0,
  next_attempt_at text,
  last_error text,
  created_at text not null,
  updated_at text not null
);
```

```sql
create table sync_attempts (
  id text primary key,
  queue_id text,
  target text not null,
  started_at text not null,
  finished_at text,
  status text not null,
  error text
);
```

```sql
create table conflicts (
  id text primary key,
  entity_type text not null,
  entity_id text not null,
  local_payload_json text,
  remote_payload_json text,
  resolution text,
  created_at text not null,
  resolved_at text
);
```

## Rules

- All queued items must be idempotent.
- Retries use exponential backoff.
- Failed items stay visible in dashboard.
- Manual replay requires operator action.
- Queue size and age limits must be enforced.
- Diagnostics must include queue health without exposing secrets.

## Current Implementation

The dashboard API currently implements:

- `POST /api/queue/enqueue`
- `GET /api/queue`
- `POST /api/queue/replay`

The current store is `queue/items.json` plus `queue/status.json`. This is intentionally simple for the first E2E milestone. Milestone 2 moves the same behavior into SQLite tables.
