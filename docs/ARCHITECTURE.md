# ARCHITECTURE.md

## System Map

- `landing/`
  - Static public page.
  - Deployed to S3 + CloudFront by `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh` or `/Users/basilsergius/projects/renderpdf/scripts/deploy-landing.sh`.
- `dashboard/`
  - Static authenticated UI.
  - Uses Cognito hosted UI redirect flow and calls the deployed API.
- `api/`
  - Go Lambda that converts posted HTML into PDF.
  - Stores PDFs in S3 and writes usage records to DynamoDB.
- `auth/`
  - Go Lambda authorizer for `x-api-key`.
  - Go Lambda for authenticated API-key management.
- `analytics/`
  - Node.js Lambda for authenticated analytics event writes and aggregate reads.
  - Reads the shared usage table through `AnalyticsDateIndex`.
- `infra/cloudformation.yaml`
  - Defines buckets, CloudFront, API Gateway, Lambda functions, DynamoDB tables, Cognito resources, and DNS/cert wiring.

## Request Flows

### Public Demo Flow

- Browser loads `/Users/basilsergius/projects/renderpdf/landing/index.html` through `https://renderpdf.vberkoz.com/`.
- Page posts HTML to `https://renderpdf.vberkoz.com/api/v1/generate`.
- `api/main.go` renders PDF and uploads to S3.
- API returns a download URL and file metadata.

### Dashboard Auth Flow

- Browser loads `/Users/basilsergius/projects/renderpdf/dashboard/login.html` through `https://renderpdf.vberkoz.com/app/`.
- Login redirects to the Cognito hosted UI.
- Cognito redirects back to `/Users/basilsergius/projects/renderpdf/dashboard/callback.html`.
- Callback stores tokens in `localStorage`.
- `/Users/basilsergius/projects/renderpdf/dashboard/app.js` calls `/api/v1/api-keys` endpoints with bearer auth.

### API Key Flow

- Dashboard creates a key through the API-key Lambda.
- Client uses the returned key against `/api/v1/generate`.
- Authorizer Lambda validates `x-api-key` against DynamoDB.
- Main API Lambda processes the request only if authorization passes.

### Analytics Flow

- Successful PDF requests write `PDF_REQUEST` records to the shared usage table.
- The analytics Lambda writes `ANALYTICS` events to the same table with a 90-day TTL.
- The `/app/stats` page redirects through Cognito sign-in and reads aggregate data through `GET /api/v1/analytics`; the analytics Lambda permits only the configured stats email address.

## Source Of Truth

- Infra:
  - `/Users/basilsergius/projects/renderpdf/infra/cloudformation.yaml`
- Deploy logic:
  - `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`
  - `/Users/basilsergius/projects/renderpdf/scripts/deploy-landing.sh`
- API runtime:
  - `/Users/basilsergius/projects/renderpdf/api/main.go`
- Auth runtime:
  - `/Users/basilsergius/projects/renderpdf/auth/authorizer.go`
  - `/Users/basilsergius/projects/renderpdf/auth/api-keys.go`
- Static UI:
  - `/Users/basilsergius/projects/renderpdf/dashboard/*.html`
  - `/Users/basilsergius/projects/renderpdf/dashboard/app.js`
  - `/Users/basilsergius/projects/renderpdf/landing/index.html`

## Coupling To Watch

- `scripts/deploy.sh` assumes current folder names and root-relative paths.
- `scripts/test-api.sh` depends on CloudFormation outputs and `doc-examples/`.
- `dashboard/` hard-codes Cognito and API URLs.
- `landing/` hard-codes the deployed API URL.
- Dockerfiles in `api/` and `auth/` encode the build entrypoints.

## Assumptions

- Assumption: the checked-in binaries under `api/` and `auth/` are not used by deployment, because Dockerfiles compile fresh `bootstrap` binaries.
