# PROMPT 03: INFRASTRUCTURE

## Purpose

- Maintain the canonical CloudFormation stack definition for this service.
- Keep infra updates explicit, reviewable, and safe for reruns.

## Prerequisites

- Complete `00-REPO-NAVIGATION.md` and `02-MASTER-PLAN.md`.
- Read `/Users/basilsergius/projects/renderpdf/infra/README.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
- `/Users/basilsergius/projects/renderpdf/infra/parameters.json.example`
- Compatibility paths only if necessary:
  - `/Users/basilsergius/projects/renderpdf/cloudformation.yaml`
  - `/Users/basilsergius/projects/renderpdf/parameters.json.example`

## Files/Folders Out Of Scope

- Lambda implementation in `api/` or `auth/`
- Static frontend assets
- AWS console-only instructions unless explicitly requested as documentation

## Implementation Task

1. Edit the canonical template in `infra/cloudformation.yaml`.
2. Preserve current resource intent unless the task explicitly changes it:
   - PDF storage
   - usage/API-key tables
   - Lambda functions
   - API Gateway
   - CloudFront/S3 hosting
   - Cognito
3. Prefer updating existing resources over adding parallel ones.
4. Keep outputs aligned with the scripts that query stack outputs.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
aws cloudformation describe-stacks --stack-name renderpdf
```

## Stop Conditions

- Stop if the change would require recreating data-bearing resources without explicit approval.
- Stop if the requested change cannot be represented safely in the current CloudFormation structure.
