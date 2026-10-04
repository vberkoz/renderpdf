# PROMPT 11: AUTH DEPLOYMENT

## Purpose

- Coordinate deployment changes across auth infrastructure, auth Lambdas, and dashboard assets.

## Prerequisites

- Read `docs/VERIFICATION.md` if reviewing deployment validation requirements.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `scripts/deploy.sh`
- `infra/cloudformation.yaml`
- `dashboard/`
- `auth/`

## Files/Folders Out Of Scope

- PDF generation engine in `api/`.
- Landing page in `landing/`.
- Untracked production secrets.

## Implementation Task

1. Coordinate cross-cutting updates between Cognito/DynamoDB infra, Go auth binaries, and dashboard scripts.
2. Maintain orchestration within `scripts/deploy.sh` rather than separate ad-hoc scripts.
3. Validate local syntax and build steps prior to cloud deployment.

## Verification Steps

```bash
./scripts/verify-shell.sh
./scripts/verify-auth.sh
./scripts/verify-infra.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if the change introduces out-of-band deployment steps that bypass `scripts/deploy.sh`.
