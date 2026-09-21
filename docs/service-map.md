# service-map.md

## Services

### PDF API

- Purpose:
  - Normalize and render HTML, Markdown, templates, public URLs, uploaded ZIP
    packages, or saved sources into a private PDF and return a signed URL.
- Source:
  - `api/main.go`
- Build/runtime entrypoints:
  - `api/Dockerfile`
  - `scripts/deploy.sh`
- Tests:
  - `scripts/verify-api.sh`
  - `scripts/verify-deployed-api.sh`
- Package API:
  - `POST /api/v1/files/upload` returns a short-lived presigned ZIP upload URL.
  - `POST /api/v1/render` with an `upload` source renders an uploaded ZIP's
    `index.html` or requested entrypoint.
  - Sources: `/api/v1/sources`; files: `/api/v1/files`; batches:
    `/api/v1/batches`.

### Batch Processing

- Source: `api/batch_api.go`, `api/batch_worker.go`
- Runtime: DynamoDB Stream outbox dispatcher → SQS batch queue → Go worker;
  batch DLQ → Go reconciler.
- At-least-once delivery is safe because conditional item claims prevent
  duplicate PDFs. Terminal jobs can emit job-level webhooks.

### Auth Services

- Purpose:
  - Validate Bearer API keys, return `UsageIdentifierKey` for API Gateway Usage Plan throttling, and manage user API keys with API Gateway key sync.
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
- Maintenance:
  - `scripts/sync-api-keys.sh`

### Analytics

- Purpose:
  - Save authenticated analytics events and aggregate PDF usage from the shared usage table.
- Source:
  - `analytics/index.js`
- Build/runtime entrypoints:
  - Node.js 22 managed Lambda runtime
  - `scripts/deploy.sh`
- API:
  - `GET /api/v1/analytics`
  - `POST /api/v1/analytics`

### Webhook Delivery

- Purpose:
  - Deliver asynchronous `pdf.completed` events to a customer-provided HTTPS endpoint.
- Source:
  - `webhooks/index.js`
- Runtime:
  - Node.js 22 Lambda triggered by the `WebhookQueue` SQS queue.
- Failure handling:
  - Four delivery attempts, then `WebhookDeadLetterQueue`.

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
- Deployment:
  - `scripts/deploy-landing.sh`
- Public paths:
  - `https://renderpdf.vberkoz.com/`
  - `https://renderpdf.vberkoz.com/robots.txt`
  - `https://renderpdf.vberkoz.com/sitemap.xml`
  - `https://renderpdf.vberkoz.com/docs/api`
  - `https://renderpdf.vberkoz.com/alternatives/docraptor-alternative`
  - `https://renderpdf.vberkoz.com/use-cases/generate-invoices-pdf-api`
  - `https://renderpdf.vberkoz.com/guides/html-to-pdf-node-js`
  - `https://renderpdf.vberkoz.com/guides/html-to-pdf-python`
  - `https://renderpdf.vberkoz.com/terms`
  - `https://renderpdf.vberkoz.com/privacy`
  - `https://renderpdf.vberkoz.com/refund`
  - `https://renderpdf.vberkoz.com/cancellation`
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
