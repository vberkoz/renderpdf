# PROMPT 10: DASHBOARD

## Purpose

- Maintain the authenticated client dashboard in `dashboard/` for API key management and usage tracking.

## Prerequisites

- Read `dashboard/README.md` if reviewing dashboard routing flow.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `dashboard/login.html`
- `dashboard/callback.html`
- `dashboard/index.html`
- `dashboard/app.js`

## Files/Folders Out Of Scope

- Public landing page in `landing/`.
- Backend Lambda code in Go.

## Implementation Task

1. Maintain Cognito authentication redirects, token storage, and key CRUD interfaces.
2. Keep client logic dependency-light without introducing bundling frameworks.
3. Keep DOM elements and static markup aligned with UI tests.

## Verification Steps

```bash
./scripts/verify-ui.sh
node --test dashboard/*.test.js
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if changes introduce server-side rendering or non-static requirements to the dashboard host.
