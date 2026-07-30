# PROMPT 05: DEPLOYMENT

## Purpose

- Maintain the canonical deployment scripts without fragmenting deploy behavior.
- Keep root wrappers and canonical script paths in sync.

## Prerequisites

- Complete `03-INFRASTRUCTURE.md` and `04-LAMBDA-FUNCTION.md`.
- Read `/Users/basilsergius/projects/renderpdf/scripts/README.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/deploy-landing.sh`
- Root wrappers only if needed:
  - `/Users/basilsergius/projects/renderpdf/deploy.sh`
  - `/Users/basilsergius/projects/renderpdf/deploy-landing.sh`

## Files/Folders Out Of Scope

- New duplicate deploy scripts
- One-off operator notes that belong in docs instead

## Implementation Task

1. Modify canonical scripts in `scripts/`.
2. Keep wrapper scripts at root as thin pass-through entrypoints.
3. Preserve script behavior that resolves paths from script location instead of caller cwd.
4. Avoid creating parallel deploy flows for the same target.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
```

Optional deployed verification:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy.sh
```

## Stop Conditions

- Stop if the change would create a second deploy path for the same resource set.
- Stop if the change would require destructive AWS actions that were not explicitly requested.
