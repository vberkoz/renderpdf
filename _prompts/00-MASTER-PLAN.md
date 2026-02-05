# MASTER PLAN & ARCHITECTURE
**Project:** HTML to PDF Service  
**Goal:** Feature-as-a-Service API that converts HTML to PDF using serverless AWS infrastructure.

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

## Deployment
Single script (`deploy.sh`) handles build, package, and CloudFormation stack update.

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
