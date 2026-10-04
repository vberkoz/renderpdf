# GitHub Copilot Instructions - RenderPDF

See [`AGENTS.md`](../AGENTS.md) and [`docs/AGENT-RULES.md`](../docs/AGENT-RULES.md) for complete architecture, boundaries, and recipes.

## Verification
- Before submitting changes, always run:
  `./scripts/verify-all.sh`

## Write Boundaries
- Edit source files only. Never modify generated binaries (`api/renderpdf`, `auth/authorizer`, `auth/api-keys`).
- New shell automation belongs in `scripts/`, not at the repository root.
- Keep static assets plain HTML/CSS/JS without unapproved bundler migrations.
- Respect microservice responsibilities:
  - `api/`: PDF generation and batch processing (Go).
  - `auth/`: Authorizer and key management (Go), plus Cognito `account-linker/` (Node.js).
  - `analytics/`: Paddle billing webhooks, rollup analytics, admin console API (Node.js).
  - `webhooks/`: SQS customer webhook worker (Node.js).
  - `dashboard/`: Static dashboard app.
  - `landing/`: Static marketing and documentation site.
  - `infra/`: CloudFormation infrastructure (`infra/cloudformation.yaml`).

## Schemas & Types
- Refer to `docs/openapi.yaml` for OpenAPI 3.1 endpoints and schemas.
- Refer to `jsconfig.json` and `dashboard/jsconfig.json` for JavaScript type checking.
