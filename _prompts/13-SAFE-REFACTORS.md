# PROMPT 13: SAFE REFACTORS

## Purpose

- Support structural cleanup, naming cleanup, and internal refactors without changing product behavior.
- Keep refactors within the repo’s documented ownership boundaries.

## Prerequisites

- Complete `00-REPO-NAVIGATION.md` and `01-LOCAL-DEVELOPMENT.md`.
- Read `/Users/basilsergius/projects/renderpdf/docs/AGENT-RULES.md`.

## Files/Folders In Scope

- Any source, script, doc, or prompt path explicitly involved in the refactor

## Files/Folders Out Of Scope

- Unrequested product changes
- Data-destructive infrastructure rewrites
- Replacing compatibility wrappers unless all callers are updated

## Implementation Task

1. Make the smallest structural change that improves clarity.
2. Prefer incremental moves over broad reorganization.
3. Update all path-sensitive references in:
   - `scripts/`
   - `docs/`
   - `_prompts/`
4. Preserve current behavior, deployability, and root compatibility entrypoints unless the task explicitly changes them.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
cd /Users/basilsergius/projects/renderpdf && rg -n "scripts/|infra/|_prompts/|doc-examples/" README.md AGENTS.md docs _prompts scripts
```

Then run the smallest affected area check:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-api.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-auth.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
```

## Stop Conditions

- Stop if the refactor would leave duplicate deploy/test paths.
- Stop if the refactor would strand undocumented compatibility wrappers or symlinks.
