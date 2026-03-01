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

## Usage

### Generate PDF from HTML

```bash
curl -X POST https://api.renderpdf.vberkoz.com/generate \
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

- Landing: https://renderpdf.vberkoz.com
- Dashboard: https://dashboard.renderpdf.vberkoz.com
- API: https://api.renderpdf.vberkoz.com

## License

MIT
