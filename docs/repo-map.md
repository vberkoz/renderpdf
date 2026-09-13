# repo-map.md

## Top Level

- `api/`
  - PDF generation service source.
- `auth/`
  - API key authorizer and API key management service source.
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
  - Repo navigation, architecture, verification, and agent rules.
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

## Read First

- `README.md`
- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/VERIFICATION.md`
- `docs/AGENT-RULES.md`
- `docs/operations.md`
  - Budget-alert and external-uptime operating runbook.
