# PROMPT 02: MASTER PLAN

## Purpose

- Establish the product and architecture constraints before making implementation changes.
- Keep later prompts aligned with the intended service boundaries.

## Prerequisites

- Complete `00-REPO-NAVIGATION.md`.
- Read `/Users/basilsergius/projects/renderpdf/docs/ARCHITECTURE.md`.

## Files/Folders In Scope

- `/Users/basilsergius/projects/renderpdf/api/`
- `/Users/basilsergius/projects/renderpdf/auth/`
- `/Users/basilsergius/projects/renderpdf/dashboard/`
- `/Users/basilsergius/projects/renderpdf/landing/`
- `/Users/basilsergius/projects/renderpdf/infra/`
- `/Users/basilsergius/projects/renderpdf/scripts/`

## Files/Folders Out Of Scope

- Unrequested product pivots
- New frameworks or large platform migrations
- Alternative deployment systems outside CloudFormation

## Implementation Task

Use these repo rules as fixed constraints unless the user explicitly asks to change them:

- Backend language: Go
- PDF generation runtime: AWS Lambda
- API layer: API Gateway
- Storage: S3
- Data store: DynamoDB
- Infrastructure: CloudFormation
- Auth: Cognito + Google OAuth + API keys
- Frontends: static HTML/CSS/JS in `dashboard/` and `landing/`

Maintain these behavior boundaries:

- `api/` owns HTML-to-PDF generation.
- `auth/` owns API-key validation and API-key CRUD.
- `dashboard/` owns authenticated UI behavior.
- `landing/` owns public demo/marketing behavior.
- `infra/` owns deploy-time infrastructure definitions.
- `scripts/` owns operational entrypoints.

## Verification Steps

```bash
cd /Users/basilsergius/projects/renderpdf && sed -n '1,220p' docs/ARCHITECTURE.md
cd /Users/basilsergius/projects/renderpdf && sed -n '1,220p' AGENTS.md
```

## Stop Conditions

- Stop if the requested change conflicts with the ownership boundaries above.
- Stop if the task would silently introduce a second deployment system or frontend stack.
