# Support Runbook

## First Checks

1. Open the dashboard: `http://localhost:5480`.
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
GET /api/activity
POST /api/diagnostics/bundle
```

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

### Multiple Clients Hitting Commander

The local app uses a Commander lease and queue to avoid competing from this application. If external POS systems or third-party tools hit Commander directly, coordinate polling intervals and schedule heavy pulls outside peak sales periods.

## Diagnostics Bundle

Create:

```http
POST /api/diagnostics/bundle
```

The bundle is stored in local SQLite. It includes state and activity but must not include passwords.
