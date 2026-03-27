# shre-verifone

Verifone Commander POS integration service. Connects to Commander devices on LAN via CGI API, parses XML/HTML reports, normalizes to Conexxus schema, stores in CortexDB, and serves real-time analytics via WebSocket.

## Port

5464 (from ports.json)

## Key Differences from shre-rapidrms

- **LAN device** (not cloud API) — `https://{IP}/cgi-bin/CGILink?cmd=`
- **XML/HTML responses** (not JSON REST) — parsed via fast-xml-parser
- **Cookie-based sessions** (not Bearer tokens) — 30min TTL, auto-refresh
- **Fuel data native** — c-store/fuel POS, has fuel grades/dispensers/tank levels
- **500ms rate limit** — single-threaded embedded device, sequential requests only

## Key Files

- `live-server.mjs` — HTTP + WebSocket server (port 5464)
- `src/commander/client.mjs` — Commander CGI API client
- `src/commander/session.mjs` — Cookie session manager with circuit breaker
- `src/commander/xml-parser.mjs` — HTML/XML report → JSON normalizer
- `src/live/auto-sync.mjs` — Interval-based sync engine with ledger
- `src/live/data-refresh.mjs` — Poll loop with circuit breaker
- `src/analytics/extract-tables.mjs` — JSONB → normalized tables
- `src/analytics/create-views.mjs` — Materialized view creator
- `db/schema.sql` — verifone + verifone_analytics schemas

## Commander API

- Auth: `cmd=validate&user={u}&passwd={p}` → session cookie
- Reports: `cmd=vrubyrept&reptname={type}&period={1|2}&cookie={c}`
- Transaction logs: `cmd=vperiodrept&period={p}&filename={f}&cookie={c}`
- Period list: `cmd=vreportpdlist&cookie={c}`
- Rate limit: 500ms between requests

## Dependencies

- cortexdb-api (infra)
- shre-sdk (logger, cortex, events, rag)
