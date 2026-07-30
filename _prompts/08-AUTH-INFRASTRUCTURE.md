# PROMPT 08: AUTH INFRASTRUCTURE

## Purpose

- Maintain Cognito, API-key storage, and authorizer-related infrastructure in the canonical CloudFormation template.

## Prerequisites

- Complete `03-INFRASTRUCTURE.md`.
- Read `/Users/basilsergius/projects/renderpdf/auth/README.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
- `/Users/basilsergius/projects/renderpdf/infra/parameters.json.example`

## Files/Folders Out Of Scope

- `auth/` Lambda implementation details
- dashboard static page code
- secret values in `parameters.json` unless explicitly requested

## Implementation Task

1. Keep auth infra changes in `infra/cloudformation.yaml`.
2. Preserve the current Cognito + Google OAuth + API-key table pattern unless the task explicitly changes it.
3. Keep stack outputs aligned with downstream scripts and docs.
4. Prefer updating the existing authorizer/API-key resource chain over creating a parallel auth system.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
```

Optional, AWS-backed:

```bash
aws cognito-idp describe-user-pool --user-pool-id <pool-id>
```

## Stop Conditions

- Stop if the task requires writing real OAuth secrets into tracked files.
- Stop if the change would replace the current auth model rather than updating it.
