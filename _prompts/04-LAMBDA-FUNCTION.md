# PROMPT 04: LAMBDA FUNCTION

## Purpose

- Implement, optimize, or debug the PDF generation Lambda in `api/`.

## Prerequisites

- Read `api/README.md` if reviewing container runtime details.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `api/main.go`
- `api/main_test.go`
- `api/Dockerfile`
- `api/go.mod`
- `api/go.sum`

## Files/Folders Out Of Scope

- Auth Lambda code in `auth/`.
- Frontend code or CloudFormation templates.
- Ignored compiled binaries (`api/renderpdf`).

## Implementation Task

1. Maintain the JSON request/response contract for `/render`.
2. Keep Chrome flags and Alpine/Chromium dependencies synchronized with `api/Dockerfile`.
3. Write or update unit tests in `api/main_test.go`.

## Verification Steps

```bash
./scripts/verify-api.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if modifications break backwards compatibility of `/render` payload format without approval.
