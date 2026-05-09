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
9. Use `Settings > Password Workflow` for Commander password updates or expiration maintenance.
10. Use Shre Auth signup/activation if cloud/message gateway routing is required.
11. Confirm queue, password status, and health checks are green.
12. Send a test message through the chosen gateway.
13. Ask a test sales question and confirm the response uses local data.
14. Review activity log and diagnostics.

Minimum local-only setup requires only local login, store profile, and Commander connection details. Cloud/message gateway setup additionally uses Shre Auth to create or find the tenant/workspace/store and activate the connector. Manual tenant/workspace/store/signing-secret entry should only be used by support.

Production installs should configure `SHRE_SETUP_CAPTURE_URL` so first-run workspace/store data is captured by Shre Platform. Set `SHRE_EMAIL_VERIFICATION_REQUIRED=true` when email verification must be completed before dashboard access. In local/dev mode without a capture URL, the app simulates verification so testing is not blocked.

## Normal Daily Operation

The application runs locally in the background.

- Sync activity is queued locally.
- Commander actions are serialized with a local lease.
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
