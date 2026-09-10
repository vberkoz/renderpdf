# PROMPT 00: REPO NAVIGATION

## Purpose

- Build accurate repo context before changing code.
- Identify the canonical locations for source, infra, scripts, docs, and prompts.
- Prevent edits to generated artifacts or compatibility wrappers by mistake.

## Prerequisites

- Read:
  - `/Users/basilsergius/projects/renderpdf/README.md`
  - `/Users/basilsergius/projects/renderpdf/AGENTS.md`
  - `/Users/basilsergius/projects/renderpdf/docs/AGENT-RULES.md`
  - `/Users/basilsergius/projects/renderpdf/docs/ARCHITECTURE.md`
  - `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/api/`
- `/Users/basilsergius/projects/renderpdf/auth/`
- `/Users/basilsergius/projects/renderpdf/dashboard/`
- `/Users/basilsergius/projects/renderpdf/landing/`
- `/Users/basilsergius/projects/renderpdf/doc-examples/`
- `/Users/basilsergius/projects/renderpdf/infra/`
- `/Users/basilsergius/projects/renderpdf/scripts/`
- `/Users/basilsergius/projects/renderpdf/docs/`
- `/Users/basilsergius/projects/renderpdf/_prompts/`

## Files/Folders Out Of Scope

- Generated local binaries:
  - Local binaries (`api/renderpdf`, `auth/authorizer`, and `auth/api-keys`)
    are ignored generated artifacts, not source files.
- Environment-local secrets/config unless the task is explicitly deployment-related:
  - `/Users/basilsergius/projects/renderpdf/parameters.json`

## Implementation Task

1. Identify the target responsibility:
   - PDF generation backend
   - auth backend
   - dashboard UI
   - landing UI
   - infrastructure
   - scripts
   - docs
   - prompts
2. Confirm the canonical edit location.
3. Check whether root files are wrappers or compatibility symlinks before editing them.
4. Search for path-sensitive references in scripts, docs, and prompts.
5. Record assumptions instead of inventing missing behavior.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && find . -maxdepth 1 -mindepth 1 | sort
cd /Users/basilsergius/projects/renderpdf && rg -n "scripts/|infra/|doc-examples/|_prompts/" README.md AGENTS.md docs _prompts
```

## Stop Conditions

- Stop if the task would create a second source of truth for deploy, test, or infra behavior.
- Stop if the only candidate file is a generated local binary.
- Stop if the required ownership boundary is unclear after reading the docs; document the ambiguity first.
