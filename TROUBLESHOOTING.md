# RenderPDF Dashboard Authentication & CORS Issues

## Project Description

RenderPDF is a serverless HTML-to-PDF conversion service built on AWS. It provides:
- **PDF Generation API**: Convert HTML to PDF using headless Chrome (chromedp) in AWS Lambda
- **Google OAuth Authentication**: User authentication via AWS Cognito
- **API Key Management**: Dashboard for generating and managing API keys
- **Serverless Architecture**: Lambda, API Gateway, S3, DynamoDB, CloudFront

**Domains:**
- Landing: https://renderpdf.vberkoz.com
- Dashboard: https://dashboard.renderpdf.vberkoz.com
- API: https://api.renderpdf.vberkoz.com

---

## Issues Encountered & Solutions

### Issue 1: CloudFront Access Denied (403)

**Problem:** OAuth callback URL returned Access Denied error from S3.

**Root Cause:** CloudFront was configured to use S3 bucket endpoint instead of S3 website endpoint.

**Solution:** Updated CloudFront origin configuration to use S3 website endpoint with CustomOriginConfig.

```yaml
# Before (incorrect)
Origins:
  - Id: S3Origin
    DomainName: !GetAtt DashboardBucket.DomainName
    S3OriginConfig:
      OriginAccessIdentity: ''

# After (correct)
Origins:
  - Id: S3Origin
    DomainName: !Sub '${DashboardBucket}.s3-website-${AWS::Region}.amazonaws.com'
    CustomOriginConfig:
      HTTPPort: 80
      OriginProtocolPolicy: http-only
```

---

### Issue 2: File Download Instead of Display

**Problem:** `/auth/callback` file was downloading instead of rendering in browser.

**Root Cause:** Missing Content-Type header on S3 object.

**Solution:** Upload file with explicit `Content-Type: text/html` header.

```bash
aws s3 cp dashboard/auth/callback \
  s3://renderpdf-dashboard-653268860643/auth/callback.html \
  --content-type "text/html" \
  --cache-control "no-cache"
```

---

### Issue 3: OAuth Invalid Request Error

**Problem:** Authentication failed with error: `invalid_request - user.email: Attribute cannot be updated`

**Root Cause:** Cognito user was created with immutable email attribute, and Google OAuth tried to update it on subsequent logins.

**Solution:** Delete existing user to allow recreation with correct attributes.

```bash
# List users
aws cognito-idp list-users \
  --user-pool-id us-east-1_kW5g1rpG7 \
  --region us-east-1

# Delete problematic user
aws cognito-idp admin-delete-user \
  --user-pool-id us-east-1_kW5g1rpG7 \
  --username "Google_104021551932951878869" \
  --region us-east-1
```

---

### Issue 4: Failed to Fetch API Keys

**Problem:** Dashboard showed error: "Failed to load keys: Failed to fetch"

**Root Cause:** Two issues:
1. API Gateway endpoints used AWS_IAM authorization instead of Cognito User Pool tokens
2. Missing CORS headers on `/api-keys` endpoints

**Solution:** 

**A. Changed Authorization to Cognito User Pools:**

```yaml
CognitoAuthorizer:
  Type: AWS::ApiGateway::Authorizer
  Properties:
    Name: !Sub '${AppName}-cognito-authorizer'
    Type: COGNITO_USER_POOLS
    IdentitySource: method.request.header.Authorization
    RestApiId: !Ref RestApi
    ProviderARNs:
      - !GetAtt UserPool.Arn

ApiKeysGetMethod:
  Type: AWS::ApiGateway::Method
  Properties:
    RestApiId: !Ref RestApi
    ResourceId: !Ref ApiKeysResource
    HttpMethod: GET
    AuthorizationType: COGNITO_USER_POOLS  # Changed from AWS_IAM
    AuthorizerId: !Ref CognitoAuthorizer
```

**B. Added CORS Support:**

```yaml
ApiKeysOptionsMethod:
  Type: AWS::ApiGateway::Method
  Properties:
    RestApiId: !Ref RestApi
    ResourceId: !Ref ApiKeysResource
    HttpMethod: OPTIONS
    AuthorizationType: NONE
    Integration:
      Type: MOCK
      IntegrationResponses:
        - StatusCode: 200
          ResponseParameters:
            method.response.header.Access-Control-Allow-Headers: "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'"
            method.response.header.Access-Control-Allow-Methods: "'GET,POST,OPTIONS'"
            method.response.header.Access-Control-Allow-Origin: "'*'"
          ResponseTemplates:
            application/json: ''
      RequestTemplates:
        application/json: '{"statusCode": 200}'
    MethodResponses:
      - StatusCode: 200
        ResponseParameters:
          method.response.header.Access-Control-Allow-Headers: true
          method.response.header.Access-Control-Allow-Methods: true
          method.response.header.Access-Control-Allow-Origin: true
```

---

## Key Learnings

1. **S3 Website Hosting with CloudFront**: Use S3 website endpoint with CustomOriginConfig, not S3OriginConfig
2. **Content-Type Matters**: Always set explicit Content-Type headers when uploading HTML files to S3
3. **Cognito User Attributes**: Email attribute immutability can cause OAuth update failures
4. **API Gateway Authorization**: Match authorization type with client authentication method (Cognito tokens vs AWS IAM)
5. **CORS is Critical**: Always add CORS support for cross-origin API calls from browser applications

---

## Architecture Overview

```
User Browser
    ↓
CloudFront (dashboard.renderpdf.vberkoz.com)
    ↓
S3 Static Website (Dashboard SPA)
    ↓
Cognito User Pool (Google OAuth)
    ↓
API Gateway (api.renderpdf.vberkoz.com)
    ↓
Lambda Authorizer (API key validation)
    ↓
Lambda Functions (PDF generation, API key management)
    ↓
DynamoDB (API keys, usage tracking)
S3 (Generated PDFs)
```

---

## Final Configuration

**Cognito User Pool:**
- User Pool ID: `us-east-1_kW5g1rpG7`
- Client ID: `756oip5460mrcai5kptbune4b5`
- OAuth Flow: Implicit grant
- Callback URL: `https://dashboard.renderpdf.vberkoz.com/auth/callback.html`

**API Gateway:**
- Custom authorizer for `/generate` (API key validation)
- Cognito authorizer for `/api-keys` (user authentication)
- CORS enabled on all endpoints

**Lambda Functions:**
- `renderpdf-generate`: PDF generation (2048MB, 60s)
- `renderpdf-authorizer`: API key validation (256MB, 10s)
- `renderpdf-apikeys`: API key CRUD (256MB, 10s)
