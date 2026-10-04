# PROMPT 07: LANDING PAGE

## Purpose

- Maintain the public static landing page and interactive demo in `landing/`.

## Prerequisites

- Read `landing/README.md` if reviewing page asset structure.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `landing/index.html`
- `landing/styles/`
- `landing/*.js`

## Files/Folders Out Of Scope

- `dashboard/` authenticated portal code.
- Backend Go services or infra templates.

## Implementation Task

1. Keep frontend markup static and lightweight without introducing complex build steps.
2. Maintain interactive sample PDF preview and responsive layout.
3. Validate markup structure and links across static pages.

## Verification Steps

```bash
./scripts/verify-ui.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if changes introduce authenticated application dependencies into the public landing surface.
