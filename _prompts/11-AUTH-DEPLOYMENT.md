# PROMPT 11: AUTH DEPLOYMENT

## Purpose

- Coordinate deployment changes that touch auth infrastructure, auth Lambdas, and dashboard hosting.
- Keep deployment behavior centralized in the canonical scripts and template.

## Prerequisites

- Complete `08-AUTH-INFRASTRUCTURE.md`, `09-AUTH-LAMBDA.md`, and `10-DASHBOARD.md`.
- Read `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`
- `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
- `/Users/basilsergius/projects/renderpdf/dashboard/`
- `/Users/basilsergius/projects/renderpdf/auth/`

## Files/Folders Out Of Scope

- Committing secret values
- Creating a second auth deployment script
- One-off environment notes that belong in docs

## Implementation Task

1. Keep auth deployment changes in the existing deploy flow.
2. Preserve the current split of responsibilities:
   - infra in `infra/`
   - auth code in `auth/`
   - dashboard assets in `dashboard/`
   - orchestration in `scripts/deploy.sh`
3. Prefer updating docs for environment-specific setup rather than hard-coding secrets or account-specific commands into generic prompts.

## Verification Steps

Local/syntax:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-auth.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
```

Optional deployed verification:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy.sh
```

## Stop Conditions

- Stop if the task requires storing real OAuth credentials in tracked files.
- Stop if the deployment change would add a parallel auth deploy path instead of updating the canonical one.
