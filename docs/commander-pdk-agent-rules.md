# Commander PDK Agent Rules

These rules apply to local workers, Shre message agents, support scripts, marketplace add-ons, and future MCP tools that read from or write to Verifone Commander through the PDK.

## Non-Negotiable Rules

1. All Commander calls must go through the local API. Do not let chat, cloud relay, CStoreSKU, FCC, Loyalty, or support scripts call Commander directly.
2. Acquire the Commander lease before every Commander-facing operation.
3. Run only one Commander operation at a time from this app.
4. Use `read_only` by default. Writes require `read_write` or `write_only`.
5. Treat PDK commands beginning with `u`, `c`, `send`, or `changepasswd` as mutating.
6. Never run mutating commands from natural-language intent without an approved structured operation.
7. Never store plain credentials, cookies, XML queue payloads, or response bodies outside encrypted runtime storage.
8. Never log `user`, `passwd`, `password`, `cookie`, `token`, `key`, XML secrets, or application keys.
9. Never retry a write blindly after an unknown result. Verify first, then retry only if the write is known not to have landed or the command is explicitly idempotent.
10. Heavy pulls must be scheduled and serialized. Do not run repeated full report pulls on every user question.

## PDK Session Rules

PDK login uses:

```text
/cgi-bin/CGILink?cmd=validate&user=<username>&passwd=<password>
```

The returned cookie is cached locally for a short TTL and then used as:

```text
/cgi-bin/CGILink?cmd=<command>&cookie=<cookie>
```

Rules:

- Refresh the cookie only when missing, expired, or rejected.
- Do not request a new cookie before every report if the cached cookie is valid.
- On credential failure, update password status and stop scheduled pulls until credentials are fixed.
- On timeout or network failure, release the lease and let heartbeat/backoff handle reconnect.
- Redact the cookie from API responses, activity logs, diagnostics, and queue metadata.

## Read/Pull Rules

Use reads for analytics, chat answers, dashboard status, health checks, and write verification.

Required sequence:

1. Check access mode. `read_only` and `read_write` allow reads. `write_only` should not run analytics pulls.
2. Check heartbeat/connection state.
3. Acquire Commander lease.
4. Login or reuse cached PDK cookie.
5. Prefer PDK report list commands before pulling historical files:
   - transaction logs: `vtlogpdlist`
   - cashier reports: `vcashierpdlist`
   - car wash paypoint reports: `vcwpaypointpdlist`
   - database reports: `vreportpdlist`
   - VIPER reports: `vviperpdList`
6. Pull only the required report/date/period/file.
7. Store raw XML first in `commander_reports`.
8. Normalize XML into Conexxus/NAXML-aligned JSON.
9. Derive query tables/snapshots only after raw XML is saved.
10. Release Commander lease.
11. Record activity and sync attempt result.

Avoid:

- Full historical pulls during business hours.
- Parallel report pulls.
- Pulling the same report repeatedly for every chat question.
- Pulling while a write-back operation is pending for the same entity.
- Treating an HTTP 200 as valid data if the body is a fault, login page, empty response, or non-XML payload.

## XML Parse And Database Rules

Raw XML is the source of record.

Storage path:

```text
Commander XML
-> commander_reports.xml_json encrypted raw XML
-> commander_reports.normalized_json encrypted normalized JSON
-> sales_snapshots or future typed tables for query speed
```

Required parse rules:

- Validate that the response starts with XML and has a known root before treating it as data.
- Detect and reject Commander fault XML.
- Preserve raw XML even if normalization is partial.
- Store report metadata:
  - `report_type`
  - `business_date`
  - `source`
  - `root_name`
  - `created_at`
- Normalize to Conexxus/NAXML-style fields:
  - `standard`
  - `schemaValidation`
  - `reportType`
  - `businessDate`
  - `totals`
  - `records`
  - `sourceRoot`
- Do not discard unknown XML fields. Keep raw XML for later remapping.
- Limit preview/output returned to UI/API. Do not return full sensitive XML to chat by default.
- Use typed local tables only for frequently queried summaries. Keep raw XML in `commander_reports`.

Current normalized report families:

- sales/movement
- batch
- fuel
- tank
- journal
- information/config/report responses through PDK

Reports that need typed expansion next:

- PLU/item
- department/category
- tax
- network/payment
- VIPER batch/payment/loyalty/prepaid
- cashier/payroll
- eSafe
- car wash

