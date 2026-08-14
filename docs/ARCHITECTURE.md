# ARCHITECTURE.md

## System Map

- `landing/`
  - Static public page.
  - Deployed to S3 + CloudFront by `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh` or `/Users/basilsergius/projects/renderpdf/scripts/deploy-landing.sh`.
- `dashboard/`
  - Static authenticated UI.
  - Uses Cognito hosted UI redirect flow and calls the deployed API.
- `api/`
  - Go Lambda that converts posted HTML, public URLs, and uploaded ZIP packages into PDF.
  - Stores PDFs in S3 and writes usage records to DynamoDB.
  - Includes a DynamoDB-backed, owner-isolated template repository for durable
    customer templates.
  - Generated PDF objects expire after 30 days; incomplete multipart uploads expire after 7 days.
  - Uploaded packages use a separate private S3 bucket and expire after one day.
- `auth/`
  - Go Lambda authorizer for API keys sent as `Authorization: Bearer <key>`.
  - Go Lambda for authenticated API-key management.
- `analytics/`
  - Node.js Lambda for authenticated analytics event writes and aggregate reads.
  - Reads the shared usage table through `AnalyticsDateIndex`.
- `infra/cloudformation.yaml`
  - Defines buckets, CloudFront, API Gateway, Lambda functions, DynamoDB tables, Cognito resources, and DNS/cert wiring.
- `infra/ecr-lifecycle-policy.json`
  - Applied by the deployment script to retain the two newest images in each ECR repository.

## Request Flows

### Public Demo Flow

- Browser loads `/Users/basilsergius/projects/renderpdf/landing/index.html` through `https://renderpdf.vberkoz.com/`.
- Page posts HTML to `https://renderpdf.vberkoz.com/api/v1/render-html`.
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
- Client uses the returned key against `/api/v1/render-html`.
- Authorizer Lambda validates the Bearer API key against DynamoDB.
- Main API Lambda processes the request only if authorization passes.

### Uploaded Package Flow

- An authenticated client calls `POST /api/v1/uploads` and receives a 15-minute presigned PUT URL for a ZIP package.
- The browser or client uploads the ZIP directly to the private package bucket; it is never placed in the public PDF bucket.
- `POST /api/v1/render-upload` resolves the package only for the API-key owner, rejects unsafe or oversized archives, expands it under `/tmp`, and renders its local HTML entrypoint with relative assets available.
- Uploaded documents are prevented from loading network subresources and package objects expire after one day.

### Customer Webhook Flow

- An authenticated `/render`, `/render-url`, or `/render-upload` request may provide a public HTTPS `webhookUrl` and optional signing secret.
- After S3 accepts the PDF, the API Lambda sends a small `pdf.completed` event to SQS and returns the normal synchronous response.
- The webhook worker POSTs the event to the resolved public IP without following redirects. Non-2xx results are retried by SQS; after four receives they land in the dead-letter queue.

### Analytics Flow

- Successful PDF requests write `PDF_REQUEST` records to the shared usage table.
- The analytics Lambda writes `ANALYTICS` events to the same table with a 90-day TTL.
- The `/app/stats` page redirects through Cognito sign-in and reads aggregate data through `GET /api/v1/analytics`; the analytics Lambda permits only the configured stats email address.

### Customer Dashboard and Billing Flow

- `/app/` calls `GET /api/v1/dashboard` with its Cognito ID token and receives
  only that user's request counts, quota, billing state, and recent request logs.
- Template management uses Cognito-authorized `/api/v1/dashboard/templates`
  and `/api/v1/dashboard/render-template` routes. These derive the template
  owner from the token's `sub` claim; API keys remain for external clients.
- The PDF Lambda reserves one monthly quota unit atomically before an
  authenticated render; failed renders release that unit.
- `POST /api/v1/billing/checkout` creates a Paddle checkout transaction with
  the Cognito user ID as transaction custom data.
- Paddle sends signed subscription webhooks to
  `/api/v1/billing/webhook`; the analytics Lambda verifies the signature and
  stores the account's subscription status.

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
