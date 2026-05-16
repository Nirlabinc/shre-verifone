# Security policy

## Reporting a vulnerability

If you find a vulnerability in this connector or in any pilot install, **do not file a public GitHub issue**. Email the maintainer privately and include:

- Affected version (`git describe --tags` on the install, e.g. `pilot-v0.1.1`)
- Reproduction steps
- Impact assessment if known
- Your preferred coordination timeline

Maintainer contact: `info@rapidinfosoft.com`

We aim to acknowledge within 2 business days and ship a fix or mitigation within 14 days for high-severity issues, sooner for critical (RCE, data exfiltration, credential leak).

## What lives on disk at a customer install

A standard install writes the following under `VERIFONE_SHRE_HOME` (default `~/.verifone-shre-cstoresku/` on mac/linux, `%ProgramData%\Verifone-Commander-Shre-Cstoresku\runtime\` on Windows). All files are mode `0600` (owner-only) on POSIX, and ACL-locked to `Administrators` + `SYSTEM` on Windows:

| File | Sensitivity | Rotation |
|---|---|---|
| `.install-secret` | **Critical** — AES-256 key for at-rest encryption of credentials, payloads, chat audit | Manual; rotating invalidates all encrypted data already stored |
| `.install-device-id` | Low — opaque UUID used as AROS deviceId | Stable for the install's lifetime; only re-generate on full reinstall |
| `aros-config.json` | **High** — contains `tenantId`, `storeId`, `deviceAlias`, and optionally `bootstrapKey` (required for `read_write` mode) | Edit in place, then restart the connector |
| `runtime.sqlite` | **High** — encrypted credential blobs, chat transcripts (encrypted), activity log (plaintext metadata) | Backup before any upgrade |

If `.install-secret` leaks, treat all encrypted state as compromised: revoke any Commander credentials referenced, reset the file, re-onboard the workspace via `POST /api/setup/first-run`.

If `aros-config.json` leaks, rotate `bootstrapKey` with the Shre admin (mandatory if mode is `read_write`), and consider regenerating `deviceId` since the leaked install may continue impersonating until the tenant invalidates the device.

## Authentication model

This pilot uses a **single local admin per install** — one `loginSecret` is the entire login credential. There are no per-user accounts, no roles, and no SSO. Anyone who knows the secret can act as admin on that device. See [`docs/customer-onboarding.md`](docs/customer-onboarding.md#login-model-single-local-admin) for the operator-facing explanation. Multi-user / role-based access is post-pilot work.

## Credential rotation

| Credential | How to rotate |
|---|---|
| Local admin login secret | `POST /api/auth/setup` with new `loginSecret` while authenticated (or reset with `LOCAL_ADMIN_TOKEN` env override) |
| AROS `bootstrapKey` | Edit `aros-config.json`, restart the connector service. Coordinate with Shre admin to invalidate the prior key on their side. |
| Verifone Commander password | `POST /api/verifone/config` with the new password (encrypted at rest by `.install-secret`) |
| Encryption key (`.install-secret`) | Last-resort; equivalent to a fresh install — all encrypted blobs become unreadable. Back up `runtime.sqlite` first only if you also keep the old `.install-secret`. |

## Operational hardening checklist

See [`docs/security-hardening.md`](docs/security-hardening.md) for the full operator runbook, including OS-level filesystem permissions, keychain integration recommendations, and log redaction policy.

For incident response steps, log triage, and which endpoints to hit first when something looks wrong, see [`docs/support-runbook.md`](docs/support-runbook.md).
