# service-map.md

## Services

### PDF API

- Purpose:
  - Convert posted HTML into PDF and return a download URL.
- Source:
  - `api/main.go`
- Build/runtime entrypoints:
  - `api/Dockerfile`
  - `scripts/deploy.sh`
- Tests:
  - `scripts/verify-api.sh`
  - `scripts/verify-deployed-api.sh`

### Auth Services

- Purpose:
  - Validate `x-api-key` and manage user API keys.
- Source:
  - `auth/authorizer.go`
  - `auth/api-keys.go`
  - `auth/utils.go`
- Build/runtime entrypoints:
  - `auth/Dockerfile.authorizer`
  - `auth/Dockerfile.apikeys`
  - `scripts/deploy.sh`
- Tests:
  - `scripts/verify-auth.sh`

### Dashboard

- Purpose:
  - Authenticated UI for login, key management, and API testing.
- Source:
  - `dashboard/login.html`
  - `dashboard/callback.html`
  - `dashboard/index.html`
  - `dashboard/app.js`
- Deployment:
  - `scripts/deploy.sh`
- Public path:
  - `https://renderpdf.vberkoz.com/app/`
- Verification:
  - Manual flow in `docs/VERIFICATION.md`

### Landing

- Purpose:
  - Public marketing/demo page for the API.
- Source:
  - `landing/index.html`
  - `landing/style.css`
- Deployment:
  - `scripts/deploy-landing.sh`
- Public paths:
  - `https://renderpdf.vberkoz.com/`
  - `https://renderpdf.vberkoz.com/docs/api`
- Verification:
  - Manual flow in `docs/VERIFICATION.md`

### Infrastructure

- Purpose:
  - Define AWS resources and deploy-time config shape.
- Source:
  - `infra/cloudformation.yaml`
  - `infra/parameters.json.example`
- Validation:
  - `scripts/verify-infra.sh`
