# analytics/

## Purpose

- Save authenticated analytics events.
- Read aggregated PDF usage and analytics events for the private stats view.
- Serve the signed-in customer dashboard, including monthly quota, request logs,
  and Paddle billing actions.

## Entrypoint

- `/Users/basilsergius/projects/renderpdf/analytics/index.js`
- `/Users/basilsergius/projects/renderpdf/analytics/package.json`

## API

- `GET /api/v1/analytics?days=7`
  - Requires the Cognito authorizer.
  - Returns aggregate request counts, output bytes, event counts, active days, and daily totals.
- `POST /api/v1/analytics`
  - Requires the Cognito authorizer.
  - Accepts `{ "event", "path", "source", "status", "durationMs" }`.
- `GET /api/v1/public-stats`
  - Unauthenticated public endpoint.
  - Returns cached aggregated service telemetry: success rate, p95/average latency, 30-day daily volume, and top countries.
- `GET /api/v1/dashboard`
  - Requires the Cognito authorizer.
  - Returns only the current user's PDF counts, failures, remaining monthly
    quota, billing status, and 25 most recent render attempts.
- `POST /api/v1/billing/checkout`
  - Requires the Cognito authorizer.
  - Creates a Paddle subscription checkout, or a one-time 1,000-PDF overage
    checkout at any time to add capacity to the current monthly allowance.
- `POST /api/v1/billing/portal`
  - Requires the Cognito authorizer.
  - Creates a fresh, authenticated Paddle customer-portal session.
- `POST /api/v1/billing/change-plan`
  - Requires the Cognito authorizer.
  - Changes an active or trialing subscription to one of the configured plan
    prices with immediate proration. It rejects subscriptions with a scheduled
    change to avoid conflicting customer actions.
- `POST /api/v1/billing/webhook`
  - Public Paddle webhook receiver. It validates `Paddle-Signature` with
    `PADDLE_WEBHOOK_SECRET` before storing subscription state or crediting a
    completed overage transaction. Overage credits are idempotent by Paddle
    transaction ID, so retries cannot grant the same 1,000 PDFs twice.

## Single-table records

Analytics shares `renderpdf-usage` with PDF usage records:

- Primary key: `requestId` + `timestamp`
- GSI: `AnalyticsDateIndex` on `GSI1PK` + `GSI1SK`
- Analytics partition: `ANALYTICS#YYYY-MM-DD`
- PDF usage partition: `USAGE#YYYY-MM-DD`
- Analytics records expire after 90 days through DynamoDB TTL.
- Billing state uses `BILLING#<Cognito user ID>` with timestamp `0`.
- Monthly successful-PDF counters use `USER_QUOTA#<Cognito user ID>#YYYY-MM`
  with timestamp `0` and expire after two months.
- Completed overage purchases use `OVERAGE#<Paddle transaction ID>` records
  and add 1,000 renders to the purchase month's quota.

## Billing Configuration

Set these CloudFormation parameters before enabling checkout:

- `PaddleApiKey`
- `PaddleClientToken` and `PaddleEnvironment` (`sandbox` while testing)
- `PaddleStarterPriceId`, `PaddleStarterAnnualPriceId`, `PaddleProPriceId`, `PaddleProAnnualPriceId`, and `PaddleOveragePriceId`
- `PaddleCheckoutUrl` (an approved RenderPDF URL; defaults to the dashboard)
- `PaddleWebhookSecret`
- quota limits: `FreeMonthlyQuota`, `StarterMonthlyQuota`, and
  `ProMonthlyQuota`; plus `OverageRenderCredits` (default `1000`)

In Paddle, create a notification destination at
`https://renderpdf.vberkoz.com/api/v1/billing/webhook` and use its endpoint
secret as `PaddleWebhookSecret`. Subscribe at least to `subscription.created`,
`subscription.updated`, `subscription.activated`, `subscription.trialing`, and
`subscription.canceled`, `subscription.past_due`, `subscription.paused`,
`subscription.resumed`, and `transaction.completed`.

The server API key also needs Paddle **Subscription write** permission for
self-service upgrades and downgrades, in addition to the transaction and
customer-portal permissions used by checkout and portal sessions.

## Runtime

- Node.js 22 Lambda managed runtime.
- AWS SDK for JavaScript v3 supplied by the Lambda runtime.
- Deployment packages `index.js` and `package.json` as a ZIP artifact; this
  function is not deployed as a container image.
