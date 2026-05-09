# Connectivity Rules

This runbook is the first place to check when a store reports that Verifone Commander, CStoreSKU, Shre, marketplace add-ons, message gateway, or local dashboard connectivity is not behaving as expected.

## Golden Rules

1. The local dashboard/API is local-first. Default access is `http://localhost:5480` or `http://cstoresku:5480`.
2. Do not expose port `5480` directly to the LAN or internet. Remote access must use the approved Cloudflare tunnel or connector path with identity and signing.
3. Verifone Commander calls must go through the local API scheduler, queue, and Commander lease. Do not create a second polling worker that competes with the same Commander device.
4. Read mode and write mode are separate. Inventory/write-back requires `read_write` or `write_only`; analytics and sales questions should use `read_only`.
5. Runtime data is customer data. Updates must not delete `%USERPROFILE%\.verifone-shre-cstoresku` or `~/.verifone-shre-cstoresku`.
6. Never put Verifone passwords, Shre activation tokens, CStoreSKU keys, or connector signing secrets in support tickets.

## Connectivity Map

| Path | Direction | Rule | First check |
| --- | --- | --- | --- |
| Browser dashboard | Browser -> local API | Use loopback alias only unless remote access is explicitly enabled. | `GET /api/health` |
| Local login | Browser -> local secure vault | Login secret is local and works offline. Background validation resumes when Shre Auth is reachable. | `GET /api/auth/status` |
| Runtime database | API -> SQLite runtime | State, queue, logs, sales snapshots, and setup data persist across app updates. | `GET /api/health` and runtime guard |
| Verifone Commander | API -> Commander | Validate credentials, then heartbeat and scheduled pulls use backoff and the Commander lease. | `GET /api/verifone/heartbeat`, `GET /api/sync/status` |
| Commander concurrency | API scheduler -> Commander | One local lease holder at a time. External POS traffic must be accounted for in polling intervals. | `GET /api/commander/lease/status` |
| CStoreSKU | API -> CStoreSKU/RapidRMS connector | CStoreSKU key is separate from Verifone credentials. Link it only after local setup is complete. | `GET /api/connector/status` |
| Shre activation | API -> Shre Auth | Dev/QA uses `https://shre-auth.shre.ai`; beta/prod uses `https://shre-auth.aros.live`. | `POST /api/shre/signup-activate` |
| Message gateway | Gateway -> connector -> local API | Inbound commands must be tenant/workspace/store scoped and signed before local execution. | `GET /api/messages/contract` |
| Offline queue | API/worker -> targets | Failed cloud or Commander operations remain queued and replay with backoff. | `GET /api/queue` |
| Usage billing | API -> Shre cost/usage | Usage is captured locally first and reported when entitlement/network allows. | `GET /api/usage/summary` |
| Remote access | Cloudflare/connector -> local API | Disabled by default. Enable only with identity, tunnel health, and audit logging. | `GET /api/remote-access` |
| FCC add-on | Marketplace -> FCC service | Optional add-on. Base app stores config/status; FCC service owns FCC diagnostics. | `GET /api/addons` |
| Loyalty add-on | Marketplace -> Loyalty service | Optional add-on. Enable only after marketplace entitlement and connector registration. | `GET /api/addons` |

## Required Checks By Layer

### 1. Dashboard And Local API

Expected:

- Browser opens `http://localhost:5480` or `http://cstoresku:5480`.
- `GET /api/health` returns healthy.
- `GET /api/readiness` shows local blockers.
- If `LOCAL_ADMIN_TOKEN` is configured, the dashboard header token must be entered before restricted actions.

Fix path:

1. Try `http://localhost:5480` if the alias fails.
2. Run `npm run alias:check` for the `cstoresku` alias.
3. Confirm the service is listening on port `5480`.
4. Confirm no firewall rule blocks loopback access.

### 2. Runtime Storage

Expected:

- Runtime folder exists:

```text
Windows: %USERPROFILE%\.verifone-shre-cstoresku
macOS/Linux: ~/.verifone-shre-cstoresku
```

- Runtime folder includes `.runtime-protected`.
- SQLite stores setup state, queue, logs, local sales snapshots, and diagnostics.
- App updates preserve the folder.

Fix path:

1. Run `npm run runtime:check`.
2. Confirm disk space and file permissions.
3. Do not delete the runtime folder unless a support/admin reset is explicitly approved.

### 3. Verifone Commander

Expected:

- Verifone connection block stores Commander URL, username, and password in the local vault/runtime.
- Validate updates connection status in the UI.
- Heartbeat continues in the background and uses backoff when Commander is down.
- Saving Verifone config schedules local pull.

First checks:

```http
GET /api/verifone/status
GET /api/verifone/heartbeat
GET /api/sync/status
GET /api/activity
```

Fix path:

1. Confirm the store PC can reach the Commander IP/URL.
2. Confirm Commander credentials and password expiration state.
3. Confirm the Commander lease is not held by another local job.
4. If external POS devices are also polling Commander, reduce local pull frequency and avoid peak sales windows.

