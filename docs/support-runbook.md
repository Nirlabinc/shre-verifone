# Support Runbook

## First Checks

1. Open the dashboard: `http://cstoresku:5480` or `http://localhost:5480`.
2. Check `/api/health`.
3. Check connector status.
4. Check Verifone status.
5. Check password status.
6. Check queue status.
7. Generate diagnostics bundle.

## Useful API Calls

```http
GET /api/health
GET /api/connector/status
GET /api/verifone/status
GET /api/password/status
GET /api/queue
GET /api/access-mode
GET /api/addons
GET /api/adapters
GET /api/remote-access
GET /api/mcp/tools
GET /api/connector/manifest
GET /api/notifications
GET /api/readiness
GET /api/auth/status
GET /api/usage/summary
POST /api/usage/replay
GET /api/messages/contract
POST /api/sales/query
GET /api/activity
POST /api/diagnostics/bundle
```

Every API response includes an `x-request-id` header. The activity log records `api_request_completed` with request ID, method, path, status code, duration, and remote address.

The dashboard header and Overview screen show notifications from `/api/notifications` when Verifone is disconnected, password action is required, queue work fails or waits, marketplace activation is missing, or local sales data has not been ingested.

`GET /api/readiness` is the go-live checklist endpoint. `ready: true` means no critical local blockers remain. `productionReady: true` also requires production Shre Auth signup and usage billing endpoints to be configured.

If login validation shows `offline_pending`, the user can continue local work. Confirm internet access and `SHRE_AUTH_VALIDATE_URL`, then use `POST /api/auth/validate` or wait for background retry.

If `LOCAL_ADMIN_TOKEN` is configured, enter it in the dashboard header before using setup, queue, diagnostics, audit, or connector screens.

## Alias Troubleshooting

- Run `npm run alias:check` on Windows.
- Confirm the hosts file contains the managed `cstoresku` block.
- Try `http://localhost:5480` if `http://cstoresku:5480` does not resolve.
- Clear browser DNS cache or restart the browser after changing hosts entries.
- In Docker, confirm the API is published as `127.0.0.1:5480:5480` and the container has `HOST=0.0.0.0`.

## Common Issues

### Commander Not Reachable

Check:

- Store PC is on the store network.
- Commander IP/URL is correct.
- Firewall/VPN is not blocking access.
- Commander credentials are valid.
- Another POS/device is not overwhelming Commander.

### Password Expiring Or Expired

Check:

- `/api/password/status`
- Manual update screen/API.
- Activity log for auto-reset failure.

Do not request or store passwords in tickets.

### Queue Growing

Check:

- `/api/queue`
- `/api/access-mode`
- Commander connectivity.
- SQL connectivity.
- Shre/cloud connectivity if queue target is Shre.
- Commander lease status.

### Sales Question Does Not Answer

Check:

- Connector is activated for the correct tenant/store.
- The incoming gateway payload matches `GET /api/messages/contract`.
- `/api/messages/audit` shows the inbound message.
- `/api/sales/query` returns an answer for the requested business date.
- Local Commander sales ingest has written a recent `sales_snapshots` record.
- If the query returns `requiresDataSource: true`, configure or repair the Commander sales ingest before troubleshooting Shre.

### Usage Billing Backfill

Check:

- `/api/usage/summary` for `pendingReport`, `reported`, and `failedReport`.
- `/api/queue` for target `shre-cost`.
- Account entitlement is active before replaying metered cloud work.

Run `POST /api/usage/replay` after billing/network recovery. This replays usage reporting without touching unrelated Commander or cloud queue items.

### Multiple Clients Hitting Commander

The local app uses a Commander lease and queue to avoid competing from this application. If external POS systems or third-party tools hit Commander directly, coordinate polling intervals and schedule heavy pulls outside peak sales periods.

### Inventory Updates Blocked

Check:

- `/api/access-mode`
- `/api/queue`
- `/api/commander/lease/status`
- Activity log for `access_mode_updated`

Inventory writes require `read_write` or `write_only`. Keep stores in `read_only` until write-back has been approved and validated.

### Add-on Not Available

Check:

- `/api/addons`
- `/api/adapters`
- Marketplace entitlement for tenant/workspace/store.
- Access mode if the add-on needs writes.

FCC and Loyalty are not installed by default. They must be enabled through marketplace activation before add-on workflows should appear for the user.

## Diagnostics Bundle

Create:

```http
POST /api/diagnostics/bundle
```

The bundle is stored in local SQLite. It includes state and activity but must not include passwords.
