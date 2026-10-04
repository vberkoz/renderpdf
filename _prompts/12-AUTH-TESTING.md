# PROMPT 12: AUTH TESTING

## Purpose

- Verify authentication flows, authorizer logic, and API key workflows against documented test coverage.

## Prerequisites

- Read `docs/VERIFICATION.md` if reviewing auth test coverage.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `scripts/verify-auth.sh`
- `auth/utils_test.go`
- `docs/VERIFICATION.md`

## Files/Folders Out Of Scope

- Modifying auth production logic unless fixing failing tests.
- Inventing uncommitted mock scripts.

## Implementation Task

1. Run canonical auth verification suites.
2. Verify authorizer and API key token hashing via Go unit tests.
3. Document any newly identified testing gaps in `docs/VERIFICATION.md`.

## Verification Steps

```bash
./scripts/verify-auth.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if testing requires live AWS credentials during an offline verification run.
