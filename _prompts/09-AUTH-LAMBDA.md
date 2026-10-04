# PROMPT 09: AUTH LAMBDA

## Purpose

- Maintain the Go Lambda services in `auth/` for API key verification and management.

## Prerequisites

- Read `auth/README.md` if reviewing auth handler architecture.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `auth/authorizer.go`
- `auth/api-keys.go`
- `auth/utils.go`
- `auth/utils_test.go`
- `auth/account-linker/index.js`
- `auth/Dockerfile.authorizer`
- `auth/Dockerfile.apikeys`

## Files/Folders Out Of Scope

- PDF generation logic in `api/`.
- Frontend dashboard scripts.
- Ignored compiled binaries (`auth/authorizer`, `auth/api-keys`).

## Implementation Task

1. Maintain token authorizer logic and API-key validation handlers.
2. Keep DynamoDB queries aligned with table schemas defined in `infra/cloudformation.yaml`.
3. Preserve build-tag separation between authorizer and API-key binaries.

## Verification Steps

```bash
./scripts/verify-auth.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if key-hashing or token verification security assumptions are compromised.
