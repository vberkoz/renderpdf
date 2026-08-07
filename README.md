# HTML to PDF Service

Serverless API that converts HTML to PDF using AWS Lambda (Go), API Gateway, S3, and DynamoDB.

## Features

- Fast PDF generation using headless Chrome (chromedp)
- Serverless architecture with automatic scaling
- Secure PDF storage with presigned S3 URLs
- Usage tracking and analytics via DynamoDB
- RESTful API with JSON responses
- Google OAuth authentication via AWS Cognito
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
  -d '{"html":"<h1>Hello World</h1>"}'
```

### Render a public webpage

The authenticated URL renderer navigates Chromium to a public HTTP(S) URL, preserving its original context for relative assets and client-side rendering:

```bash
curl -X POST https://renderpdf.vberkoz.com/api/v1/render-url \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"url":"https://example.com/invoice"}'
```

Only public HTTP(S) targets on ports 80 and 443 are accepted. Pages requiring a login or blocking automated browsers may not render successfully.

### Render an uploaded HTML package

For local HTML, CSS, images, fonts, and JavaScript, upload a ZIP archive first. The archive must contain `index.html` (or a specified HTML `entrypoint`), use only relative paths, and contain at most 500 files. Packages larger than 25 MB compressed or 50 MB extracted are rejected during rendering. Upload packages are private and expire after one day.

```bash
upload=$(curl -s -X POST https://renderpdf.vberkoz.com/api/v1/uploads \
  -H "Authorization: Bearer YOUR_API_KEY")
upload_url=$(jq -r .uploadUrl <<<"$upload")
upload_id=$(jq -r .uploadId <<<"$upload")

curl -X PUT --upload-file invoice-package.zip "$upload_url"

curl -X POST https://renderpdf.vberkoz.com/api/v1/render-upload \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d "{\"uploadId\":\"$upload_id\"}"
```

### Response

```json
{
  "requestId": "uuid",
  "url": "https://bucket.s3.amazonaws.com/uuid.pdf",
  "size": 12345
}
```

The presigned URL is valid for 1 hour and allows direct download of the generated PDF. Generated PDFs are retained for 30 days before automatic deletion.

### Webhooks

Authenticated render requests may include a public HTTPS `webhookUrl`. After the PDF is stored, RenderPDF queues an asynchronous `pdf.completed` POST to that URL. The render response is not delayed by delivery or retries. For a quick test, create a unique endpoint at [Webhook.site](https://webhook.site/) and use it as the URL below.

```json
{
  "html": "<h1>Invoice</h1>",
  "webhookUrl": "https://webhook.site/YOUR-UNIQUE-ID",
  "webhookSecret": "optional-signing-secret"
}
```

When `webhookSecret` is supplied, deliveries include `X-RenderPDF-Signature` as `t=<unix-seconds>,v1=<hex-hmac-sha256>`, calculated from `<timestamp>.<raw JSON body>`. Deliveries that do not return a 2xx status are retried up to four times, then moved to the webhook dead-letter queue. Trial requests cannot use webhooks.

## Architecture

- **Lambda**: Go function with chromedp for headless Chrome PDF generation
- **API Gateway**: REST API endpoint with custom authorizer
- **S3**: Secure PDF storage with lifecycle policies
- **DynamoDB**: Request tracking, usage analytics, and API key storage
- **Cognito**: User authentication with Google OAuth
- **CloudFront**: CDN for landing page and dashboard

## Configuration

Environment variables:
- `S3_BUCKET`: Target S3 bucket for PDF storage
- `DYNAMODB_TABLE`: DynamoDB table for tracking
- `API_KEYS_TABLE`: DynamoDB table for API keys
- `PDF_EXPIRY`: Presigned URL expiration time (default: 3600s)

## Domains

- Landing: https://renderpdf.vberkoz.com/
- Dashboard: https://renderpdf.vberkoz.com/app/
- API: https://renderpdf.vberkoz.com/api/v1/
- Docs: https://renderpdf.vberkoz.com/docs/api

## License

MIT
