# Verifone Edge Relay

Lightweight edge agent that runs on store owner's computer (same LAN as Commander).
Syncs Commander data locally via SQLite, uplinks to Shre AI cloud.

## Port

18464 (local admin UI — outside Shre 5400-5999 range, not a platform service)

## Architecture

- Runs on customer Windows/Linux machine
- No Redis/CortexDB — all local persistence is SQLite + flat files
- Commander client code shared with `../src/commander/` (copied at build)
- Uplinks data to `shre-router /v1/edge/*` endpoints
- Receives agent DNA, skills, commands via downlink polling

## Key Files

- `src/main.mjs` — Entry point, service lifecycle
- `src/config.mjs` — SQLite-backed config
- `src/commander/` — Commander CGI client (ported from ../src/commander/)
- `src/sync/` — Interval-based sync engine with SQLite ledger
- `src/uplink/` — HTTPS POST to Shre cloud + offline WAL buffer
- `src/vault/` — AES-256-GCM envelope encryption (SQLite)
- `src/secretservice/` — Activity logging, anomaly detection, audit chain
- `src/updater/` — Auto-update with SHA256 verification + rollback
- `src/cleanup/` — Retention manager + disk monitor
- `src/admin/` — Local HTTP server for setup wizard + status dashboard

## Database

Single `relay.db` in data directory. Vault in separate `vault.db`.

## Data Tiers

- Tier 1 (always): Aggregated sales/dept/hourly metrics
- Tier 2 (recommended): Skill performance, query patterns, error rates
- Tier 3 (opt-in): E2E encrypted transaction data

## Build

`node build/build.mjs` → standalone binaries via esbuild + pkg/SEA
