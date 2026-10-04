# PROMPT NN: MODULE NAME

## Purpose

- Describe the exact outcome this module is responsible for.
- Keep the scope narrow enough for safe reruns.

## Prerequisites

- Read prerequisite module(s) or module-specific documentation only if strictly necessary.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- List canonical files or directories that this prompt is allowed to change.

## Files/Folders Out Of Scope

- List adjacent areas that should not be changed from this prompt.
- Generated binaries (`api/renderpdf`, `auth/authorizer`, `auth/api-keys`) and untracked secrets are universally out of scope.

## Implementation Task

1. Focus exclusively on the files in scope.
2. Extend existing canonical code; avoid parallel implementations or second sources of truth.
3. Keep the work idempotent and minimal to reduce context overhead.

## Verification Steps

```bash
# Add copy-pasteable canonical verification commands (e.g. ./scripts/verify-*.sh)
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Add module-specific boundary conditions here.
