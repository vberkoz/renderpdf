# HTML to PDF Service

Serverless API that converts HTML to PDF using AWS Lambda (Go), API Gateway, S3, and DynamoDB.

## Features

- Fast PDF generation using headless Chrome (chromedp)
- Serverless architecture with automatic scaling
- Secure PDF storage with presigned S3 URLs
- Usage tracking and analytics via DynamoDB
- RESTful API with JSON responses

## Prerequisites

- AWS CLI configured with appropriate credentials
- Go 1.21+
- Terraform (optional, if using IaC)

## Deploy

```bash
./deploy.sh
```

## Usage

### Generate PDF from HTML

```bash
curl -X POST https://YOUR_API_URL/generate \
  -H "Content-Type: application/json" \
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
- **API Gateway**: REST API endpoint with CORS support
- **S3**: Secure PDF storage with lifecycle policies
- **DynamoDB**: Request tracking and usage analytics

## Configuration

Environment variables:
- `S3_BUCKET`: Target S3 bucket for PDF storage
- `DYNAMODB_TABLE`: DynamoDB table for tracking
- `PDF_EXPIRY`: Presigned URL expiration time (default: 3600s)

## License

MIT
