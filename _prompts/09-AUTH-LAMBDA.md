# PROMPT 09: AUTH LAMBDA

## Purpose

- Maintain the Go Lambda code in `auth/` for API-key validation and key management.
- Keep it aligned with the deployed auth infrastructure and dashboard expectations.

## Prerequisites

- Complete `08-AUTH-INFRASTRUCTURE.md`.
- Read `/Users/basilsergius/projects/renderpdf/auth/README.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/auth/authorizer.go`
- `/Users/basilsergius/projects/renderpdf/auth/api-keys.go`
- `/Users/basilsergius/projects/renderpdf/auth/utils.go`
- `/Users/basilsergius/projects/renderpdf/auth/utils_test.go`
- `/Users/basilsergius/projects/renderpdf/auth/Dockerfile.authorizer`
- `/Users/basilsergius/projects/renderpdf/auth/Dockerfile.apikeys`

## Files/Folders Out Of Scope

- Nonexistent planned files such as `oauth-callback.go`
- frontend token parsing logic
- generated local binaries under `auth/`

## Implementation Task

1. Extend or fix the existing `authorizer.go` and `api-keys.go` flows.
2. Preserve current build-tag-based separation between authorizer and API-key handlers.
3. Keep DynamoDB schema assumptions aligned with `infra/cloudformation.yaml`.
4. Do not create new auth entrypoints unless the task truly requires a new responsibility.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-auth.sh
```

## Stop Conditions

- Stop if the task depends on an auth file that is not actually in the repo; document the gap instead of inventing it.
- Stop if the requested change requires a new auth flow that conflicts with the current dashboard/OAuth model.
