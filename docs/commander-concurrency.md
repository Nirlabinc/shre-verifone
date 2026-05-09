# Commander Concurrency

## Problem

In some stores, more than one POS, backoffice system, or local tool may hit Commander at the same time to pull the same data. If every client runs full pulls or push commands independently, Commander can slow down, timeout, or appear hung.

## Strategy

This local application must not compete with itself.

All Commander-facing local work should go through:

```text
inbound request
→ outbound_queue
→ single queue worker
→ commander lease
→ Commander POS
→ release lease
→ record attempt/activity
```

## Implemented Local Guard

The dashboard API now has a SQLite-backed Commander lease:

```http
GET  /api/commander/lease/status
POST /api/commander/lease/acquire
POST /api/commander/lease/release
```

Only one local worker can hold the lease at a time. If another worker tries to acquire it while active, the API returns `423 Locked`.

## What This Solves

This prevents this application from:

- Running two local full pulls at the same time.
- Pushing while a pull is active.
- Starting a manual sync while an automatic sync is active.
- Letting multiple local message commands hit Commander at once.

## What It Does Not Solve

This cannot directly stop other external systems that bypass this connector and call Commander directly.

For external clients:

- Coordinate polling intervals.
- Avoid full pulls during peak sales.
- Prefer incremental sync where possible.
- Use one store-local connector as the primary Commander access point.
- Keep other tools read-only or scheduled.

## Recommended Sync Policy

- Serialize all writes.
- Serialize full pulls.
- Allow only small read-only status checks outside the full-sync lock if proven safe.
- Use TTL leases so a crashed worker does not block forever.
- Record every sync attempt.
- Add jitter to scheduled sync jobs so many stores do not call cloud or Commander at exactly the same time.

## Future Improvement

Add a queue worker that automatically:

- Acquires the Commander lease.
- Executes one queued Commander operation.
- Extends the lease heartbeat for long operations.
- Releases the lease.
- Retries with backoff on failure.
- Marks stuck jobs for support review.
