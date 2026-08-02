# analytics/

## Purpose

- Save authenticated analytics events.
- Read aggregated PDF usage and analytics events for the private stats view.

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

## Single-table records

Analytics shares `renderpdf-usage` with PDF usage records:

- Primary key: `requestId` + `timestamp`
- GSI: `AnalyticsDateIndex` on `GSI1PK` + `GSI1SK`
- Analytics partition: `ANALYTICS#YYYY-MM-DD`
- PDF usage partition: `USAGE#YYYY-MM-DD`
- Analytics records expire after 90 days through DynamoDB TTL.

## Runtime

- Node.js 22 Lambda managed runtime.
- AWS SDK for JavaScript v3 supplied by the Lambda runtime.
- Deployment packages `index.js` and `package.json` as a ZIP artifact; this
  function is not deployed as a container image.