### 4. Read, Write, And Queue Rules

Expected:

- `read_only`: pull/snapshot/query allowed; write-back blocked.
- `read_write`: pull/query/write-back allowed.
- `write_only`: write-back allowed; analytics reads should not run.
- Failed operations queue locally and replay when connectivity recovers.

First checks:

```http
GET /api/access-mode
GET /api/queue
POST /api/queue/replay
```

Fix path:

1. Confirm the selected access mode matches the store approval.
2. Confirm queued items have the expected target and operation.
3. Replay only after Commander or cloud connectivity has recovered.
4. For missed writes while suspended/offline, replay the queue; for missed reads, run the scheduled pull/backfill process.

### 5. CStoreSKU, Shre Auth, And Connector

Expected:

- Workspace and store setup are completed before activation.
- CStoreSKU key is entered in its own block.
- Shre activation is handled through Shre Auth where possible.
- Dev/QA Shre Auth endpoint is `https://shre-auth.shre.ai`.
- Beta/prod Shre Auth endpoint is `https://shre-auth.aros.live`.

First checks:

```http
GET /api/connector/status
GET /api/connectors/catalog
POST /api/shre/signup-activate
POST /api/shre/activation-token
GET /api/auth/status
```

Fix path:

1. Confirm workspace ID, tenant ID, and store ID match the marketplace registration.
2. Confirm CStoreSKU key is not being confused with Verifone credentials.
3. If login validation is offline, let local work continue and check background validation once Shre Auth is reachable.
4. If account is suspended, block metered cloud work, notify the user, and replay usage/queue items after reactivation.

### 6. Message Gateway And Remote Commands

Expected:

- Future message gateways such as Shre Chat, WhatsApp, Claude, Codex, or CLI send commands through the connector contract.
- Connector verifies tenant/workspace/store scope before local execution.
- Sensitive write commands require write mode and should produce audit/activity records.

First checks:

```http
GET /api/messages/contract
GET /api/messages/audit
POST /api/sales/query
GET /api/activity
```

Fix path:

1. Verify request signature and timestamp.
2. Verify tenant/workspace/store routing.
3. Confirm the local database has the requested sales snapshot.
4. If `requiresDataSource: true`, repair Verifone ingest before troubleshooting the cloud connector.

### 7. Add-ons: FCC And Loyalty

Expected:

- FCC and Loyalty are not installed by default.
- Marketplace activation controls availability.
- Base app owns add-on configuration, entitlement, and status.
- Each add-on should own its dedicated dashboard, diagnostics, and troubleshooting workflow.

First checks:

```http
GET /api/addons
GET /api/adapters
GET /api/connector/manifest
```

Fix path:

1. Confirm the add-on is enabled for the tenant/workspace/store.
2. Confirm the add-on container/service version matches the environment.
3. Confirm add-on errors are visible in health, activity, and diagnostics.

## Symptom Table

| Symptom | Check first | Likely cause | Fix |
| --- | --- | --- | --- |
| Dashboard does not open | `GET /api/health` | API not running, wrong port, alias issue | Start API, use localhost, repair alias |
| Login secret accepted but setup blocked | `GET /api/auth/status` | Missing setup fields or admin token | Complete setup, enter admin token |
| Verifone validate button shows no connection | `GET /api/verifone/heartbeat` | Bad URL, credentials, firewall, timeout | Correct config, validate again |
| Pulls stop after a disconnect | `GET /api/sync/status` | Heartbeat backoff or Commander unreachable | Wait for retry or fix network |
| Commander becomes slow | `GET /api/commander/lease/status` | Competing pollers or peak traffic | Reduce pull frequency, coordinate external clients |
| Sales chat says data source required | `POST /api/sales/query` | No local sales snapshot | Repair Verifone ingest and backfill |
| Inventory update blocked | `GET /api/access-mode` | Store is read-only | Switch to approved write mode |
| Queue keeps growing | `GET /api/queue` | Target unavailable or entitlement blocked | Restore target, reactivate account, replay |
| Cloud command denied | `GET /api/messages/audit` | Signature, scope, or entitlement mismatch | Fix connector registration and signing |
| FCC/Loyalty missing | `GET /api/addons` | Add-on not activated | Enable through marketplace |

## Escalation Bundle

Before escalating, capture:

- `GET /api/readiness`
- `GET /api/health`
- `GET /api/verifone/heartbeat`
- `GET /api/sync/status`
- `GET /api/access-mode`
- `GET /api/queue`
- `GET /api/connector/status`
- `GET /api/usage/summary`
- `GET /api/addons`
- `GET /api/activity`
- `POST /api/diagnostics/bundle`

Include the app version, environment (`dev`, `qa`, `beta`, or `prod`), workspace ID, store ID, and request IDs from failed API responses. Do not include passwords, activation tokens, CStoreSKU keys, or signing secrets.
