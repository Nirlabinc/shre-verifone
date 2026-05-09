# Password Expiration Workflow

## Goal

Prevent Verifone Commander password expiration from silently breaking sync.

## Flow

```text
validate Commander credentials
→ read password days remaining when available
→ save password status locally
→ show status on dashboard
→ auto-reset before threshold
→ if reset succeeds, save encrypted config and log event
→ if reset fails, prompt user
→ if expired, block sync and require new password
```

## States

- `unknown`
- `valid`
- `expiring`
- `auto_reset_pending`
- `auto_reset_succeeded`
- `auto_reset_failed`
- `expired`
- `manual_update_required`

## Dashboard Behavior

- Green: valid.
- Yellow: expiring soon.
- Red: expired or manual update required.
- Action button: open Verifone credential form.
- Action button: test credentials.
- Action button: save and restart sync.

## Events

Send approved Shre events:

- `password_status_checked`
- `password_expiring`
- `password_auto_reset_succeeded`
- `password_auto_reset_failed`
- `password_manual_update_required`

Never include the password in logs, events, diagnostics, or training records.
