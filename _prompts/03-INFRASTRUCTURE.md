# PROMPT 03: INFRASTRUCTURE

## Purpose

- Maintain the canonical CloudFormation stack definition in `infra/cloudformation.yaml`.

## Prerequisites

- Read `infra/README.md` if resource conventions or parameters require review.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- `infra/cloudformation.yaml`
- `infra/parameters.json.example`

## Files/Folders Out Of Scope

- Go Lambda application code in `api/` or `auth/`.
- Static frontend code in `dashboard/` or `landing/`.
- Local parameter files (`parameters.json`).

## Implementation Task

1. Edit the canonical CloudFormation template in `infra/cloudformation.yaml`.
2. Keep stack outputs synchronized with deploy scripts and runtime config.
3. Update `infra/parameters.json.example` when introducing new parameters.

## Verification Steps

```bash
./scripts/verify-infra.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if changes would delete or recreate data-bearing DynamoDB tables or S3 buckets without explicit confirmation.
