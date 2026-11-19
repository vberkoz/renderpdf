# repo-map.md

## Top Level

- `api/`
  - PDF generation and batch processing service source.
- `auth/`
  - API key authorizer, API key management Lambda, and Cognito `account-linker/` trigger.
- `analytics/`
  - Node.js analytics event ingestion, public stats rollups, and Paddle billing webhooks.
- `webhooks/`
  - SQS customer webhook worker Lambda delivering `pdf.completed` notifications.
- `dashboard/`
  - Authenticated static frontend.
- `landing/`
  - Public static frontend.
- `doc-examples/`
  - HTML samples used by smoke tests and manual checks.
- `infra/`
  - Canonical CloudFormation and deploy-time config examples.
- `scripts/`
  - Canonical deploy and verification scripts.
- `docs/`
  - Repo navigation, architecture, verification, openapi.yaml specification, and agent rules.
- `_prompts/`
  - Productized AI workflow modules.

## Root Compatibility Paths

- `deploy.sh`
  - Wrapper for `scripts/deploy.sh`
- `deploy-landing.sh`
  - Wrapper for `scripts/deploy-landing.sh`
- `test-api.sh`
  - Wrapper for `scripts/test-api.sh`
- `cloudformation.yaml`
  - Symlink to `infra/cloudformation.yaml`
- `parameters.json.example`
  - Symlink to `infra/parameters.json.example`
- `.env.test.example`
  - Mock environment variables for local/offline testing

## Read First

- `README.md`
- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/VERIFICATION.md`
- `docs/AGENT-RULES.md`
- `docs/testing-and-mocking.md`
  - Local verification, in-process mocking, and macOS sandbox guidance.
- `docs/operations.md`
  - Budget-alert and external-uptime operating runbook.
