# PROMPT NN: MODULE NAME

## Purpose

- Describe the exact outcome this module is responsible for.
- Keep the scope narrow enough for safe reruns.

## Prerequisites

- List the prompts or docs that must be read first.
- Include any required verification or environment assumptions.

## Files/Folders In Scope

- List canonical files or directories that this prompt is allowed to change.

## Files/Folders Out Of Scope

- List adjacent areas that should not be changed from this prompt.
- Explicitly call out generated artifacts, wrappers, secrets, or compatibility paths if needed.

## Implementation Task

1. Detect current state first.
2. Prefer extending existing canonical files over creating parallel ones.
3. Keep the work idempotent:
   - safe to rerun
   - safe to stop and resume
   - safe to compare against existing state
4. Document missing coverage or missing files instead of inventing them.

## Verification Steps

```bash
# Add copy-pasteable commands that already exist or that this module creates.
```

## Stop Conditions

- Stop when the task crosses the declared scope.
- Stop when the requested change would create a second source of truth.
- Stop when verification is impossible with the current repo state; document the gap clearly.
