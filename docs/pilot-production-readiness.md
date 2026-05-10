# Pilot Production Readiness

Use this checklist before the pilot store goes live.

## Installer Hardening

- `scripts/pilot-preflight.ps1` and `scripts/pilot-preflight.sh` check runtime, Node, npm, disk, memory, port, Docker, Compose, and optional CStoreSKU image.
- `scripts/protect-runtime.*` marks the runtime folder protected.
- `scripts/production-update.*` backs up `runtime.sqlite`, `.install-secret`, and `.runtime-protected` before update.
- Docker sidecar startup supports `HOST_PORT` for port conflict testing.
- Runtime reset requires `ALLOW_VERIFONE_RUNTIME_RESET=I_UNDERSTAND_DELETE_LOCAL_DATA`.

Pilot pass criteria:

```powershell
npm run pilot:preflight
npm run check
docker compose -f infra/docker-compose.yml --profile cstoresku config --services
```

## CI/CD Release Hardening

Release workflow goals:

- Build and test on every push and pull request.
- On tags, publish release assets for Windows, Linux, macOS, and Docker compose bundles.
- Publish or reference multi-arch CStoreSKU sidecar images.
- Include checksums and release notes.
- Keep secrets out of release artifacts.

## Security Review

Pilot security controls:

- Local APIs require login/session or installer admin token after setup.
- Runtime JSON payloads are encrypted with the local install secret.
- Verifone passwords and CStoreSKU key are redacted in API responses.
- CStoreSKU `DatabaseServers.xml` writes `VL`, `VU`, and `VP` in legacy encrypted format.
- Raw XML is stored locally and is not sent to chat/model flows by default.
- Connector gateway messages require signature validation when cloud relay is enabled.

Open security items before GA:

- Code-sign Windows/macOS installers.
- Move install secret into OS secure storage where available.
- Add installer-created service account with least privilege.
- Review diagnostics bundle redaction against a real store dataset.
- Confirm Cloudflare tunnel identity and access policy before remote access.

## Observability

Available now:

- Health endpoint.
- Readiness endpoint.
- Activity log.
- Error log.
- Queue status.
- Usage/cost status.
- CStoreSKU runtime health.
- Commander heartbeat and ping.
- Diagnostics bundle.

Pilot pass criteria:

- Dashboard shows no critical notifications.
- `GET /api/readiness` has no critical blockers.
- `GET /api/cstoresku/runtime` reports `ready_with_xml` after first pull/stage.
- Queue failed count is zero.
- Disk risk is low.

## Messenger Communication

Pilot local channel:

- Dashboard `Chat` tab.
- API: `POST /api/chat/local`.

Future remote channels:

- Shre Chat.
- Message gateway.
- WhatsApp.
- Claude.
- Codex.
- Gemini.
- Voice.

Remote channels should route through connector registry and signed `/api/messages/inbound`, not directly to unauthenticated local endpoints.
