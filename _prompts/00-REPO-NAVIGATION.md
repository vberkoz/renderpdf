# PROMPT 00: REPO NAVIGATION

## Purpose

- Build accurate repo orientation before changing code.
- Identify canonical locations for source, infra, scripts, docs, and prompts.

## Prerequisites

- Read `AGENTS.md`.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- Repo layout inspection across canonical directories: `api/`, `auth/`, `dashboard/`, `landing/`, `infra/`, `scripts/`, `docs/`, `_prompts/`.

## Files/Folders Out Of Scope

- Source code edits in functional subdirectories.
- Generated binaries (`api/renderpdf`, `auth/authorizer`, `auth/api-keys`) and local parameters (`parameters.json`).

## Implementation Task

1. Confirm canonical directories before proposing changes.
2. Check whether root scripts/templates are wrappers or compatibility symlinks before editing.
3. Keep module references pointing directly to target files without loading unnecessary documentation.

## Verification Steps

```bash
git grep -n -E "scripts/|infra/|docs/" _prompts
find . -maxdepth 1 -mindepth 1 | sort
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if the task would create duplicate entrypoints or bypass canonical directory structure.
