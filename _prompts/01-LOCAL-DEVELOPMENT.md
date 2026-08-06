# PROMPT 01: LOCAL DEVELOPMENT SETUP

## Purpose

- Establish the minimum local context needed to work safely without deploying.
- Normalize how agents discover runnable tests and validation commands.

## Prerequisites

- Complete `00-REPO-NAVIGATION.md`.
- Read `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/api/`
- `/Users/basilsergius/projects/renderpdf/auth/`
- `/Users/basilsergius/projects/renderpdf/scripts/`
- `/Users/basilsergius/projects/renderpdf/doc-examples/`
- `/Users/basilsergius/projects/renderpdf/infra/`

## Files/Folders Out Of Scope

- Cloud deployment changes
- DNS, Cognito, or AWS console-only changes
- Frontend asset redesign work

## Implementation Task

1. Identify which local verification paths exist today.
2. Prefer the canonical verification wrappers under `scripts/verify-*.sh`.
3. Use package tests for Go services.
4. Use template validation for CloudFormation.
5. Use the deployed smoke test only when the task depends on deployed behavior.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-api.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-auth.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-shell.sh
```

Optional, AWS-backed:

```bash
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-infra.sh
cd /Users/basilsergius/projects/renderpdf && ./scripts/verify-deployed-api.sh
```

## Stop Conditions

- Stop if a requested verification flow does not exist; document the gap instead of inventing a fake test.
- Stop if a task requires deployed AWS state but only local verification is available.
