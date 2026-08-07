# service-map.md

## Services

### PDF API

- Purpose:
  - Convert posted HTML, public URLs, or authenticated uploaded ZIP packages into PDF and return a download URL.
- Source:
  - `api/main.go`
- Build/runtime entrypoints:
  - `api/Dockerfile`
  - `scripts/deploy.sh`
- Tests:
  - `scripts/verify-api.sh`
  - `scripts/verify-deployed-api.sh`
- Package API:
  - `POST /api/v1/uploads` returns a short-lived presigned ZIP upload URL.
  - `POST /api/v1/render-upload` renders an uploaded ZIP's `index.html` or requested entrypoint.

### Auth Services

- Purpose:
  - Validate Bearer API keys and manage user API keys.
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
