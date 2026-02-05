# MASTER PLAN & ARCHITECTURE (IDEMPOTENT)
**Project:** HTML to PDF Service  
**Goal:** Feature-as-a-Service API that converts HTML to PDF using serverless AWS infrastructure.

**AI Context:** AWS serverless patterns, system architecture design, authentication flows
**Focus:** High-level design decisions, not implementation details

## Reasoning
This is a Feature-as-a-Service (FaaS) requiring:
- **Scalability**: Serverless handles variable load automatically
- **Cost efficiency**: Pay-per-use model for PDF generation
- **Security**: API key authentication prevents abuse
- **Reliability**: Stateless design enables horizontal scaling

Architecture decisions:
- Lambda over EC2: No server management, automatic scaling
- chromedp over wkhtmltopdf: Better CSS/JS support for modern HTML
- S3 over database storage: Cost-effective for large PDF files
- DynamoDB over RDS: Serverless-native, faster cold starts
- Cognito over custom auth: Managed OAuth, reduced complexity

## Execution Strategy
**IDEMPOTENT**: Detect existing state → Fill gaps → Verify functionality

### State Detection
- Check CloudFormation stack exists
- Verify Lambda function deployed
- Validate API Gateway endpoints
- Confirm S3 bucket and DynamoDB table
- Test authentication flow

### Gap Filling
- Create missing infrastructure components
- Deploy missing Lambda functions
- Add missing environment variables
- Update outdated configurations
- Fix broken integrations

### Verification
- Test PDF generation endpoint
- Validate authentication flow
- Confirm S3 storage working
- Check DynamoDB logging
- Verify dashboard functionality

## Tech Stack (Strict)
* **Language:** Go
* **Runtime:** AWS Lambda
* **API:** API Gateway (REST)
* **Storage:** S3 (PDF files + dashboard hosting)
* **Database:** DynamoDB (usage tracking + API keys)
* **PDF Engine:** chromedp (headless Chrome)
* **IaC:** CloudFormation
* **Auth:** AWS Cognito with Google OAuth (implicit grant flow)
* **Frontend:** HTML, CSS, JavaScript (vanilla)

## Architecture Rules
1. Lambda function must be stateless and handle concurrent requests.
2. All PDFs stored in S3 with UUID-based naming.
3. DynamoDB tracks: requestId, timestamp, size, status.
4. API responses follow: `{ "requestId": "uuid", "url": "s3-url", "size": bytes }`.
5. Error responses: `{ "error": "message" }`.
6. API requires authentication via API key (x-api-key header).
7. Users authenticate via Google OAuth through Cognito (implicit grant).
8. Dashboard allows users to generate and manage API keys.
9. Single table design for DynamoDB (PK/SK pattern).

## Deployment (Idempotent)
`deploy.sh` detects current state and applies only necessary changes:
- Skip build if code unchanged
- Update only modified CloudFormation resources
- Preserve existing data and configurations

## Authentication Flow (FuelSync Pattern)
1. User clicks "Sign in with Google" on login page
2. Redirects to Cognito hosted UI with `response_type=token` (implicit grant)
3. Cognito redirects to Google OAuth
4. After Google auth, Cognito redirects to callback URL with tokens in hash fragment
5. Callback page parses tokens from URL hash (`#id_token=...&access_token=...`)
6. Tokens stored in localStorage
7. Dashboard loads with user authenticated
8. User generates API key (requires id_token in Authorization header)
9. API key used in x-api-key header for PDF generation
10. Lambda authorizer validates API key on each request
