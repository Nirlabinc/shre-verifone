# Environment Promotion

This repo is ready to promote when CI passes and `/api/readiness` has no critical blockers in the target environment.

## Current Promotion Model

```text
local developer machine
-> dev/QA Shre Auth at shre-auth.shre.ai
-> beta/prod Shre Auth at shre-auth.aros.live
```

The local connector does not need Shre Auth running on the same store PC. It only needs HTTPS or reachable HTTP access to the configured Shre Auth signup/validation endpoints.

Dev and QA use `https://shre-auth.shre.ai`. Their activation/setup data should sync forward into `https://shre-auth.aros.live` when the beta/prod Shre Auth service is available.

## Environment Files

Use these examples as installer/service templates:

```text
.env.dev.example
.env.qa.example
.env.beta.example
.env.prod.example
```

Important values:

- `SHRE_ENV`: `dev`, `qa`, or `prod`.
- `SHRE_AUTH_SIGNUP_URL`: signup and connector activation endpoint.
- `SHRE_AUTH_VALIDATE_URL`: entitlement/key validation endpoint.
- `SHRE_COST_ENDPOINT`: token/cost reporting endpoint.
- `CONNECTOR_REGISTRY_URL`: connector routing registry.
- `LOCAL_BASE_URL`: local dashboard/connector URL shown in the manifest.

Environment Shre Auth hosts:

```text
dev:  https://shre-auth.shre.ai
qa:   https://shre-auth.shre.ai
beta: https://shre-auth.aros.live
prod: https://shre-auth.aros.live
```

## Dev/QA Setup Steps

1. Confirm the remote Shre Auth service is reachable.
2. Confirm the local store PC can reach it:

```powershell
Invoke-RestMethod https://shre-auth.shre.ai/health
```

3. Configure the local service environment:

```powershell
$env:SHRE_ENV="dev"
$env:SHRE_AUTH_SIGNUP_URL="https://shre-auth.shre.ai/api/connectors/verifone-commander/signup-activate"
$env:SHRE_AUTH_VALIDATE_URL="https://shre-auth.shre.ai/api/connectors/verifone-commander/validate"
$env:SHRE_COST_ENDPOINT="https://connector-qa.aros.live/api/usage"
```

4. Restart the local API.
5. Open `http://localhost:5480`.
6. Use Marketplace -> Shre Auth Signup & Activation.
7. Check:

```http
GET /api/readiness
GET /api/connector/status
GET /api/auth/status
```

8. Send a signed test message and confirm the response includes tenant ID, workspace ID, and store ID.

## Production Gate

Before calling an install production-ready:

1. GitHub CI passes on `master`.
2. Local installer starts the service after reboot.
3. `SHRE_AUTH_SIGNUP_URL` points to `https://shre-auth.aros.live`.
4. `SHRE_AUTH_VALIDATE_URL` points to `https://shre-auth.aros.live`.
5. `SHRE_COST_ENDPOINT` points to beta/prod cost reporting.
6. User completes Shre Auth signup/activation.
7. `/api/readiness` returns `ready: true`.
8. `/api/readiness` returns `productionReady: true` when production billing and Shre Auth URLs are configured.
9. Signed inbound message succeeds from the target gateway.
10. Usage replay succeeds through `POST /api/usage/replay`.

## Git Promotion

Current source promotion is:

```powershell
git push origin master
```

Production deployment should be handled by release assets or installer CI/CD generated from a tagged commit. Recommended release tag format:

```text
v0.2.0-beta.1
v0.2.0
```

Do not hard-code dev/QA/prod secrets into the repo. Use installer service configuration, OS secret storage, GitHub environment secrets, or the Shre Auth activation response.
