# edit-surfaces.md

## Ownership Boundaries

- `api/`
  - PDF generation only.
- `auth/`
  - API key validation and key CRUD only.
- `dashboard/`
  - Authenticated frontend only.
- `landing/`
  - Public frontend only.
- `infra/`
  - CloudFormation and deploy-time config only.
- `scripts/`
  - Deploy and verification entrypoints only.
- `_prompts/`
  - Agent workflow instructions only.

## Common Change Recipes

### Add API Endpoint

- Check:
  - `api/main.go`
  - `infra/cloudformation.yaml`
  - `scripts/deploy.sh`
- Verify:
  - `./scripts/verify-api.sh`
  - `./scripts/verify-infra.sh`
  - optional: `./scripts/verify-deployed-api.sh`

### Update Auth Flow

- Check:
  - `auth/authorizer.go`
  - `auth/api-keys.go`
  - `infra/cloudformation.yaml`
  - `dashboard/login.html`
  - `dashboard/callback.html`
  - `dashboard/app.js`
- Verify:
  - `./scripts/verify-auth.sh`
  - `./scripts/verify-infra.sh`
  - manual dashboard/auth flow from `docs/VERIFICATION.md`

### Edit Dashboard Page

- Check:
  - `dashboard/index.html`
  - `dashboard/login.html`
  - `dashboard/callback.html`
  - `dashboard/app.js`
- Verify:
  - manual dashboard checks from `docs/VERIFICATION.md`

### Change Landing Content

- Check:
  - `landing/index.html`
- Verify:
  - manual landing checks from `docs/VERIFICATION.md`


## Use Existing Files Instead Of Creating New Ones

- Deploy behavior:
  - update `scripts/deploy.sh` or `scripts/deploy-landing.sh`
- Verification behavior:
  - update `scripts/verify-*.sh` or `docs/VERIFICATION.md`
- Infra behavior:
  - update `infra/cloudformation.yaml`
- Agent workflow:
  - update `_prompts/` and `docs/AGENT-RULES.md`
