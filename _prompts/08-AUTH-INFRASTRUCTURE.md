# PROMPT 08: AUTH INFRASTRUCTURE

## Purpose

- Maintain Cognito user pool, API-key DynamoDB tables, and authorizer infra configurations.

## Prerequisites

- Read `auth/README.md` if reviewing auth architecture requirements.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `infra/cloudformation.yaml`
- `infra/parameters.json.example`

## Files/Folders Out Of Scope

- Go Lambda code under `auth/`.
- Frontend dashboard assets.
- Production secrets in `parameters.json`.

## Implementation Task

1. Keep Cognito User Pool, Client, and Authorizer definitions in `infra/cloudformation.yaml`.
2. Maintain DynamoDB schema definitions for API keys and quotas.
3. Ensure stack outputs remain stable for frontend and authorizer consumers.

## Verification Steps

```bash
./scripts/verify-infra.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if changes modify OAuth callback URLs without updating both CloudFormation and dashboard configurations.
