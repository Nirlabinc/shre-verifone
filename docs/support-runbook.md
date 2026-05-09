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
GET /api/connector/manifest
GET /api/notifications
GET /api/auth/status
GET /api/usage/summary
POST /api/sales/query
GET /api/activity
POST /api/diagnostics/bundle
```

Every API response includes an `x-request-id` header. The activity log records `api_request_completed` with request ID, method, path, status code, duration, and remote address.

The dashboard header and Overview screen show notifications from `/api/notifications` when Verifone is disconnected, password action is required, queue work fails or waits, marketplace activation is missing, or local sales data has not been ingested.

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
- Commander connectivity.
- SQL connectivity.
- Shre/cloud connectivity if queue target is Shre.
- Commander lease status.

### Sales Question Does Not Answer

Check:

- Connector is activated for the correct tenant/store.
- `/api/messages/audit` shows the inbound message.
- `/api/sales/query` returns an answer for the requested business date.
- Local Commander sales ingest has written a recent `sales_snapshots` record.
- If the query returns `requiresDataSource: true`, configure or repair the Commander sales ingest before troubleshooting Shre.

### Multiple Clients Hitting Commander

The local app uses a Commander lease and queue to avoid competing from this application. If external POS systems or third-party tools hit Commander directly, coordinate polling intervals and schedule heavy pulls outside peak sales periods.

## Diagnostics Bundle

Create:

```http
POST /api/diagnostics/bundle
```

The bundle is stored in local SQLite. It includes state and activity but must not include passwords.
