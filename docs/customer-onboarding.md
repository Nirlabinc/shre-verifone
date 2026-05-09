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
- Company/tenant name.
- Workspace name if your Shre account uses multiple workspaces.
- Verifone Commander IP/URL.
- Commander username and password.
- CStoreSKU/RapidRMS application key if required.
- Shre Auth email/password if cloud or message gateway routing is enabled.
- Internet access for installation and optional cloud relay.
- Local network access to Commander.

See [Installation Data Map](installation-data-map.md) for the full field list and where each value comes from.

See [Credential Acquisition](credential-acquisition.md) for where to obtain the application key, Shre/MIB tenant/store activation, and connector credentials.

## Setup Steps

1. Install the application.
2. Open the local dashboard.
3. Create the local login secret. This only unlocks the dashboard on this store PC.
4. Enter company and store profile.
5. Open `Verifone` and enter Commander URL, username, and password.
6. If the store has a CStoreSKU/RapidRMS application key, enter it in `Verifone > CStoreSKU Key`.
7. Test Commander connection.
8. Use `Settings > Password Workflow` for Commander password updates or expiration maintenance.
9. Use Shre Auth signup/activation if cloud/message gateway routing is required.
10. Confirm queue, password status, and health checks are green.
11. Send a test message through the chosen gateway.
12. Ask a test sales question and confirm the response uses local data.
13. Review activity log and diagnostics.

Minimum local-only setup requires only local login, store profile, and Commander connection details. Cloud/message gateway setup additionally uses Shre Auth to create or find the tenant/workspace/store and activate the connector. Manual tenant/workspace/store/signing-secret entry should only be used by support.

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
