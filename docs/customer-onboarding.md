# Customer Onboarding

## Audience

Store owner, operator, or support technician installing the local connector on a store PC.

## What This Installs

The local install connects your store PC to:

- Verifone Commander POS.
- CStoreSKU/RapidRMS data.
- Local browser dashboard.
- Optional Shre/MIB cloud routing.
- Optional message gateways such as WhatsApp or ShreChat.

## Login Model (One Workspace, One User, One Password)

This pilot build provisions **one workspace and one user per installed device**. That user is the workspace admin — there is no separate "admin vs operator" distinction yet.

What's created during first-run:

| What | Filled by | Stored as |
|---|---|---|
| Workspace | `workspaceName`, `storeId`, `dba`, `corporateName`, `address`, `phone`, `timezone` | Encrypted runtime JSON |
| The user | `contactName` + `email` — captured on the first-run form | Encrypted runtime JSON (same profile blob) |
| The user's password | `loginSecret` — typed on the first-run form | Scrypt hash in encrypted runtime JSON |

What's NOT created in this build:

| Concept | Status | Why |
|---|---|---|
| A second user on the same install | ❌ | Single-user model — see "post-pilot multi-user" below |
| Roles or RBAC (admin vs cashier vs read-only) | ❌ | The one user is implicitly admin |
| Per-user invites, signup links, SSO/OAuth | ❌ | Local login only |
| A Shre/AROS account provisioned for the user | ❌ | Customer brings a pre-issued `tenantId` from the Shre marketplace; the connector reads it from `aros-config.json` |

**Operator implications:**

- The `loginSecret` is the only credential needed to log into the dashboard on this device.
- Anyone the workspace owner shares the secret with will have full admin access on this device — treat it like a store-owner password.
- Rotation: log in with the current secret, then `POST /api/auth/setup` with a new one (or use the dashboard password-change UI when present). Existing sessions stay valid until their 12-hour expiry — call `/api/auth/logout` to invalidate immediately if compromise is suspected.
- See [SECURITY.md](../SECURITY.md) for the full credential rotation and incident-response procedure.

**Post-pilot multi-user** (not in this build): if a store needs separate logins for owner / manager / cashier with different permissions, that work would touch `/api/auth/*`, add a user store, and gate every endpoint by role. Flag this with the customer before deployment so they don't assume it ships in v0.1.x.

## Before You Start

Have these ready:

- Store number or store ID.
- Workspace name. Reuse the same workspace name when adding more locations under the same company.
- Corporate name.
- DBA name. Required.
- Store address.
- Store phone number.
- Store email. Required for Shre Platform capture and email verification.
- Primary contact name.
- Verifone Commander IP/URL.
- Commander username and password.
- CStoreSKU/RapidRMS application key if required.
- Shre activation token if provided by Shre Marketplace or support.
- Shre Auth email/password if cloud or message gateway routing is enabled.
- Internet access for installation and optional cloud relay.
- Local network access to Commander.

See [Installation Data Map](installation-data-map.md) for the full field list and where each value comes from.

See [Credential Acquisition](credential-acquisition.md) for where to obtain the application key, Shre/MIB tenant/store activation, and connector credentials.

## Setup Steps

1. Install the application.
2. Open the local dashboard.
3. Create the local login secret and complete first-time workspace/store setup.
4. Enter workspace name, corporate name, DBA, address, phone, email, and contact name.
5. Open `Verifone` and enter Commander URL, username, and password.
6. If the store has a CStoreSKU/RapidRMS application key, enter it in `Verifone > CStoreSKU Key`.
7. If Shre Marketplace gives an activation token, enter it in `Verifone > Shre Activation`.
8. Test Commander connection.
9. Open `Heartbeat` and confirm connection, local pull, CStoreSKU link, and write-back state.
10. Use `Settings > Password Workflow` for Commander password updates or expiration maintenance.
11. Use Shre Auth signup/activation if cloud/message gateway routing is required.
12. Confirm queue, password status, and health checks are green.
13. Send a test message through the chosen gateway.
14. Ask a test sales question and confirm the response uses local data.
15. Review activity log and diagnostics.

Minimum local-only setup requires only local login, store profile, and Commander connection details. Cloud/message gateway setup additionally uses Shre Auth to create or find the tenant/workspace/store and activate the connector. Manual tenant/workspace/store/signing-secret entry should only be used by support.

Production installs should configure `SHRE_SETUP_CAPTURE_URL` so first-run workspace/store data is captured by Shre Platform. Set `SHRE_EMAIL_VERIFICATION_REQUIRED=true` when email verification must be completed before dashboard access. In local/dev mode without a capture URL, the app simulates verification so testing is not blocked.

## Normal Daily Operation

The application runs locally in the background.

- Sync activity is queued locally.
- Commander actions are serialized with a local lease.
- Heartbeat retries use backoff so the service does not overload Commander when disconnected.
- Saving Verifone connection details schedules local read pulls.
- Linking CStoreSKU enables cloud/local push-pull state tracking.
- Commander write-back remains blocked unless access mode is `read_write` or `write_only`.
- Password expiration status is tracked.
- Activity and chat audit are stored locally.
- Sales snapshots used by chat answers are stored locally.
- Cloud routing is optional and does not replace local storage.

## What Support May Ask For

Support may ask you to:

- Open the local dashboard.
- Download/create a diagnostics bundle.
- Confirm Commander IP and network access.
- Confirm password status.
- Confirm connector activation status.
- Restart the local services.

Never send passwords in chat, screenshots, logs, or support tickets.
