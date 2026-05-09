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
- Verifone Commander IP/URL.
- Commander username and password.
- CStoreSKU/RapidRMS application key if required.
- Shre/MIB tenant ID and activation token if cloud or message gateway routing is enabled.
- Internet access for installation and optional cloud relay.
- Local network access to Commander.

See [Installation Data Map](installation-data-map.md) for the full field list and where each value comes from.

## Setup Steps

1. Install the application.
2. Open the local dashboard.
3. Enter company and store profile.
4. Enter Commander connection details.
5. Test Commander connection.
6. Activate connector if cloud/message gateway routing is required.
7. Confirm queue, password status, and health checks are green.
8. Send a test message through the chosen gateway.
9. Ask a test sales question and confirm the response uses local data.
10. Review activity log and diagnostics.

Minimum local-only setup requires only local login, store profile, and Commander connection details. Cloud/message gateway setup additionally requires Shre/MIB tenant/store activation and connector signing credentials.

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
