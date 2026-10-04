# PROMPT 01: LOCAL DEVELOPMENT SETUP

## Purpose

- Establish minimum local validation commands to develop safely without deploying.

## Prerequisites

- Complete `_prompts/00-REPO-NAVIGATION.md`.
- Read `docs/VERIFICATION.md` only if command recipes are needed.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `scripts/verify-*.sh`

## Files/Folders Out Of Scope

- Cloud deployment scripts or AWS live infrastructure modifications.
- Service implementation code.

## Implementation Task

1. Identify local verification commands relevant to the task slice.
2. Prefer the canonical verification wrappers under `scripts/verify-*.sh`.
3. Use package unit tests for Go services and local validation scripts for infra/web.

## Verification Steps

```bash
./scripts/verify-all.sh
# Or targeted test wrappers:
./scripts/verify-api.sh
./scripts/verify-auth.sh
./scripts/verify-shell.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if a requested verification flow does not exist; document the gap instead of inventing a mock test.