## Write Rules

CStoreSKU write mode sends XML to:

```http
POST /api/commander/writeback
```

Required write sequence:

1. Confirm access mode is `read_write` or `write_only`.
2. Validate that the selected PDK command is mutating and approved for the entity.
3. Validate XML is well-formed enough to identify root/entity keys.
4. Store the XML as an encrypted `outbound_queue` item before sending to Commander.
5. Acquire Commander lease.
6. Login or reuse cached PDK cookie.
7. Submit XML to Commander using the configured transport:
   - default: `POST` body with `application/xml`
   - site-specific fallback: query parameter transport only when confirmed
8. Record response status and body preview.
9. Run write verification.
10. Mark the queue item:
    - `completed` only when verification passes
    - `verification_failed` when Commander accepted but read-back did not prove load
    - `failed` when Commander rejected or the operation could not be sent
11. Release Commander lease.
12. Record activity and sync attempt.

Never:

- Mark a write complete from HTTP status alone.
- Retry a write with unknown outcome without checking read-back state.
- Let chat text create arbitrary XML.
- Allow cloud services to bypass local access mode.
- Use deprecated write commands unless a site-specific support runbook allows it.

## Write Verification Rules

Every production write should define verification.

Preferred verification:

| Write | Verify |
| --- | --- |
| `uPLUs` | `vPLUs` and expected item code/description/price |
| `ufuelprices` | `vfuelprices` and expected grade/price |
| `u*cfg` | matching `v*cfg` and expected field |
| event config updates | `veventcfg`, `vsetevent`, or `veventhistory` depending on operation |
| password change | login validation with the new credential; never log either password |

Verification may be:

- response text match, only for commands that return a reliable success marker
- read-back command plus expected XML/text match
- read-back command plus normalized field comparison

If verification cannot be performed, status must remain operationally visible as accepted but unverified. Do not hide it as success.

## Retry And Backoff Rules

- Heartbeat owns reconnect cadence.
- Queue replay owns failed work retry.
- Use exponential backoff for Commander/network failures.
- Do not retry immediately in a tight loop.
- Do not retry write operations when the previous attempt may have succeeded but verification failed.
- On `423 Locked`, wait for lease expiry or release by owner.
- On credential errors, stop Commander work until credentials are corrected.
- On repeated parse failures, stop that report path and require endpoint/PDK mapping review.

Recommended defaults:

- Short reads: 10 second HTTP timeout.
- Commander lease: 60 seconds for light reads, 120 seconds for report pulls, 180-240 seconds for writes.
- Heavy report pull interval: 5 minutes or longer unless site-specific approval exists.
- Full historical sync: off-hours or operator-triggered.

## Concurrency And Lockup Avoidance

To avoid Commander lockups:

- Keep one local connector as the primary Commander access point.
- Serialize all local Commander commands through `commander_locks`.
- Add jitter to scheduled jobs.
- Avoid peak business hours for full pulls.
- Do not let FCC, Loyalty, POS/BOS, and chat workers run independent Commander polling loops.
- Use cached local SQLite data to answer chat whenever possible.
- If external systems also poll Commander, lower our pull frequency and document the external schedule.
- Keep diagnostics/ping lightweight. Ping should not trigger report pulls.

## Security Rules

- Runtime database uses encrypted JSON payloads.
- Local API binds to `127.0.0.1` by default.
- Mutating local API requests require JSON content type and local-origin protection.
- Use local admin/session controls for dashboard operations.
- Use connector signatures for external gateway calls.
- Never expose raw Commander XML to a remote cloud unless the connector entitlement and data-sharing policy allow it.
- Send only needed normalized data to Shre/cloud by default.
- Keep raw XML local-first.

## Agent Decision Rules

When a user asks a sales/report question:

1. Query local SQLite first.
2. If local data is fresh enough, answer from local data.
3. If data is missing/stale, queue or run one approved pull.
4. Store and parse the XML.
5. Answer from normalized data.

When a user asks to update Commander:

1. Convert intent into a structured operation.
2. Confirm access mode and entitlement.
3. Generate or receive approved XML from CStoreSKU/backend.
4. Queue the write.
5. Submit under lease.
6. Verify with read-back.
7. Report final state with queue ID and verification status.

When unsure:

- Do not write.
- Do not invent a PDK command.
- Do not bypass the queue.
- Ask support/operator for the exact command mapping, entity key, period, filename, or verification rule.
