# PROMPT 02: MASTER PLAN

## Purpose

- Define product and architecture boundaries before making implementation changes.

## Prerequisites

- Read `docs/ARCHITECTURE.md` only if high-level service contracts are in question.
- Inherits baseline rules and idempotency requirements from `_prompts/INDEX.md`.

## Files/Folders In Scope

- Service architecture decisions across `api/`, `auth/`, `dashboard/`, `landing/`, and `infra/`.

## Files/Folders Out Of Scope

- Framework migrations or unrequested architectural pivots.
- Third-party deployment solutions outside CloudFormation.

## Implementation Task

Maintain strict service boundaries:
- `api/`: Go PDF-rendering Lambda via headless Chrome.
- `auth/`: Go Lambda API-key management and authorizer, plus Cognito triggers.
- `dashboard/`: Static HTML/JS authenticated user dashboard.
- `landing/`: Static HTML/CSS marketing and interactive preview.
- `infra/`: CloudFormation templates in `infra/`.
- `scripts/`: Operational automation and verification entrypoints.

## Verification Steps

```bash
./scripts/verify-all.sh
```

## Stop Conditions

- Inherits universal stop conditions from `_prompts/INDEX.md`.
- Stop if the task crosses service responsibilities without explicit alignment.
