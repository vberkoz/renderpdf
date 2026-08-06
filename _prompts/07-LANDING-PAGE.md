# PROMPT 07: LANDING PAGE

## Purpose

- Maintain the static public landing/demo page in `landing/`.
- Preserve its role as both marketing surface and simple API demo.

## Prerequisites

- Complete `02-MASTER-PLAN.md` and `06-TESTING.md`.
- Read `/Users/basilsergius/projects/renderpdf/landing/README.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/landing/index.html`
- `/Users/basilsergius/projects/renderpdf/landing/style.css`

## Files/Folders Out Of Scope

- `dashboard/`
- bundler/framework setup
- auth implementation

## Implementation Task

1. Keep the page static and dependency-light.
2. Preserve the direct API demo behavior unless the task explicitly changes it.
3. Update only the landing-specific UI and interaction flow.
4. Avoid moving logic into new frontend roots or build systems.

## Verification Steps

Manual review:

```bash
cd /Users/basilsergius/projects/renderpdf && sed -n '1,220p' landing/index.html
```

If deployment-backed verification is needed:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/deploy-landing.sh
```

## Stop Conditions

- Stop if the requested change would turn `landing/` into a second authenticated app.
- Stop if the task requires automated landing tests that do not exist; document the gap instead.
