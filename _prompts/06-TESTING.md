# PROMPT 06: TESTING

## Purpose

- Maintain the real verification flows that exist in this repo.
- Keep test discovery consistent via `scripts/verify-*.sh` and `docs/VERIFICATION.md`.

## Prerequisites

- Complete `01-LOCAL-DEVELOPMENT.md`.
- Read `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/scripts/test-api.sh`
- `/Users/basilsergius/projects/renderpdf/scripts/verify-*.sh`
- `/Users/basilsergius/projects/renderpdf/doc-examples/`
- `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`

## Files/Folders Out Of Scope

- Fake or placeholder tests
- Uncommitted local-only checklists that should live in docs

## Implementation Task

1. Prefer thin wrappers around real verification commands.
2. Keep deployed smoke testing in `scripts/test-api.sh`.
3. Keep discovery and copy-paste instructions in `docs/VERIFICATION.md`.
4. If coverage is missing, document the gap instead of inventing a test.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-api.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-auth.sh
```

Optional, AWS-backed:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-deployed-api.sh
```

## Stop Conditions

- Stop if the task asks for automated coverage that the repo does not currently support; document it in `docs/VERIFICATION.md`.
