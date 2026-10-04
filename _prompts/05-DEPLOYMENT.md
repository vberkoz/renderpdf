# PROMPT 05: DEPLOYMENT

## Purpose

- Maintain and update canonical deployment scripts without fragmenting deployment behavior.

## Prerequisites

- Read `scripts/README.md` if reviewing script environment flags.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `scripts/deploy.sh`
- `scripts/deploy-landing.sh`

## Files/Folders Out Of Scope

- Application logic in Go or JavaScript.
- Creating ad-hoc parallel deploy scripts.

## Implementation Task

1. Maintain deployment logic in `scripts/`.
2. Ensure scripts compute paths relative to `BASH_SOURCE` rather than caller `pwd`.
3. Preserve compatibility symlinks or root entrypoints (`deploy.sh`, `deploy-landing.sh`).

## Verification Steps

```bash
./scripts/verify-shell.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if changes introduce unapproved destructive deployment actions.
