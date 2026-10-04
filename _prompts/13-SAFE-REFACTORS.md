# PROMPT 13: SAFE REFACTORS

## Purpose

- Guide structural cleanups, file reorganizations, and cross-cutting path refactors without behavioral regressions.

## Prerequisites

- Complete `_prompts/00-REPO-NAVIGATION.md`.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- Target files, scripts, docs, and prompts involved in the refactoring task.

## Files/Folders Out Of Scope

- Unsolicited behavioral or feature changes.
- Destructive infra modifications.

## Implementation Task

1. Keep refactoring slices small, isolated, and incremental.
2. Verify all path-sensitive references in `scripts/`, `infra/`, `docs/`, and `_prompts/`.
3. Preserve backwards-compatible root wrappers and symlinks where required.

## Verification Steps

```bash
./scripts/verify-all.sh
git grep -n -E "scripts/|infra/|_prompts/|doc-examples/" README.md AGENTS.md docs _prompts scripts
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if refactoring creates orphaned paths, dead links, or dual sources of truth.
