# HTML to PDF Service

Serverless API that converts HTML to PDF using AWS Lambda (Go), API Gateway, S3, and DynamoDB.

## Features

- Fast PDF generation using headless Chrome (chromedp)
- Versioned HTML/CSS JSON documents with escaped data bindings
- Serverless architecture with automatic scaling
- Secure PDF storage with presigned S3 URLs
- Usage tracking and analytics via DynamoDB
- RESTful API with JSON responses
- User authentication via AWS Cognito (Google OAuth and Email/Password)
- API key management dashboard
- Custom authorizer for API security

## Prerequisites

- AWS CLI configured with appropriate credentials
- Go 1.21+
- Docker
- Google OAuth credentials

## Deploy

```bash
./deploy.sh
```

Canonical script location: `/Users/basilsergius/projects/renderpdf/scripts/deploy.sh`

Supporting docs:
- `/Users/basilsergius/projects/renderpdf/AGENTS.md`
- `/Users/basilsergius/projects/renderpdf/docs/repo-map.md`
- `/Users/basilsergius/projects/renderpdf/docs/service-map.md`
- `/Users/basilsergius/projects/renderpdf/docs/edit-surfaces.md`
- `/Users/basilsergius/projects/renderpdf/docs/change-recipes.md`
- `/Users/basilsergius/projects/renderpdf/docs/VERIFICATION.md`
- `/Users/basilsergius/projects/renderpdf/docs/ARCHITECTURE.md`
- `/Users/basilsergius/projects/renderpdf/docs/CONTRIBUTING.md`
- `/Users/basilsergius/projects/renderpdf/docs/operations.md`
- `/Users/basilsergius/projects/renderpdf/docs/AGENT-RULES.md`

## Usage

### Generate PDF from HTML

Try the anonymous endpoint without an API key. It is limited to 3 successful PDFs per source IP per UTC day and accepts up to 1 MB of HTML:

```bash
curl -X POST https://renderpdf.vberkoz.com/api/v1/trial/render \
  -H "Content-Type: application/json" \
  -d '{"html":"<h1>Hello World</h1>"}'
```

Check the current IP-based trial quota without generating a PDF:

```bash
curl https://renderpdf.vberkoz.com/api/v1/trial/quota
```

For authenticated usage, create an API key in the dashboard:

```bash
curl -X POST https://renderpdf.vberkoz.com/api/v1/render \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"version":"1","source":{"type":"html","content":"<h1>Hello World</h1>"},"data":{}}'
```

### Canonical render endpoint

`POST /api/v1/render` is the canonical authenticated endpoint. Select the
input with `source.type`: `html`, `markdown`, `template`, `url`, `upload`, or
`stored`.
`/render` is the sole authenticated render endpoint and uses the same quota,
storage, analytics, and webhook flow for every source type.

```bash
curl -X POST https://renderpdf.vberkoz.com/api/v1/render \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "version": "1",
    "source": { "type": "html", "content": "<h1>{{title}}</h1>" },
    "css": "body { font-family: Arial, sans-serif; }",
    "data": { "title": "Monthly report" },
    "options": { "format": "A4", "margin": "18mm" }
  }'
```

`html` and `markdown` use the controlled document shell. `template` uses
`templateId` and `variables`; `url` uses `url`; and `upload` uses `uploadId`
with an optional `entrypoint`. Source-specific fields and unknown fields are
rejected.

### Render a structured inline document

Use the authenticated render endpoint when HTML structure, CSS, and dynamic
values should be sent separately. Every `{{path.to.value}}` binding must have a
matching `data` value, and unused values are rejected. Values are HTML-escaped.

```bash
curl -X POST https://renderpdf.vberkoz.com/api/v1/render \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "version": "1",
    "source": { "type": "html", "content": "<main><h1>{{report.title}}</h1><p>{{customer.name}}</p></main>" },
    "css": "body { font-family: Arial, sans-serif; } h1 { color: #123456; }",
    "data": {
      "report": { "title": "Monthly report" },
      "customer": { "name": "Ada & Sons" }
    },
    "options": { "format": "A4", "margin": "18mm" }
  }'
```

Supported paper formats are `A4`, `Letter`, and `Legal`; omitted options
default to `A4` and `18mm`. Margins may use `mm` (`0–50mm`) or `in` (`0–2in`).
CSS supported by headless Chrome is accepted except `@page`, `@import`,
`url()`, and unsafe legacy expressions. Page settings must come from `options`.

The contract also reserves a mutually exclusive `source` object for Markdown:
`{"source":{"type":"markdown","content":"# {{report.title}}"}}`. Its
shape and bindings are validated, then converted to an HTML fragment with raw
HTML disabled.

Limits are 1 MiB for request JSON, 768 KiB for HTML, 128 KiB for CSS, 256 KiB
for data, 10 data nesting levels, and 1 MiB for the final renderer input.
Scripts, event-handler attributes, embedded browsing/plugin elements, local
files, and local or remote assets are rejected. JavaScript is disabled for this
endpoint. Normal `http`, `https`, `mailto`, and in-document anchor links are
allowed. Optional `webhookUrl` and `webhookSecret` fields use the standard
`pdf.completed` webhook flow.

### Render a public webpage

The authenticated URL renderer navigates Chromium to a public HTTP(S) URL, preserving its original context for relative assets and client-side rendering:

```bash
curl -X POST https://renderpdf.vberkoz.com/api/v1/render \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"version":"1","source":{"type":"url","url":"https://example.com/invoice"}}'
```

