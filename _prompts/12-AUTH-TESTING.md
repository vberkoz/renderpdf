# PROMPT 12: AUTH TESTING

## Purpose

- Guide auth-related verification without overstating current automation.
- Keep auth testing aligned with the real coverage documented in `docs/VERIFICATION.md`.

## Prerequisites

- Complete `09-AUTH-LAMBDA.md`, `10-DASHBOARD.md`, and `11-AUTH-DEPLOYMENT.md`.
- Read `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-auth.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-deployed-api.sh`
- `/Users/basilsergius/projects/renderpdf/dashboard/`

## Files/Folders Out Of Scope

- Invented `test-auth.sh` or `test-dashboard.sh` scripts unless the task explicitly asks to author them
- Claims of automated auth coverage that do not exist

## Implementation Task

1. Run the real automated auth-related checks that exist today.
2. Use manual checklists for dashboard/OAuth flow where automation is missing.
3. If new auth coverage is requested, add it under `scripts/` and document it in `docs/VERIFICATION.md`.

## Verification Steps

Automated:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-auth.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-deployed-api.sh
```

Manual dashboard/auth checks:

- login redirect starts correctly
- callback stores tokens and redirects
- key generation works
- key revoke works
- valid API key can call the deployed API

## Stop Conditions

- Stop if the task expects committed auth E2E scripts that are not present; document the missing coverage instead.
