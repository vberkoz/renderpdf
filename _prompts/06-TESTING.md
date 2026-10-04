# PROMPT 06: TESTING

## Purpose

- Maintain and run test automation and verification wrappers across the repository.

## Prerequisites

- Read `docs/VERIFICATION.md` if reviewing verification matrix details.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `scripts/verify-*.sh`
- `scripts/test-api.sh`
- `docs/VERIFICATION.md`

## Files/Folders Out Of Scope

- Application source code edits outside of test additions.
- Mock scripts or speculative test frameworks.

## Implementation Task

1. Maintain existing verification wrappers in `scripts/`.
2. Keep `docs/VERIFICATION.md` updated with exact command-line steps.
3. If an automated test does not exist for an area, document the gap instead of inventing artificial passes.

## Verification Steps

```bash
./scripts/verify-all.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if test commands attempt live external API calls during offline test runs.
