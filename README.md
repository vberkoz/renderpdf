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
curl -X POST https://renderpdf.vberkoz.com/api/v1/trial/generate \
  -H "Content-Type: application/json" \
  -d '{"html":"<h1>Hello World</h1>"}'
```

For authenticated usage, create an API key in the dashboard:

```bash
curl -X POST https://renderpdf.vberkoz.com/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"html":"<h1>Hello World</h1>"}'
```

### Response

```json
{
  "requestId": "uuid",
  "url": "https://bucket.s3.amazonaws.com/uuid.pdf",
  "size": 12345
}
```

The presigned URL is valid for 1 hour and allows direct download of the generated PDF.

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