Only public HTTP(S) targets on ports 80 and 443 are accepted. Pages requiring a login or blocking automated browsers may not render successfully.

### Render an uploaded HTML package

For local HTML, CSS, images, fonts, and JavaScript, upload a ZIP archive first. The archive must contain `index.html` (or a specified HTML `entrypoint`), use only relative paths, and contain at most 500 files. Packages larger than 25 MB compressed or 50 MB extracted are rejected during rendering. Upload packages are private and expire after one day.

```bash
upload=$(curl -s -X POST https://renderpdf.vberkoz.com/api/v1/files/upload \
  -H "Authorization: Bearer YOUR_API_KEY")
upload_url=$(jq -r .uploadUrl <<<"$upload")
upload_id=$(jq -r .uploadId <<<"$upload")

curl -X PUT --upload-file invoice-package.zip "$upload_url"

curl -X POST https://renderpdf.vberkoz.com/api/v1/render \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d "{\"version\":\"1\",\"source\":{\"type\":\"upload\",\"uploadId\":\"$upload_id\"}}"
```

### Render a stored template

Store reusable HTML once with placeholders such as {{customer.name}}, then
submit only variables for each PDF. Templates are private to the API-key owner
and limited to 100 per customer and 1 MiB each.

~~~bash
template=$(curl -s -X POST https://renderpdf.vberkoz.com/api/v1/templates \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"name":"Greeting","type":"custom","html":"<h1>Hello {{customer.name}}</h1>"}')
template_id=$(jq -r .id <<<"$template")
curl -X POST https://renderpdf.vberkoz.com/api/v1/render \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d "{\"version\":\"1\",\"source\":{\"type\":\"template\",\"templateId\":\"$template_id\",\"variables\":{\"customer\":{\"name\":\"Ada Lovelace\"}}}}"
~~~

See [starter template schemas](docs/starter-templates.md) for Invoice,
Contract, Certificate, and Receipt variables and migration guidance.

### Saved sources, files, and batches

Save reusable HTML/CSS JSON or Markdown with `POST /api/v1/sources`; list,
read metadata, update, or delete them with `/sources` and `/sources/{id}`.
Render a saved definition through `/render` with
`{"source":{"type":"stored","id":"src_..."}}`.

`GET /api/v1/files` lists uploaded packages, rendered PDFs, and batch ZIPs.
`GET /api/v1/files/{id}/download` issues a 15-minute private download URL;
`DELETE /api/v1/files/{id}` deletes the owned record and object.

Submit an asynchronous batch with `POST /api/v1/batches`. It accepts a saved
source plus per-item `data`, or individual normalized render definitions, with
1–99 items per job. Use `GET /batches` to list your jobs, `GET /batches/{id}`
and `/batches/{id}/items` for status, `POST /batches/{id}/cancel` for pending work, and
`GET /batches/{id}/download` for a private ZIP of completed PDFs. Batch jobs
are durably written before a DynamoDB Streams outbox dispatches their items to
SQS; at-least-once delivery is safe because worker claims prevent duplicates.

### Response

Rendered PDFs are private. The returned `url` is a signed S3 download URL that
expires after 15 minutes.

```json
{
  "requestId": "uuid",
  "url": "https://bucket.s3.amazonaws.com/files/.../uuid.pdf?X-Amz-Signature=...",
  "size": 12345
}
```

Generated PDFs are retained for 30 days before automatic deletion.

### Webhooks

Authenticated render requests may include a public HTTPS `webhookUrl`. After the PDF is stored, RenderPDF queues an asynchronous `pdf.completed` POST to that URL. The render response is not delayed by delivery or retries. For a quick test, create a unique endpoint at [Webhook.site](https://webhook.site/) and use it as the URL below.

```json
{
  "html": "<h1>Invoice</h1>",
  "webhookUrl": "https://webhook.site/YOUR-UNIQUE-ID",
  "webhookSecret": "optional-signing-secret"
}
```

When `webhookSecret` is supplied, deliveries include `X-RenderPDF-Signature` as `t=<unix-seconds>,v1=<hex-hmac-sha256>`, calculated from `<timestamp>.<raw JSON body>`. Deliveries that do not return a 2xx status are retried up to four times, then moved to the webhook dead-letter queue. Trial requests cannot use webhooks. Batches use their job-level webhook settings and emit one terminal `batch.completed` or `batch.failed` event with item counters and a stable event ID.

## Architecture

- **Lambda**: Go function with chromedp for headless Chrome PDF generation
- **API Gateway**: REST API endpoint with custom authorizer
- **S3**: Secure PDF storage with lifecycle policies
- **DynamoDB**: Request tracking, usage analytics, and API key storage
- **Cognito**: User authentication with Google OAuth and Email/Password
- **CloudFront**: CDN for landing page and dashboard

## Configuration

Environment variables:
- `S3_BUCKET`: Target S3 bucket for PDF storage
- `DYNAMODB_TABLE`: DynamoDB table for tracking
- `API_KEYS_TABLE`: DynamoDB table for API keys
- `TEMPLATE_TABLE_NAME`: DynamoDB table for durable customer templates
- `PDF_EXPIRY`: Presigned URL expiration time (default: 3600s)

## Domains

- Landing: https://renderpdf.vberkoz.com/
- Dashboard: https://renderpdf.vberkoz.com/app/
- API: https://renderpdf.vberkoz.com/api/v1/
- Docs: https://renderpdf.vberkoz.com/docs/api

## License

MIT
