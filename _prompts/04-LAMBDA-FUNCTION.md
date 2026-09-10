# PROMPT 04: LAMBDA FUNCTION

## Purpose

- Implement or refine the PDF generation Lambda in `api/`.
- Preserve the existing API contract and deployment shape.

## Prerequisites

- Complete `02-MASTER-PLAN.md` and `03-INFRASTRUCTURE.md`.
- Read `/Users/basilsergius/projects/renderpdf/api/README.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/api/main.go`
- `/Users/basilsergius/projects/renderpdf/api/main_test.go`
- `/Users/basilsergius/projects/renderpdf/api/Dockerfile`
- `/Users/basilsergius/projects/renderpdf/api/go.mod`
- `/Users/basilsergius/projects/renderpdf/api/go.sum`

## Files/Folders Out Of Scope

- `auth/`
- frontend assets
- non-canonical infra files
- generated local binary:
  - `/Users/basilsergius/projects/renderpdf/api/renderpdf` is an ignored local
    compiled artifact, not the source of truth.

## Implementation Task

1. Preserve the current request/response contract for `/render`.
2. Prefer fixing or extending existing code in `api/main.go` over creating alternate entrypoints.
3. Keep Chrome/runtime assumptions aligned with the Docker image.
4. Do not add undocumented local-only test binaries unless the task explicitly requires them.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-api.sh
```

Optional deployed smoke test:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-deployed-api.sh
```

## Stop Conditions

- Stop if the change would break the current JSON API contract without explicit approval.
- Stop if the only way forward is to edit a generated local binary instead of source.
